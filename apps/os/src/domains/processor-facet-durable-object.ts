/**
 * The OS worker's concrete {@link ProcessorFacetBase} subclass — ALL
 * first-party processor hosting in one class, placed as facets of the Stream
 * Durable Object (tasks/stream-processors-as-facets.md,
 * docs/stream-subscription-model-redesign.md).
 *
 * The Stream DO creates one facet PER SUBSCRIPTION NAME
 * (`ctx.facets.get(name, …)` in stream-durable-object.ts) and looks the class
 * up as the worker export named EXACTLY "ProcessorFacet" — worker.ts exports
 * this class under that name. A facet's identity is `(parentName, projectId,
 * path)`; the facet name itself is not part of the identity, so this class
 * registers the stream path's complete processor composition (mirroring what
 * the retired hosting Durable Objects registered) and the registry routes each
 * wake to the runner matching the subscription name. Runners other than the
 * facet's own name stay cold — registered for routing and reads, never driven,
 * so no effect ever runs twice across sibling facets.
 *
 * Each dependency-construction block below is the verbatim port of the hosting
 * DO it replaces (agent-durable-object.ts, capability-host-durable-object.ts,
 * project/device/secret/repo/workspace DOs, agent-collection-durable-object.ts);
 * where a dep needs the host DO's private storage or serialization (repo git
 * authority, device credential updates), it dials a door on that domain DO
 * instead. The scheduler and sandbox processors deliberately stay hosted in
 * their own Durable Objects (domain-alarm entanglement; Containers SDK).
 */
import { disposeIgnoredRpcResult } from "iterate/sdk/capnweb";
import type { ProcessorStream } from "iterate/processors";
import {
  FACET_IDENTITY_KEY,
  ProcessorFacet as ProcessorFacetBase,
  type ProcessorFacetAlarmProxy,
  type ProcessorFacetHost,
  type ProcessorFacetIdentity,
  type StreamProcessorRegistry,
} from "iterate/processors/cloudflare";
import { trustedInternalAuthContext } from "../auth.ts";
import { parseConfig } from "../config.ts";
import { workerVersion, type Env } from "../env.ts";
import { itxForScope, StreamRpcTarget } from "../rpc-targets.ts";
import { readProjectById } from "../project-directory.ts";
import { facetProcessorFamilyForPath } from "./processor-facet-families.ts";
import type { CapabilityDescription } from "./itx/describe.ts";
import { DurableObjectNameCodec } from "./durable-object-names.ts";
import { AgentProcessor } from "./agents/agent-processor-implementation.ts";
import { HeadlessAgentProcessor } from "./agents/agent-headless-processor.ts";
import {
  type AgentFileAttachment,
  type AgentLiveState,
  type AgentRuntimeTransition,
} from "./agents/agent-processor-contract.ts";
import { AgentCollectionStreamProcessor } from "./agents/agent-collection-processor-implementation.ts";
import {
  CapabilityHostProcessor,
  type CapabilityHostProcessorReads,
} from "./capability-host/capability-host-processor-implementation.ts";
import type { CapabilityProvidedPayload, CapabilityRecord } from "./capability-host/types.ts";
import type { ScriptExecutionSettlement } from "./capability-host/script-execution-settlement.ts";
import {
  checkCapabilityTypes,
  checkItxScriptForExecution,
  checkPreamble,
} from "./typecheck/virtual-project.ts";
import { DeviceProcessor } from "./devices/device-processor-implementation.ts";
import { getExpoPushReceipt, sendExpoPushNotification } from "./devices/expo-push-client.ts";
import type { DevicePushSender } from "./devices/device-processor-implementation.ts";
import { deviceIdFromPath } from "./devices/device-durable-object.ts";
import { EmailProcessor } from "./email/email-processor-implementation.ts";
import { EmailAgentProcessor } from "./email/email-agent-processor-implementation.ts";
import { SlackProcessor } from "./integrations/slack-processor-implementation.ts";
import {
  eyesReactionTargetFromWebhookPayload,
  SlackAgentProcessor,
} from "./integrations/slack-agent-processor-implementation.ts";
import { callProjectSlackWebApi, storeSlackFilesForAgent } from "./integrations/slack-api.ts";
import { TelegramProcessor } from "./integrations/telegram-processor-implementation.ts";
import { TelegramAgentProcessor } from "./integrations/telegram-agent-processor-implementation.ts";
import { callProjectTelegramBotApi } from "./integrations/telegram-api.ts";
import { buildTelegramAccessSettingsUrl } from "./integrations/utils.ts";
import { NotificationProcessor } from "./notifications/notification-processor-implementation.ts";
import { ChatReplyNotifyProcessor } from "./notifications/chat-reply-notify-implementation.ts";
import { ProjectProcessor } from "./projects/project-processor-implementation.ts";
import { createCloudflareProjectCustomDomainDeps } from "./projects/custom-domains.ts";
import { RepoProcessor } from "./repos/repo-processor-implementation.ts";
import { defaultProjectWorkerRef } from "./repos/utils.ts";
import { SecretProcessor } from "./secrets/secret-processor-implementation.ts";
import { describeSecretState } from "./secrets/secret-durable-object.ts";
import { describeDeviceState } from "./devices/device-durable-object.ts";
import { WorkspaceProcessor } from "./workspaces/workspace-processor-implementation.ts";
import { mintProjectFileUrl, MODEL_FILE_URL_TTL_SECONDS } from "./files/project-files.ts";
import { agentWorkspacePath } from "./workspaces/utils.ts";
import { DynamicWorkerRunner } from "./workers/worker-runner.ts";

const EXPO_PUSH_SEND_TIMEOUT_MS = 15_000;

/**
 * The Stream DO stub surface the facet dials back to its parent for
 * platform-event appends and cross-facet presentation forwards.
 */
type ParentStreamStub = ProcessorFacetAlarmProxy & {
  appendCoreEventsIfStreamId(args: { streamId: string; events: unknown[] }): Promise<unknown>;
  /** The parent-held Capability Provider Pager runtime: acquire a live
   * mount's provider for one invocation burst (Page → lent RPC leg → invoke). */
  invokeLiveCapability(args: {
    args: unknown[];
    path: string[];
    record: Extract<CapabilityRecord, { type: "live" }>;
  }): Promise<unknown>;
  presentAgentRuntimeTransition(args: { transition: AgentRuntimeTransition }): Promise<unknown>;
};

// The run-script worker load happens in a stateless loopback entrypoint, not
// in this facet. Keep the handle type shallow (ported from the retired
// capability-host DO) to avoid deep-instantiating the generated `ctx.exports`
// WorkerEntrypoint type through the facet's processor field.
type ScriptExecutionEntrypointHandle = {
  run(
    code: string,
    options: { emittedJs?: string; expiresAt: number; preambleJs?: string },
  ): Promise<ScriptExecutionSettlement>;
};

type ScriptExecutionLoopbackExports = {
  ScriptExecutionEntrypoint(input: {
    props: {
      projectId: string;
      scopePath: string;
    };
  }): ScriptExecutionEntrypointHandle;
};

export class ProcessorFacet extends ProcessorFacetBase<Env> {
  /** The registry built by the base host — captured for the catchUp/alarm doors. */
  #registry: StreamProcessorRegistry | undefined;
  /** The capability-host processor instance, when this path is project-scoped. */
  #capabilityHostProcessor: CapabilityHostProcessor | undefined;
  /** Per-family live-state projection; undefined = primary runner's fold. */
  #getLiveState: (() => Record<string, unknown>) | undefined;
  /** Extra per-family domain alarm work replayed after the runners' keepalives. */
  #domainAlarm: (() => Promise<void>) | undefined;
  /** Slack presentation: the latest agent runtime transition pushed from the
   * sibling "agent" facet through the parent (in-memory; re-primed by the next
   * transition after an eviction). */
  #latestAgentRuntimeTransition: AgentRuntimeTransition | undefined;
  /** Present a pushed transition against the DRIVEN slack-agent runner state. */
  #presentPushedAgentRuntimeTransition: ((transition: AgentRuntimeTransition) => void) | undefined;

  protected parentAlarms(identity: ProcessorFacetIdentity): ProcessorFacetAlarmProxy {
    return this.#parentStub(identity);
  }

  #parentStub(identity: ProcessorFacetIdentity): ParentStreamStub {
    // Safe: the parent is always a StreamDurableObject — facets are only ever
    // created by StreamDurableObject.#dialProcessorFacet, which configures
    // them with its own ctx.id.name as parentName — and ParentStreamStub
    // hand-declares the plain subset of that RPC surface the facet dials
    // back. The cast swaps out the generated DurableObjectStub type: its
    // Rpc-mapped signatures don't match plain method declarations, and
    // keeping the full stub type here would deep-instantiate the Stream DO's
    // surface through this facet's fields.
    return this.env.STREAM.getByName(identity.parentName) as unknown as ParentStreamStub;
  }

  protected createHost(identity: ProcessorFacetIdentity): ProcessorFacetHost {
    const stream = new StreamRpcTarget({
      auth: trustedInternalAuthContext(),
      path: identity.path,
      projectId: identity.projectId,
    });
    return {
      stream,
      version: workerVersion(this.env),
      // Per-family projection when one exists (agent/secret/device/collection);
      // otherwise mirror the registry's own default — the primary
      // (first-registered) runner's committed fold.
      getLiveState: () => {
        if (this.#getLiveState !== undefined) return this.#getLiveState();
        const registry = this.#registry;
        const primary = registry?.names[0];
        if (registry === undefined || primary === undefined) return {};
        // Safe: every registered contract's stateSchema is a z.object, so a
        // committed fold is always a plain JSON object; the by-name registry
        // read erases the per-contract state type, and Record<string, unknown>
        // is the honest wide view the live-state door publishes.
        return (registry.reads(primary).currentState ?? {}) as Record<string, unknown>;
      },
      registerProcessors: (registry) => {
        this.#registry = registry;
        this.#registerProcessors(identity, stream, registry);
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Doors beyond the base class's RPC surface (parent-only callers).
  // ---------------------------------------------------------------------------

  // Capability-host domain doors, dispatched by identity: the retired
  // CapabilityHostDurableObject forwarded these methods onto its processor
  // instance; they live here now. Only meaningful on the facet named
  // "capability-host" (the driven runner) — the facade dials that one. The
  // Pager-coupled callers (the parent's Capability Provider Pager wiring)
  // pass `afterAppend` callbacks that flow in as ordinary argument
  // capabilities, exactly like the liveState door's subscriber callback.
  invokeCapability(input: { args?: unknown[]; path: string[] }): Promise<unknown> {
    return this.#requireCapabilityHost().invokeCapability(input);
  }

  provideCapability(
    input: CapabilityProvidedPayload,
    options?: { afterAppend?(record: CapabilityRecord): void | Promise<void> },
  ): Promise<{ path: string[]; providedAtOffset: number }> {
    return this.#requireCapabilityHost().provideCapability(input, options);
  }

  revokeCapability(input: { path: string[]; providedAtOffset?: number }): Promise<void> {
    return this.#requireCapabilityHost().revokeCapability(input);
  }

  describeCapabilities(): Promise<CapabilityDescription[]> {
    return this.#requireCapabilityHost().describeCapabilities();
  }

  /** Append this scope's `capability-provider-pager-connected` fact; the
   * parent's `afterAppend` binds the physical Pager to the committed offset. */
  connectCapabilityProviderPager(options: {
    afterAppend(connectedAtOffset: number): void | Promise<void>;
  }): Promise<number> {
    return this.#requireCapabilityHost().connectCapabilityProviderPager(options);
  }

  /** Journal one Pager's departure; reduction retires every mount it owned. */
  disconnectCapabilityProviderPager(args: { connectedAtOffset: number }): Promise<void> {
    return this.#requireCapabilityHost().disconnectCapabilityProviderPager(args.connectedAtOffset);
  }

  // Preamble doors: mutation serialization lives with the parent's capability
  // wiring (the set-time compile snapshots state, awaits an expensive check,
  // then appends — concurrent sets must not validate against the same
  // snapshot); these forwards are the processor verbs themselves.
  setPreamble(input: { code: string; key: string }): Promise<void> {
    return this.#requireCapabilityHost().setPreamble(input);
  }

  removePreamble(input: { key: string }): Promise<void> {
    return this.#requireCapabilityHost().removePreamble(input);
  }

  describePreamble(): Promise<{ text: string; entries: { key: string; code: string }[] } | null> {
    return this.#requireCapabilityHost().describePreamble();
  }

  getScriptResult(executionId: string): Promise<{ executionId: string; data: unknown }> {
    return this.#requireCapabilityHost().getScriptResult(executionId);
  }

  /**
   * Cross-facet presentation push: the "agent" facet observed a committed
   * agent runtime transition and the parent forwarded it here (the
   * "slack-agent" facet), where the DRIVEN slack-agent runner state lives.
   * Replaces the retired agent DO's in-process `present()` wiring.
   */
  presentAgentRuntimeTransition(args: { transition: AgentRuntimeTransition }): void {
    this.#latestAgentRuntimeTransition = args.transition;
    this.#presentPushedAgentRuntimeTransition?.(args.transition);
  }

  /** The base replays parent alarm fires into the runners' keepalives; the
   * device family adds its receipt/approval-grace domain alarm on top. */
  override async handleAlarm(info?: AlarmInvocationInfo): Promise<void> {
    await super.handleAlarm(info);
    await this.#domainAlarm?.();
  }

  #requireRegistry(): StreamProcessorRegistry {
    if (this.#registry === undefined) {
      // A fresh incarnation may serve one of THIS subclass's doors before the
      // base's boot microtask has rebuilt the host. Re-run the idempotent
      // first-contact path from the stashed identity ourselves.
      const identity = this.ctx.storage.kv.get<ProcessorFacetIdentity>(FACET_IDENTITY_KEY);
      if (identity !== undefined) this.configure(identity);
    }
    const registry = this.#registry;
    if (registry === undefined) {
      throw new Error("ProcessorFacet has no registry yet — call configure() first");
    }
    return registry;
  }

  #requireCapabilityHost(): CapabilityHostProcessor {
    // Touch the host first so a fresh incarnation (re)builds its composition.
    this.#requireRegistry();
    const processor = this.#capabilityHostProcessor;
    if (processor === undefined) {
      throw new Error("this stream's facet composition hosts no capability-host processor");
    }
    return processor;
  }

  // ---------------------------------------------------------------------------
  // The composition: which processors run at which stream path, with each
  // dep-construction block ported verbatim from the DO that hosted it.
  // ---------------------------------------------------------------------------

  #registerProcessors(
    identity: ProcessorFacetIdentity,
    stream: ProcessorStream,
    registry: StreamProcessorRegistry,
  ): void {
    const { projectId } = identity;
    // The path→family selection is the extracted pure function so creation
    // doors (repos.create at a claimed path) can refuse a path this
    // composition would hand to another family — see
    // processor-facet-families.ts. Repos are the ELSE arm, not a "/repos/"
    // family: repos.get accepts any path (the examples create repos under
    // /examples/**), exactly as the retired Repo Durable Object existed at
    // every {projectId, path}.
    switch (facetProcessorFamilyForPath({ path: identity.path, projectId })) {
      case "project-root":
        this.#registerProjectRoot(identity, stream, registry);
        break;
      case "agent-collection":
        this.#registerAgentCollection(identity, stream, registry);
        break;
      case "agent":
        this.#registerAgent(identity, stream, registry);
        break;
      case "email-router":
        this.#registerEmailRouter(identity, stream, registry);
        break;
      case "slack-router":
        this.#registerSlackRouter(identity, stream, registry);
        break;
      case "telegram-router":
        this.#registerTelegramRouter(identity, stream, registry);
        break;
      case "device":
        this.#registerDevice(identity, stream, registry);
        break;
      case "secret":
        this.#registerSecret(identity, stream, registry);
        break;
      case "workspace":
        this.#registerWorkspace(identity, stream, registry);
        break;
      case "repo":
        this.#registerRepo(identity, stream, registry);
        break;
    }
    // Deployment-global streams host only repos; every project-scoped stream
    // can additionally be a capability scope ("/" is the project root, agent
    // paths are agent scopes) — the capability-host processor is registered
    // everywhere, exactly as its Durable Object existed at every
    // {projectId, path}.
    if (projectId === null) return;
    this.#registerCapabilityHost(identity, stream, registry);
  }

  /** The retired CapabilityHostDurableObject's wiring, per scope path. */
  #registerCapabilityHost(
    identity: ProcessorFacetIdentity,
    stream: ProcessorStream,
    registry: StreamProcessorRegistry,
  ): void {
    const { path } = identity;
    const projectId = identity.projectId!;
    let reads: CapabilityHostProcessorReads | undefined;
    const requireReads = (): CapabilityHostProcessorReads => {
      if (reads === undefined) throw new Error("capability-host reads are not wired yet");
      return reads;
    };
    // Registered WITH recovery: script executions are consequential
    // `runInBackground` work (stream-committed requested/started obligations
    // whose OUTCOME matters), so an incarnation that dies owing one must be
    // revived — the keepalive alarm appends the `stream/processor-revived`
    // fact, whose wake produces the eventless at-head pass that re-drives the
    // obligations (see the registry module doc's recovery rule).
    const processor = registry.register(
      new CapabilityHostProcessor({
        stream,
        path,
        projectId,
        itx: itxForScope({
          auth: trustedInternalAuthContext(),
          ctx: this.ctx,
          streamContext: { kind: "scope", scopePath: path },
          path,
          projectId,
        }),
        reads: {
          snapshot: () => requireReads().snapshot(),
          waitUntilEvent: (input) => requireReads().waitUntilEvent(input),
        },
        // Live providers hibernate behind the PARENT-held Capability Provider
        // Pager (the sockets and lent RPC legs are runtime state and facets
        // hold no hibernatable sockets), so acquisition dials back to the
        // parent Stream DO.
        invokeLiveCapability: (record, capabilityPath, args) =>
          this.#parentStub(identity).invokeLiveCapability({
            args,
            path: capabilityPath,
            record,
          }),
        scriptExecutionEntrypoint: this.#scriptExecutionEntrypoint(identity),
        validateCapabilityTypes: (types) =>
          checkCapabilityTypes({ types, typechecker: this.env.TYPECHECKER }),
        typecheckScript: (input) =>
          checkItxScriptForExecution({ ...input, typechecker: this.env.TYPECHECKER }),
        checkPreamble: (input) => checkPreamble({ ...input, typechecker: this.env.TYPECHECKER }),
      }),
      { recovery: true },
    );
    const registryReads = registry.reads(processor);
    reads = {
      snapshot: () => registryReads.snapshot(),
      waitUntilEvent: (input) => registryReads.waitUntilEvent(input),
    };
    this.#capabilityHostProcessor = processor;
  }

  #scriptExecutionEntrypoint(identity: ProcessorFacetIdentity): ScriptExecutionEntrypointHandle {
    // Safe: this worker exports ScriptExecutionEntrypoint (see worker.ts), so
    // ctx.exports always carries a loopback constructor for it with exactly
    // this props/run surface. The shallow hand-written view replaces the
    // generated ctx.exports type on purpose — see the
    // ScriptExecutionEntrypointHandle comment above for why the deep
    // instantiation cannot be used here.
    const exports = this.ctx.exports as unknown as ScriptExecutionLoopbackExports;
    return exports.ScriptExecutionEntrypoint({
      props: { projectId: identity.projectId!, scopePath: identity.path },
    });
  }

  /** The retired ProjectDurableObject's hosting wiring (project + notification). */
  #registerProjectRoot(
    identity: ProcessorFacetIdentity,
    stream: ProcessorStream,
    registry: StreamProcessorRegistry,
  ): void {
    const { path } = identity;
    const projectId = identity.projectId!;
    // NO recovery on either, on purpose (parity with the retired host wiring):
    // neither overrides `reconcile`, so no post-eviction pass would have work
    // to settle. Their consequential side effects all run under
    // `blockProcessorWhile`, which holds the frame — a death mid-work leaves
    // the cursor behind and the source stream calls their batch callback
    // again.
    registry.register(
      new ProjectProcessor({
        stream,
        path,
        projectId,
        customDomains: createCloudflareProjectCustomDomainDeps({
          env: this.env,
          projectId,
        }),
        itx: itxForScope({
          auth: trustedInternalAuthContext(),
          ctx: this.ctx,
          streamContext: { kind: "scope", scopePath: "/" },
          path: "/",
          projectId,
        }),
        workerFetch: (request) =>
          new DynamicWorkerRunner({
            streamContext: { kind: "scope", scopePath: "/" },
            exports: this.ctx.exports,
            loaderScope: "shared",
            projectId,
            scopePath: "/",
          }).fetch({
            ref: defaultProjectWorkerRef(),
            request,
            traceRole: "project_config",
          }),
        appendPlatformEvents: async ({ events, streamId }) => {
          // The facet's colocated platform-append lane: dial the PARENT
          // Stream DO directly (the facet's host stream IS the parent).
          disposeIgnoredRpcResult(
            await this.#parentStub(identity).appendCoreEventsIfStreamId({ events, streamId }),
          );
        },
      }),
    );
    registry.register(
      new NotificationProcessor({
        stream,
        path,
        projectId,
      }),
    );
  }

  /** The retired AgentCollectionDurableObject's wiring. */
  #registerAgentCollection(
    identity: ProcessorFacetIdentity,
    stream: ProcessorStream,
    registry: StreamProcessorRegistry,
  ): void {
    const processor = registry.register(
      new AgentCollectionStreamProcessor({
        stream,
        path: identity.path,
        projectId: identity.projectId!,
      }),
    );
    const reads = registry.reads(processor);
    this.#getLiveState = () => reads.currentState;
  }

  /** The retired AgentDurableObject's wiring: four processors, all with
   * recovery — see each block's comment in the original file for the why. */
  #registerAgent(
    identity: ProcessorFacetIdentity,
    stream: ProcessorStream,
    registry: StreamProcessorRegistry,
  ): void {
    const { path } = identity;
    const projectId = identity.projectId!;
    // Registered on every agent family; it only wakes on plain chat threads
    // where the generic agents.create batch configured its subscription. Its
    // one side effect — the chat-reply push intent on the project root — is a
    // per-event `blockProcessorWhile` append (delivered-once, idempotency
    // keyed), so no recovery registration: there is no `runInBackground` work
    // whose loss an eviction could strand. (Ported from #2422's agent DO.)
    registry.register(
      new ChatReplyNotifyProcessor({
        stream,
        path,
        projectId,
      }),
    );
    // Constructor args shared by the classic and headless agent processors —
    // one stream, one deps recipe, two compositions.
    const agentArgs = {
      stream,
      path,
      projectId,
      ai: this.env.AI,
      // Resolved per attempt (not at construction) so a config problem
      // fails the turn with a journaled error instead of bricking the host.
      // The OpenAI prompt_cache_key is per agent stream: repeated turns
      // grow a shared prefix, and a stable key routes them to the same
      // provider-side prompt-cache shard.
      cloudflareAiGatewayTransport: () => {
        const gateway = parseConfig(this.env).cloudflareAiGateway;
        if (gateway.transport === "unified") return { kind: "unified" as const };
        return {
          kind: "byok" as const,
          gatewayId: gateway.id,
          openaiApiKey: parseConfig(this.env).openAiApiKey.exposeSecret(),
          openaiPromptCacheKey: `${projectId}:${path}`,
          responseCacheTtlSeconds: gateway.responseCacheTtlSeconds,
        };
      },
      resolveModelFileUrl: (file: AgentFileAttachment) =>
        mintProjectFileUrl({
          config: parseConfig(this.env),
          expiresInSeconds: MODEL_FILE_URL_TTL_SECONDS,
          path: file.path,
          projectId,
        }),
      // Oversized script results spill into the agent's OWN workspace
      // directory (private scratch under its stream path — never
      // committable), so the model can page through the file instead of
      // blowing its context window.
      writeWorkspaceFile: async ({
        content,
        path: filePath,
      }: {
        content: string;
        path: string;
      }) => {
        const absolutePath = `${agentWorkspacePath(path)}/${filePath}`;
        await this.env.WORKSPACE_V2.getByName(
          DurableObjectNameCodec.stringify({
            path: agentWorkspacePath(path),
            projectId,
          }),
        ).writeFile(absolutePath, content);
        return { absolutePath };
      },
    };
    // Registered WITH recovery: LLM turns are consequential `runInBackground`
    // work (stream-committed requested/started obligations whose OUTCOME
    // matters). An incarnation that dies owing either must be revived.
    const agentProcessor = registry.register(new AgentProcessor(agentArgs), { recovery: true });
    // The headless variant (same wiring minus the codemode component; see
    // agent-headless-processor.ts). Registered on every agent facet host,
    // woken only on streams subscribed to its name — an agent runs under
    // exactly ONE of the two, so shared `agent/` idempotency keys make a
    // handover dedupe instead of double-executing.
    const headlessProcessor = registry.register(new HeadlessAgentProcessor(agentArgs), {
      recovery: true,
    });
    const agentReads = registry.reads(agentProcessor);
    const headlessReads = registry.reads(headlessProcessor);
    this.#getLiveState = (): AgentLiveState => {
      // An agent runs under the classic OR the headless processor. After a
      // handover the retired processor's fold stays FROZEN at its last
      // transition, so precedence must go to the newer stamp — a
      // classic-first fallback would mask every headless update behind the
      // frozen classic fold on opted-in agents.
      const classic = agentReads.currentState.runtimeChange;
      const headless = headlessReads.currentState.runtimeChange;
      const newer =
        classic === undefined
          ? headless
          : headless === undefined || classic.sinceOffset >= headless.sinceOffset
            ? classic
            : headless;
      return { runtimeChange: newer };
    };

    // The Slack presentation processor — see the retired agent DO's block
    // comment. Its cross-processor `present()` wiring is split across sibling
    // facets now: the "agent" facet pushes committed runtime transitions
    // through the parent (below), and this facet presents them against ITS
    // driven slack-agent fold (presentAgentRuntimeTransition door).
    const slackAgentProcessor = registry.register(
      new SlackAgentProcessor({
        stream,
        path,
        projectId,
        callSlackApi: async ({ body, connection, method }) => {
          await callProjectSlackWebApi({
            body,
            connection,
            method,
            projectId,
            streamContext: { kind: "scope", scopePath: path },
          });
        },
        getAgentRuntimeTransition: () => this.#latestAgentRuntimeTransition,
        fetchSlackChannelName: async ({ channel, connection }) => {
          try {
            // Unknown-first structural read of the third-party response:
            // conversations.info answers { channel: { name, ... } } on
            // success, but nothing here trusts that — `name` is only used
            // after the typeof string check below, and any other shape
            // degrades to the null (no enrichment) path.
            const result = (await callProjectSlackWebApi({
              body: { channel },
              connection,
              method: "conversations.info",
              projectId,
              streamContext: { kind: "scope", scopePath: path },
            })) as { channel?: { name?: unknown } };
            const name = result.channel?.name;
            return typeof name === "string" && name.length > 0 ? name : null;
          } catch (error) {
            // The channel id is the binding identity; its human-readable name
            // is optional enrichment. Record the binding without a name when
            // Slack cannot provide it instead of wedging the route forever.
            console.warn("[slack-agent] Slack channel-name enrichment failed", {
              method: "conversations.info",
              path,
              reason: error instanceof Error ? error.message : String(error),
            });
            return null;
          }
        },
        storeSlackFiles: (input) =>
          storeSlackFilesForAgent({
            agentPath: path,
            connection: input.connection,
            files: input.files,
            projectId,
            storageKey: input.storageKey,
          }),
      }),
      { recovery: true },
    );
    const slackAgentReads = registry.reads(slackAgentProcessor);

    // Split `present()` wiring. In the facet whose own name is "agent" the
    // agent runner is the driven one: push each committed transition through
    // the parent to the sibling "slack-agent" facet (the parent no-ops when no
    // slack-agent subscription exists). In the facet whose own name is
    // "slack-agent" the slack runner drives: present the latest pushed
    // transition whenever the slack fold changes.
    registry.observeStateChanges(agentProcessor, () => {
      const transition = agentReads.currentState.runtimeChange;
      if (transition === undefined) return;
      void Promise.resolve(this.#parentStub(identity).presentAgentRuntimeTransition({ transition }))
        .then(disposeIgnoredRpcResult)
        .catch((error: unknown) => {
          console.warn("[agent facet] runtime-transition presentation forward failed", {
            error,
            path,
          });
        });
    });
    this.#presentPushedAgentRuntimeTransition = (transition) => {
      slackAgentProcessor.presentRuntimeTransition(slackAgentReads.currentState, transition);
    };
    registry.observeStateChanges(slackAgentProcessor, () => {
      const transition = this.#latestAgentRuntimeTransition;
      if (transition === undefined) return;
      slackAgentProcessor.presentRuntimeTransition(slackAgentReads.currentState, transition);
    });

    // Telegram: two lanes with opposite failure policies — the typing chat
    // action is best effort, the journaled send THROWS so its obligation
    // holds the checkpoint and retries (see the retired agent DO's comment).
    registry.register(
      new TelegramAgentProcessor({
        stream,
        path,
        projectId,
        callTelegramApi: async ({ body, connection, method }) => {
          try {
            await callProjectTelegramBotApi({
              body,
              connection,
              method,
              projectId,
              streamContext: { kind: "scope", scopePath: path },
            });
          } catch (error) {
            console.error("[telegram-agent] Telegram side effect failed", {
              error,
              method,
              path,
            });
          }
        },
        sendTelegramMessage: async ({ body, connection }) => {
          // The journaled send (telegram/send-requested): deliberately NO
          // catch — a failed delivery must reject the batch, hold the
          // checkpoint, and be retried until the message-sent marker exists.
          const result = await callProjectTelegramBotApi({
            body,
            connection,
            method: "sendMessage",
            projectId,
            streamContext: { kind: "scope", scopePath: path },
          });
          // Unknown-first structural read of the third-party response:
          // Telegram's sendMessage answers { result: { message_id, ... } },
          // but nothing here trusts that — the typeof check below rejects
          // every other shape and fails the batch (held checkpoint, retry).
          const messageId = (result.result as { message_id?: unknown } | undefined)?.message_id;
          if (typeof messageId !== "number") {
            throw new Error("Telegram sendMessage returned no message_id");
          }
          return { messageId };
        },
      }),
      { recovery: true },
    );

    // Email thread transcription — the blocking transcription is an inbound
    // message's ONLY path to the LLM (see the retired agent DO's comment).
    registry.register(
      new EmailAgentProcessor({
        stream,
        path,
        projectId,
        resolveStoredAttachments: async (attachments) => {
          const config = parseConfig(this.env);
          return await Promise.all(
            attachments.map(async (attachment, index) => {
              const url = await mintProjectFileUrl({
                config,
                path: attachment.path,
                projectId,
              });
              return {
                contentType: attachment.mimeType ?? "application/octet-stream",
                filename: attachment.filename ?? `attachment-${index}`,
                path: attachment.path,
                size: attachment.size,
                url,
              };
            }),
          );
        },
      }),
      { recovery: true },
    );
  }

  /** The email router — the retired project DO's `/integrations/email` block. */
  #registerEmailRouter(
    identity: ProcessorFacetIdentity,
    stream: ProcessorStream,
    registry: StreamProcessorRegistry,
  ): void {
    registry.register(
      new EmailProcessor({
        stream,
        path: identity.path,
        projectId: identity.projectId!,
      }),
    );
  }

  /** The Slack webhook router — the retired project DO's per-connection block. */
  #registerSlackRouter(
    identity: ProcessorFacetIdentity,
    stream: ProcessorStream,
    registry: StreamProcessorRegistry,
  ): void {
    const { path } = identity;
    const projectId = identity.projectId!;
    registry.register(
      new SlackProcessor({
        stream,
        path,
        projectId,
        acknowledgeRoutedWebhook: async ({ connection, payload }) => {
          const ack = eyesReactionTargetFromWebhookPayload(payload);
          if (ack == null) return;
          try {
            await callProjectSlackWebApi({
              body: { channel: ack.channel, name: "eyes", timestamp: ack.timestamp },
              connection,
              method: "reactions.add",
              projectId,
              streamContext: { kind: "scope", scopePath: path },
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // The slack-agent processor adds the same reaction once the routed
            // stream catches up; whichever lands second dedups here.
            if (message.includes("already_reacted") || message.includes("not_reactable")) return;
            console.error("[slack] routed-webhook acknowledgement failed", {
              error,
              projectId,
            });
          }
        },
      }),
    );
  }

  /** The Telegram webhook router — the retired project DO's per-connection block. */
  #registerTelegramRouter(
    identity: ProcessorFacetIdentity,
    stream: ProcessorStream,
    registry: StreamProcessorRegistry,
  ): void {
    const { path } = identity;
    const projectId = identity.projectId!;
    registry.register(
      new TelegramProcessor({
        stream,
        path,
        projectId,
        now: Date.now,
        sendTelegramMessage: ({ body, connection }) =>
          callProjectTelegramBotApi({
            body,
            connection,
            method: "sendMessage",
            projectId,
            streamContext: { kind: "scope", scopePath: path },
          }),
        telegramAccessSettingsUrl: async ({ connection, projectId: settingsProjectId }) => {
          const project = await readProjectById(this.env.PROJECT_DIRECTORY, settingsProjectId);
          if (project === null) {
            throw new Error(
              `Telegram access denial cannot link project ${settingsProjectId}: directory record missing`,
            );
          }
          return buildTelegramAccessSettingsUrl({
            baseUrl: parseConfig(this.env).baseUrl || "https://os.iterate.com",
            connection,
            projectSlug: project.slug,
          });
        },
      }),
    );
  }

  /** The retired DeviceDurableObject's hosting wiring, including its
   * receipt/approval-grace domain alarm (replayed via handleAlarm above). */
  #registerDevice(
    identity: ProcessorFacetIdentity,
    stream: ProcessorStream,
    registry: StreamProcessorRegistry,
  ): void {
    const { path } = identity;
    const projectId = identity.projectId!;
    const deviceId = deviceIdFromPath(path);
    const deviceProcessor = registry.register(
      new DeviceProcessor({
        stream,
        path,
        projectId,
        now: Date.now,
        // Credential updates stay serialized on the Device DO (its enroll and
        // revoke ride the same chain), so the facet dials its door instead of
        // clearing the Secret itself.
        clearPushToken: (input) =>
          this.env.DEVICE.getByName(
            DurableObjectNameCodec.stringify({ path, projectId }),
          ).processorClearPushToken(input),
        getReceipt: getExpoPushReceipt,
        repointGraceAlarm: (atMs: number | null) =>
          registry.setAlarmSlice("device-approval-grace", atMs),
        repointReceiptAlarm: (atMs) => registry.setAlarmSlice("device-receipts", atMs),
        sendTimeoutMs: EXPO_PUSH_SEND_TIMEOUT_MS,
        send: async ({
          notification,
          pushTokenSecretPath,
          pushTokenSecretUpdatedOffset,
        }): ReturnType<DevicePushSender> => {
          const state = deviceReads.currentState;
          if (
            state.pushTokenSecret === null ||
            state.pushTokenSecret.path !== pushTokenSecretPath ||
            state.pushTokenSecret.updatedOffset !== pushTokenSecretUpdatedOffset
          ) {
            throw new Error("device push token changed before the attempt began");
          }
          const secret = this.env.SECRET.getByName(
            DurableObjectNameCodec.stringify({ path: pushTokenSecretPath, projectId }),
          );
          return await sendExpoPushNotification(
            { ...notification, pushTokenSecretPath },
            (request) =>
              secret.fetchAtUpdatedOffset(request, {
                expectedUpdatedOffset: pushTokenSecretUpdatedOffset,
              }),
          );
        },
      }),
      { recovery: true },
    );
    const deviceReads = registry.reads(deviceProcessor);
    this.#getLiveState = () => describeDeviceState(deviceReads.currentState, deviceId);
    // The retired device DO's alarm body, minus the registry keepalive leg the
    // base class already replays: run both handlers; each is idempotent and
    // re-derives its own next fire time from the state.
    this.#domainAlarm = async () => {
      try {
        await registry.catchUp(deviceProcessor.contract.slug);
        await deviceProcessor.checkReceipts(deviceReads.currentState);
        await deviceProcessor.releaseGraces(() => deviceReads.currentState);
        await registry.catchUp(deviceProcessor.contract.slug);
      } catch (error) {
        // Cloudflare retries a throwing alarm only a bounded number of times;
        // a prolonged outage must not strand due work with no armed alarm.
        await registry.setAlarmSlice("device-receipts", Date.now() + 60_000);
        await registry.setAlarmSlice("device-approval-grace", Date.now() + 60_000);
        throw error;
      }
    };
  }

  /** The retired SecretDurableObject's hosting wiring (the Secret DO keeps
   * the crypto/egress domain logic and reads back through the facade). */
  #registerSecret(
    identity: ProcessorFacetIdentity,
    stream: ProcessorStream,
    registry: StreamProcessorRegistry,
  ): void {
    // NO recovery on purpose: the processor's only side effect (the
    // secret/created catalog copy) is a blocked per-event append — the cursor
    // holds until it commits, so an eviction just redelivers the event.
    const processor = registry.register(
      new SecretProcessor({
        stream,
        path: identity.path,
        projectId: identity.projectId!,
      }),
    );
    const reads = registry.reads(processor);
    // Secret material is write-only: the live state that leaves this host is
    // the DESCRIPTION (hasMaterial), never the ciphertext.
    this.#getLiveState = () => describeSecretState(reads.currentState);
  }

  /** The retired RepoDurableObject hosting wiring: the git/Artifacts deps
   * stay on the Repo DO (its storage owns the branch-head authority and the
   * write serializer) — the facet dials its processor doors. */
  #registerRepo(
    identity: ProcessorFacetIdentity,
    stream: ProcessorStream,
    registry: StreamProcessorRegistry,
  ): void {
    const { path, projectId } = identity;
    const repoStub = () =>
      this.env.REPO.getByName(
        DurableObjectNameCodec.stringify({ path, projectId }, { allowNullProjectId: true }),
      );
    // Registered WITH recovery: creation and GitHub imports are consequential
    // `runInBackground` work (stream-committed requested/started obligations
    // whose OUTCOME matters).
    registry.register(
      new RepoProcessor({
        stream,
        path,
        projectId,
        createEmptyArtifact: () => repoStub().processorCreateEmptyArtifact(),
        createPublicGithubTemplateArtifact: (input) =>
          repoStub().processorCreatePublicGithubTemplateArtifact(input),
        importPublicGithubArtifact: (input) =>
          repoStub().processorImportPublicGithubArtifact(input),
        linkGithub: async (input) => {
          await repoStub().processorLinkGithub(input);
        },
        syncPrivateGithub: async () => {
          await repoStub().syncFromGithub({ depth: 1, force: true });
        },
        // Sync the current GitHub head, not necessarily the delivery's SHA:
        // GitHub webhooks may arrive out of order, and adopting a newer head
        // also satisfies every older push delivery.
        syncFromGithubPush: async () => await repoStub().syncFromGithub({ depth: 1 }),
        // Fire-and-forget by contract (the processor does not await it); the
        // Repo DO applies it to its branch-head authority.
        observeArtifactPush: (input) => {
          void Promise.resolve(repoStub().processorObserveExternalPush(input)).catch(
            (error: unknown) => {
              console.error("[repo facet] observeArtifactPush forward failed", { error, path });
            },
          );
        },
      }),
      { recovery: true },
    );
  }

  /** The retired WorkspaceV2DurableObject hosting wiring (a pure reducer). */
  #registerWorkspace(
    identity: ProcessorFacetIdentity,
    stream: ProcessorStream,
    registry: StreamProcessorRegistry,
  ): void {
    // NO recovery on purpose: WorkspaceProcessor is a pure reducer (no
    // processEvent, no runInBackground), so an eviction can never lose
    // consequential background work.
    registry.register(
      new WorkspaceProcessor({
        stream,
        path: identity.path,
        projectId: identity.projectId!,
      }),
    );
  }
}

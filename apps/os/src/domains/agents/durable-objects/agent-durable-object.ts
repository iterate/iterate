import OpenAI from "openai";
import type { ResponsesClientEvent } from "openai/resources/responses/responses";
import { ResponsesWSBase } from "openai/resources/responses/ws-base";
import { z } from "zod";
import { createIterateDurableObjectBase } from "@iterate-com/shared/durable-object-utils/iterate-durable-object";
import {
  getInitializedDoStub,
  NotInitializedError,
} from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import type { ProcessorStreamApi } from "@iterate-com/streams/shared/stream-processors";
import type { Event, EventInput, StreamCursor } from "@iterate-com/shared/streams/types";
import { StreamPath } from "@iterate-com/shared/streams/types";
import type { StreamEvent } from "@iterate-com/streams/shared/event";
import type { StreamRpc } from "@iterate-com/streams/types";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "@iterate-com/streams/workers/stream-processor-host";
import { createD1Client } from "sqlfu";
import type { ItxDurableObject } from "~/itx/itx-durable-object.ts";
import type { CapabilityAddress } from "~/itx/itx.ts";
import { dialContext, extendContext, projectContextAddress } from "~/itx/journal.ts";
import { AgentChatProcessorContract } from "~/domains/agents/stream-processors/agent-chat/contract.ts";
import { AgentChatProcessor } from "~/domains/agents/stream-processors/agent-chat/implementation.ts";
import { AgentProcessorContract } from "~/domains/agents/stream-processors/agent/contract.ts";
import { AgentProcessor } from "~/domains/agents/stream-processors/agent/implementation.ts";
import {
  CloudflareAiProcessor,
  type CloudflareAiBinding,
} from "~/domains/agents/stream-processors/cloudflare-ai/implementation.ts";
import {
  OpenAiWsProcessor,
  type OpenAiResponsesWebSocket,
  type OpenAiResponsesWebSocketStreamMessage,
} from "~/domains/agents/stream-processors/openai-ws/implementation.ts";
import { JsonataReactorProcessorContract } from "~/domains/agents/stream-processors/jsonata-reactor/contract.ts";
import { JsonataReactorProcessor } from "~/domains/agents/stream-processors/jsonata-reactor/implementation.ts";
import { AgentHostProcessor } from "~/domains/agents/stream-processors/agent-host/implementation.ts";
import {
  getInitializedStreamStub,
  getStreamDurableObjectName,
  type StreamDurableObjectNamespace,
  type StreamDurableObject,
} from "~/domains/streams/stream-runtime.ts";
import { parseConfig } from "~/config.ts";
import {
  type RepoDurableObject,
  type RepoInfo,
} from "~/domains/repos/durable-objects/repo-durable-object.ts";
import { getReposCapability } from "~/domains/repos/entrypoints/repo-capability.ts";
import { resolveStreamPath } from "~/domains/streams/entrypoints/streams-backend.ts";
import {
  type WorkspaceDurableObject,
  type WorkspaceStructuredName,
} from "~/domains/workspaces/durable-objects/workspace-durable-object.ts";
import { stripArtifactTokenQuery } from "~/domains/repos/artifacts.ts";
import {
  DEFAULT_AGENT_LLM_PROVIDER,
  defaultAgentSetupEvents,
  defaultAgentSystemPrompt,
  isSlackAgentPath,
  OS_AGENT_LLM_PROVIDER_SELECTED_EVENT_TYPE,
  readAgentPathPrefixPresets,
  selectAgentSetupPreset,
  type AgentLlmProvider,
} from "~/domains/agents/agent-presets.ts";
import {
  AGENT_HOST_PROCESSOR_SLUG,
  AGENTS_STREAM_PATH,
  AgentDurableObjectStructuredName,
  agentLlmProcessorSlug,
  agentProcessorSubscriptionConfiguredEvents,
} from "~/domains/agents/agent-stream-subscriptions.ts";
import { buildProjectStreamViewerUrl } from "~/lib/stream-viewer-url.ts";

export {
  AGENT_HOST_PROCESSOR_SLUG,
  AGENTS_STREAM_PATH,
  AgentDurableObjectStructuredName,
  agentLlmProcessorSlug,
  agentProcessorSubscriptionKey,
  getAgentDurableObjectName,
} from "~/domains/agents/agent-stream-subscriptions.ts";

export type AgentDurableObjectEnv = {
  AGENT: DurableObjectNamespace<AgentDurableObject>;
  AI: CloudflareAiBinding;
  APP_CONFIG: string;
  ITX_CONTEXT: DurableObjectNamespace<ItxDurableObject>;
  DO_CATALOG: D1Database;
  REPO: DurableObjectNamespace<RepoDurableObject>;
  STREAM: DurableObjectNamespace<StreamDurableObject>;
  WORKSPACE: DurableObjectNamespace<WorkspaceDurableObject>;
};

const AGENT_ITERATE_CONFIG_DIR = "/iterate-config";
const AGENT_ITERATE_CONFIG_CLONE_COMPLETE_PATH = `${AGENT_ITERATE_CONFIG_DIR}/.git/iterate-clone-complete`;

export type CloneIterateConfigRepoInput = {
  git: Awaited<ReturnType<WorkspaceDurableObject["cloudflareShellGit"]>>;
  repo: RepoInfo;
  workspace: DurableObjectStub<WorkspaceDurableObject>;
};

type AgentStreamApi = Omit<
  ProcessorStreamApi<{
    emits: readonly string[];
    events: Record<string, unknown>;
    processorDeps?: readonly unknown[];
  }>,
  "append" | "appendBatch" | "read"
> & {
  append(args: { event: EventInput; streamPath?: string }): Promise<Event>;
  appendBatch(args: { events: EventInput[]; streamPath?: string }): Promise<Event[]>;
  read(args?: {
    streamPath?: string;
    afterOffset?: StreamCursor;
    beforeOffset?: StreamCursor;
  }): Promise<Event[]>;
};

const AgentLifecycleBase = createIterateDurableObjectBase<
  typeof AgentDurableObjectStructuredName,
  Pick<AgentDurableObjectEnv, "DO_CATALOG">
>({
  className: "AgentDurableObject",
  getDatabase: (env) => env.DO_CATALOG,
  indexes: {
    agentPath: (params) => params.agentPath,
    projectId: (params) => params.projectId,
  },
  nameSchema: AgentDurableObjectStructuredName,
});

/** Bump when agentContextCapabilities changes shape or membership. A bump
 * mints a FRESH context (journal, workspace and all) — contexts are
 * erasable; the agent's durable record is its own stream. */
const AGENT_CONTEXT_CAPABILITIES_VERSION = "3";

export class AgentDurableObject extends AgentLifecycleBase<AgentDurableObjectEnv> {
  host = createStreamProcessorHost(this.ctx);
  agentChatProcessor = this.host.add("agent-chat", (deps) => new AgentChatProcessor(deps));
  agentProcessor = this.host.add(
    "agent",
    (deps) =>
      new AgentProcessor({
        ...deps,
        readStreamEvents: () => this.readSubscribedStreamEvents("agent"),
      }),
  );
  openAiWsProcessor = this.host.add("openai-ws", (deps) => {
    const apiKey = readOpenAiApiKey(this.env as unknown as Record<string, unknown>);
    if (apiKey.trim() === "") {
      // Legacy parity with the old runner: without an OpenAI API key, the
      // "openai-ws" subscription is served by the Cloudflare AI processor.
      return new CloudflareAiProcessor({
        ...deps,
        ai: this.env.AI,
        readStreamEvents: () => this.readSubscribedStreamEvents("openai-ws"),
      });
    }
    return new OpenAiWsProcessor({
      ...deps,
      openResponsesWebSocket: async () =>
        createOpenAiResponsesWebSocketClient(new OpenAI({ apiKey })),
      readStreamEvents: () => this.readSubscribedStreamEvents("openai-ws"),
    });
  });
  cloudflareAiProcessor = this.host.add(
    "cloudflare-ai",
    (deps) =>
      new CloudflareAiProcessor({
        ...deps,
        ai: this.env.AI,
        readStreamEvents: () => this.readSubscribedStreamEvents("cloudflare-ai"),
      }),
  );
  jsonataReactorProcessor = this.host.add(
    "jsonata-reactor",
    (deps) => new JsonataReactorProcessor(deps),
  );
  agentHostProcessor = this.host.add(
    AGENT_HOST_PROCESSOR_SLUG,
    (deps) =>
      new AgentHostProcessor({
        ...deps,
        agentNamespace: this.env.AGENT,
        getItxContextId: async () => {
          const params = await this.ensureStartedOrInitializeFromRuntimeName();
          return await this.ensureItxContext(params);
        },
        getStreamContext: () => this.subscribedStreamContext(AGENT_HOST_PROCESSOR_SLUG),
        runnerEnv: this.env as unknown as Env,
        workerExports: this.ctx.exports,
      }),
  );

  constructor(ctx: DurableObjectState, env: AgentDurableObjectEnv) {
    super(ctx, env);

    this.registerOnInstanceWake(async (params) => {
      if (params.agentPath === AGENTS_STREAM_PATH) {
        await this.ensureAgentSubscriptions(params, [
          JsonataReactorProcessorContract.slug,
          AGENT_HOST_PROCESSOR_SLUG,
        ]);
      } else {
        await this.ensureAgentSetupEvents(params);
        const llmProvider = await this.resolveLlmProvider(params);
        this.ctx.waitUntil(
          this.ensureAgentWorkspace(params).catch((error) => {
            console.error("[agent-workspace-setup] failed", error);
          }),
        );
        await this.ensureAgentSubscriptions(params, [
          AgentChatProcessorContract.slug,
          AgentProcessorContract.slug,
          agentLlmProcessorSlug(llmProvider),
          AGENT_HOST_PROCESSOR_SLUG,
        ]);
        await this.ensureItxContext(params);
      }
      // Deliberately no catch-up wait here: wake hooks run inside
      // `blockConcurrencyWhile`, and the processors are co-hosted on this DO,
      // so the Stream DO's subscription handshake and event delivery are
      // inbound calls that cannot land while the input gate is closed. A wait
      // here can never observe progress and would burn its full timeout.
      // Public methods await `ensureStartedAndCaughtUp()` instead, which runs
      // the same wait once per instance wake, outside the gate.
    });
  }

  /** See the wake hook comment: the wake-time catch-up runs outside the lifecycle gate. */
  // eslint-disable-next-line no-unused-private-class-members -- oxlint false positive: read and assigned via ??=.
  #wakeCatchUp: Promise<void> | undefined;

  private async ensureStartedAndCaughtUp(): Promise<AgentDurableObjectStructuredName> {
    const params = await this.ensureStarted();
    this.#wakeCatchUp ??= this.waitForAgentProcessorsCatchUp(params).catch((error: unknown) => {
      this.#wakeCatchUp = undefined;
      throw error;
    });
    await this.#wakeCatchUp;
    return params;
  }

  /**
   * Subscription callables on agent streams dial this host entry point.
   * Initialize from the runtime name first: a cold instance can receive the
   * handshake before anything else has touched it, and the wake hook is what
   * seeds the agent's own subscriptions and setup events.
   */
  async requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    await this.ensureStartedOrInitializeFromRuntimeName();
    return await this.host.requestStreamSubscription(args);
  }

  async getRuntimeState() {
    const params = await this.ensureStartedAndCaughtUp();
    return await this.getAgentRuntimeState(params);
  }

  async sendMessage(input: { message: string; channel?: string }) {
    const params = await this.ensureStartedAndCaughtUp();
    const event = await this.streamsEntrypoint(params.agentPath).append({
      event: {
        type: "events.iterate.com/agent-chat/user-message-added",
        payload: {
          channel: parseAgentChatChannel(input.channel),
          content: input.message,
        },
      },
    });
    return { event };
  }

  /**
   * Kills the current Durable Object incarnation so crash recovery can be
   * observed: in-memory state (debounce timers, in-flight LLM executions,
   * sockets) dies with it. The Stream DO notices the broken delivery RPC,
   * redials, and the re-handshake's subscriber-connected facts drive every
   * processor's reconciliation on the fresh instance.
   */
  kill(): void {
    this.ctx.abort("kill requested");
  }

  async doThing(input: { label: string; value: number }) {
    await this.ensureStartedAndCaughtUp();
    return {
      agentName: this.name,
      label: input.label,
      value: input.value,
      doubled: input.value * 2,
    };
  }

  async callAgentTool(input: {
    args: unknown[];
    callId: string;
    path: string[];
    tool: "chat" | "debug";
  }) {
    await this.ensureStartedAndCaughtUp();
    if (input.tool === "debug") {
      return await this.createDebugSnapshot();
    }

    const functionName = input.path.join(".");
    if (functionName !== "sendMessage") {
      throw new Error(`Unknown agent chat tool function chat.${functionName}`);
    }

    const message = parseChatToolMessage(input.args[0]);
    const event = await this.appendAssistantResponse({
      idempotencyKey: `agent-chat-tool:send-message:${input.callId}`,
      message,
    });
    return { event };
  }

  private async ensureAgentSubscriptions(
    params: AgentDurableObjectStructuredName,
    processorSlugs: readonly string[],
  ) {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: params.projectId,
      path: params.agentPath,
    });

    await stream.appendBatch(
      agentProcessorSubscriptionConfiguredEvents({
        agentPath: params.agentPath,
        processorSlugs,
        projectId: params.projectId,
      }),
    );
  }

  private async waitForAgentProcessorsCatchUp(params: AgentDurableObjectStructuredName) {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: params.projectId,
      path: params.agentPath,
    });
    const events = await stream.history({ before: "end" });
    const maxOffset = events.at(-1)?.offset ?? 0;
    // The host subscribes each processor with `contract.consumes` as the
    // delivery filter, so a processor's checkpoint only ever reaches the offset
    // of the last event it consumes — not the stream head. Wait for that
    // per-processor target instead of `maxOffset` (which only wildcard
    // consumers reach).
    const targets = (await this.agentProcessorSlugs(params)).map((processorSlug) => {
      const consumes = this.hostedProcessor(processorSlug).contract.consumes;
      return {
        processorSlug,
        targetOffset: consumes.includes("*")
          ? maxOffset
          : events.reduce(
              (max, event) => (consumes.includes(event.type) ? Math.max(max, event.offset) : max),
              0,
            ),
      };
    });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (
        targets.every(
          ({ processorSlug, targetOffset }) =>
            this.processorCheckpointOffset(processorSlug) >= targetOffset,
        )
      ) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** Per-processor checkpoints — the honest shape (legacy runner fields died). */
  private async getAgentRuntimeState(params: AgentDurableObjectStructuredName) {
    const processorSlugs = await this.agentProcessorSlugs(params);
    return {
      agentPath: String(params.agentPath),
      processors: Object.fromEntries(
        processorSlugs.map((slug) => [slug, this.host.runtimeState(slug).snapshot ?? null]),
      ),
    };
  }

  private async agentProcessorSlugs(params: AgentDurableObjectStructuredName) {
    if (params.agentPath === AGENTS_STREAM_PATH) {
      return [JsonataReactorProcessorContract.slug, AGENT_HOST_PROCESSOR_SLUG];
    }
    return [
      AgentChatProcessorContract.slug,
      AgentProcessorContract.slug,
      agentLlmProcessorSlug(await this.resolveLlmProvider(params)),
      AGENT_HOST_PROCESSOR_SLUG,
    ];
  }

  /** The processor instance registered under a host name (the subscription slug). */
  private hostedProcessor(processorSlug: string) {
    const processors: Record<string, { contract: { consumes: readonly string[] } }> = {
      "agent-chat": this.agentChatProcessor,
      agent: this.agentProcessor,
      "openai-ws": this.openAiWsProcessor,
      "cloudflare-ai": this.cloudflareAiProcessor,
      "jsonata-reactor": this.jsonataReactorProcessor,
      [AGENT_HOST_PROCESSOR_SLUG]: this.agentHostProcessor,
    };
    const processor = processors[processorSlug];
    if (processor === undefined) {
      throw new Error(`Unknown agent stream processor "${processorSlug}"`);
    }
    return processor;
  }

  private processorCheckpointOffset(processorSlug: string) {
    return this.host.runtimeState(processorSlug).snapshot?.offset ?? 0;
  }

  /** Resolves the stream a hosted processor is subscribed to on this instance. */
  private subscribedStreamContext(processorSlug: string) {
    const subscription = this.host.runtimeState(processorSlug).subscription;
    if (subscription === undefined) {
      throw new Error(
        `Stream processor "${processorSlug}" has no stream subscription on this instance yet.`,
      );
    }
    return {
      projectId: subscription.namespace,
      streamPath: StreamPath.parse(subscription.path),
    };
  }

  /** Full committed history of the stream a hosted processor is subscribed to. */
  private async readSubscribedStreamEvents(processorSlug: string): Promise<StreamEvent[]> {
    const { projectId, streamPath } = this.subscribedStreamContext(processorSlug);
    const stream = this.env.STREAM.getByName(
      getStreamDurableObjectName({ namespace: projectId, path: streamPath }),
    ) as unknown as StreamRpc;
    return await stream.getEvents({ afterOffset: 0, beforeOffset: null });
  }

  private async ensureStartedOrInitializeFromRuntimeName() {
    try {
      return await this.ensureStarted();
    } catch (error) {
      if (!(error instanceof NotInitializedError)) throw error;
      const runtimeName = this.getDurableObjectName();
      if (runtimeName == null) throw error;
      return await this.initialize({ name: runtimeName });
    }
  }

  /** The agent's itx child context: its tools live on it as caps, scripts
   * run against it, misses delegate up to the project context. Seeding is
   * versioned: bump AGENT_CONTEXT_CAPABILITIES_VERSION when
   * agentContextCapabilities changes so existing agents re-provide caps
   * (provides upsert; the capability-noted idempotency keys dedupe
   * re-appends per cap name). */
  async ensureItxContext(params: AgentDurableObjectStructuredName): Promise<string> {
    // Single-flight: the wake hook's workspace prep (waitUntil) and script
    // runs can call this concurrently; without memoization the interleaved
    // storage get/put could mint two different context ids.
    this.#ensureItxContextPromise ??= this.#ensureItxContextOnce(params).finally(() => {
      this.#ensureItxContextPromise = undefined;
    });
    return await this.#ensureItxContextPromise;
  }

  #ensureItxContextPromise: Promise<string> | undefined;

  async #ensureItxContextOnce(params: AgentDurableObjectStructuredName): Promise<string> {
    const existing = await this.ctx.storage.get<string>("itxContextId");
    const seededVersion = await this.ctx.storage.get<string>("itxContextCapabilitiesVersion");
    if (existing && seededVersion === AGENT_CONTEXT_CAPABILITIES_VERSION) return existing;

    // Creation is an event: extend the project context with this agent's
    // path as the journal base, so the agent's whole subtree (its stream,
    // its context journal at <agentPath>/itx/<id>) reads as one directory.
    const config = this.getAppConfig();
    const created = await extendContext({
      base: params.agentPath,
      db: createD1Client(this.env.DO_CATALOG),
      env: this.env as unknown as Env,
      name: `agent:${params.agentPath}`,
      parent: { address: projectContextAddress(params.projectId), id: params.projectId },
      projectId: params.projectId,
      typeIdPrefix: config.typeIdPrefix,
    });
    const caps = this.agentContextCapabilities(params, created.contextId);
    const contextItx = dialContext(this.env as unknown as Env, created.address).itx();
    for (const cap of caps) {
      await contextItx.provideCapability({
        capability: cap.capability,
        instructions: cap.instructions,
        name: cap.name,
      });
    }
    // The LLM learns its tools from stream history: one rendered event per
    // cap (the agent processor rewrites these into the visible context).
    await this.streamsEntrypoint(params.agentPath).appendBatch({
      events: caps.map((cap) => ({
        type: "events.iterate.com/agent/capability-noted",
        idempotencyKey: `agent-capability-noted:${cap.name}`,
        payload: { instructions: cap.instructions, name: cap.name },
      })),
    });
    await this.ctx.storage.put("itxContextId", created.contextId);
    await this.ctx.storage.put("itxContextCapabilitiesVersion", AGENT_CONTEXT_CAPABILITIES_VERSION);
    return created.contextId;
  }

  private async ensureAgentWorkspace(params: AgentDurableObjectStructuredName) {
    const workspace = await this.getAgentWorkspace(params);

    if (await workspace.hasFile(AGENT_ITERATE_CONFIG_CLONE_COMPLETE_PATH)) {
      return;
    }

    const repo = await this.getOrCreateIterateConfigRepo(params);
    const git = await workspace.cloudflareShellGit();

    if (await workspace.hasFile(`${AGENT_ITERATE_CONFIG_DIR}/.git/HEAD`)) {
      let cloneIsUsable = true;
      try {
        await git.status({ dir: AGENT_ITERATE_CONFIG_DIR });
      } catch {
        cloneIsUsable = false;
      }

      if (cloneIsUsable) {
        await workspace.writeFile({
          content: `${repo.slug}\n`,
          path: AGENT_ITERATE_CONFIG_CLONE_COMPLETE_PATH,
        });
        return;
      }
    }

    await workspace.removePath({
      force: true,
      path: AGENT_ITERATE_CONFIG_DIR,
      recursive: true,
    });
    await this.cloneIterateConfigRepo({ git, repo, workspace });
    await workspace.writeFile({
      content: `${repo.slug}\n`,
      path: AGENT_ITERATE_CONFIG_CLONE_COMPLETE_PATH,
    });
  }

  protected async cloneIterateConfigRepo(input: CloneIterateConfigRepoInput) {
    await input.git.clone({
      url: remoteWithToken({
        remote: input.repo.remote,
        token: input.repo.token,
      }),
      dir: AGENT_ITERATE_CONFIG_DIR,
      branch: input.repo.defaultBranch,
      depth: 1,
    });
  }

  private async getOrCreateIterateConfigRepo(
    params: AgentDurableObjectStructuredName,
  ): Promise<RepoInfo> {
    return await getReposCapability({
      exports: this.ctx.exports,
      props: { projectId: params.projectId },
    }).ensureIterateConfigInfo({ projectSlug: null });
  }

  private async getAgentWorkspace(params: AgentDurableObjectStructuredName) {
    const contextId = await this.ensureItxContext(params);
    return await getInitializedDoStub({
      allowCreate: true,
      namespace: this.env.WORKSPACE,
      name: agentWorkspaceName({ contextId, params }),
    });
  }

  private async ensureAgentSetupEvents(params: AgentDurableObjectStructuredName) {
    const streamApi = this.streamsEntrypoint(params.agentPath);
    const events = await streamApi.read({ afterOffset: "start", beforeOffset: "end" });
    const rootEvents = await this.streamsEntrypoint(AGENTS_STREAM_PATH).read({
      afterOffset: "start",
      beforeOffset: "end",
    });
    const preset = selectAgentSetupPreset({
      agentPath: params.agentPath,
      presets: readAgentPathPrefixPresets(rootEvents),
    });
    const setupEvents =
      preset?.events ?? defaultAgentSetupEvents(DEFAULT_AGENT_LLM_PROVIDER, params.agentPath);
    const hasSetupPrompt = setupEvents.some(
      (event) => event.type === "events.iterate.com/agent/system-prompt-updated",
    );

    for (const [index, event] of setupEvents.entries()) {
      const idempotencyKey = `os-agent-setup:${normalizeIdempotencyKeyPart(
        preset?.basePath ?? "default",
      )}:${index}:${event.type}`;
      if (events.some((existingEvent) => existingEvent.idempotencyKey === idempotencyKey)) {
        continue;
      }
      if (preset == null && hasEquivalentDefaultSetupEvent({ event, existingEvents: events })) {
        continue;
      }
      await streamApi.append({
        event: {
          idempotencyKey,
          payload: event.payload,
          type: event.type,
        },
      });
    }

    const lastPrompt = [...events]
      .reverse()
      .find((event) => event.type === "events.iterate.com/agent/system-prompt-updated");
    const systemPromptPayload = lastPrompt?.payload as { systemPrompt?: unknown } | undefined;
    const systemPrompt =
      typeof systemPromptPayload?.systemPrompt === "string" ? systemPromptPayload.systemPrompt : "";
    if (
      !hasSetupPrompt &&
      (!systemPrompt || systemPrompt.includes("ctx.streams.append({ event:"))
    ) {
      await streamApi.append({
        event: {
          type: "events.iterate.com/agent/system-prompt-updated",
          idempotencyKey: "agent-default-system-prompt-v2",
          payload: {
            systemPrompt: defaultAgentSystemPrompt(params.agentPath),
          },
        },
      });
    }
  }

  private async createDebugSnapshot() {
    const project = await this.readDebugProjectInfo();
    const config = this.getAppConfig();
    const streamUrl = project?.slug
      ? buildProjectStreamViewerUrl({
          baseUrl: config.baseUrl,
          projectSlug: project.slug,
          streamPath: this.structuredName.agentPath,
        })
      : (config.baseUrl ?? "https://os.iterate.com");
    const snapshot = {
      project:
        project == null
          ? { id: this.structuredName.projectId }
          : {
              id: this.structuredName.projectId,
              organizationSlug: project.organizationSlug ?? undefined,
              slug: project.slug,
            },
      streamPath: this.structuredName.agentPath,
      streamUrl,
    };
    return formatDebugMessage(snapshot);
  }

  private async readDebugProjectInfo(): Promise<DebugProjectInfo | null> {
    try {
      const row = await this.env.DO_CATALOG.prepare(
        `select p.id, p.slug
         from projects p
         where p.id = ?
         limit 1`,
      )
        .bind(this.structuredName.projectId)
        .first<{ id: string; slug: string }>();
      if (row == null) return null;
      return {
        id: row.id,
        organizationSlug: null,
        slug: row.slug,
      };
    } catch (error) {
      console.error("[os-agent] failed to read project debug info", {
        agentName: this.name,
        error,
      });
      return null;
    }
  }

  private getAppConfig() {
    return parseConfig(this.env);
  }

  private async appendAssistantResponse(input: {
    channel?: string;
    idempotencyKey: string;
    message: string;
  }) {
    return await this.streamsEntrypoint(this.structuredName.agentPath).append({
      event: {
        type: "events.iterate.com/agent-chat/assistant-response-added",
        idempotencyKey: input.idempotencyKey,
        payload: {
          channel: parseAgentChatChannel(input.channel),
          message: input.message,
        },
      },
    });
  }

  private agentContextCapabilities(
    params: AgentDurableObjectStructuredName,
    contextId: string,
  ): Array<{
    name: string;
    instructions: string;
    capability: CapabilityAddress;
  }> {
    const agentTool = (tool: "chat" | "debug"): CapabilityAddress => ({
      entrypoint: "AgentToolsCapability",
      props: { agentPath: params.agentPath, tool },
      type: "rpc",
      worker: { type: "loopback" },
    });
    return [
      ...(isSlackAgentPath(params.agentPath)
        ? []
        : [
            {
              instructions:
                "Use itx.chat.sendMessage({ message }) to send a visible response to the user. Prefer this over appending chat events manually.",
              name: "chat",
              capability: agentTool("chat"),
            },
          ]),
      {
        instructions:
          "Use itx.debug() to return OS debug information about the current agent stream.",
        name: "debug",
        capability: agentTool("debug"),
      },
      {
        instructions:
          "Workers AI. itx.ai.run(model, input) — e.g. itx.ai.run('@cf/meta/llama-3.1-8b-instruct', { prompt: '…' }).",
        name: "ai",
        capability: { type: "rpc", worker: { binding: "AI", type: "binding" } },
      },
      {
        instructions:
          "Project-bound OS API. Call itx.os.listProcedures() for the TypeScript surface, then itx.os.<path.to.procedure>({ …input }).",
        name: "os",
        capability: { entrypoint: "OrpcCapability", type: "rpc", worker: { type: "loopback" } },
      },
      {
        instructions:
          "Gmail for this project's connected Google account. itx.gmail.request({ path, method?, query?, body? }).",
        name: "gmail",
        capability: { entrypoint: "GmailCapability", type: "rpc", worker: { type: "loopback" } },
      },
      {
        instructions:
          "Use itx.slack.<Slack Web API method path>(args), e.g. itx.slack.chat.postMessage({ channel, thread_ts, text }). Slack agents MUST respond on the same thread_ts that received the message; otherwise they will not receive responses from that thread. Unless explicitly required, always include thread_ts in Slack replies. Do not post to Slack unless the bot was explicitly mentioned, a user directly asks or instructs you, or the surrounding thread context clearly calls for agent action. If no reply is needed, do not call chat.postMessage. For legitimate long-running Slack replies, use Promise.all to send an immediate acknowledgment while doing the real work in parallel, then send the actual result afterwards.",
        name: "slack",
        capability: { entrypoint: "SlackCapability", type: "rpc", worker: { type: "loopback" } },
      },
      {
        instructions:
          "Use itx.agents.create() to get a promise-pipelineable subagent handle, e.g. await itx.agents.create().doThing(args).",
        name: "agents",
        capability: { entrypoint: "AgentCapability", type: "rpc", worker: { type: "loopback" } },
      },
      {
        // Workspaces are not itx's concern: this HOST decides its context
        // gets a private workspace and provides one bound to the context's
        // identity. Plain extensions of the project share the project
        // workspace through the chain instead.
        instructions:
          "This agent's private workspace filesystem: itx.workspace.readFile/writeFile plus " +
          "the flat git methods gitClone/gitAdd/gitCommit/gitPush/gitStatus.",
        name: "workspace",
        capability: {
          entrypoint: "WorkspaceCapability",
          props: { workspaceId: contextId },
          type: "rpc",
          worker: { type: "loopback" },
        },
      },
    ];
  }

  private async resolveLlmProvider(
    params: AgentDurableObjectStructuredName,
  ): Promise<AgentLlmProvider> {
    const rootEvents = await this.streamsEntrypoint(AGENTS_STREAM_PATH).read({
      afterOffset: "start",
      beforeOffset: "end",
    });
    const preset = selectAgentSetupPreset({
      agentPath: params.agentPath,
      presets: readAgentPathPrefixPresets(rootEvents),
    });
    const presetProvider = preset?.events
      .toReversed()
      .map((event) => (event.payload as { provider?: unknown }).provider)
      .find((provider) => provider === "cloudflare-ai" || provider === "openai-ws");
    if (presetProvider === "cloudflare-ai" || presetProvider === "openai-ws") {
      return presetProvider;
    }

    const events = await this.streamsEntrypoint(params.agentPath).read({
      afterOffset: "start",
      beforeOffset: "end",
    });
    for (const event of events.toReversed()) {
      if (event.type !== OS_AGENT_LLM_PROVIDER_SELECTED_EVENT_TYPE) continue;
      const provider = (event.payload as { provider?: unknown }).provider;
      if (provider === "cloudflare-ai" || provider === "openai-ws") return provider;
    }
    return DEFAULT_AGENT_LLM_PROVIDER;
  }

  private streamsEntrypoint(streamPath: StreamPath) {
    return agentStreamApiFromNamespace({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: this.structuredName.projectId,
      streamPath,
    });
  }
}

function normalizeIdempotencyKeyPart(value: string) {
  return value.replace(/[^a-zA-Z0-9._/-]+/g, "-");
}

function hasEquivalentDefaultSetupEvent(input: {
  event: { type: string };
  existingEvents: readonly { payload: unknown; type: string }[];
}) {
  if (input.event.type === "events.iterate.com/agent/system-prompt-updated") {
    return input.existingEvents.some((event) => event.type === input.event.type);
  }
  return input.existingEvents.some((event) => event.type === input.event.type);
}

export function readOpenAiApiKey(env: Record<string, unknown>) {
  const override = env.APP_CONFIG_OPEN_AI_API_KEY;
  if (typeof override === "string") return override;

  const rawConfig = env.APP_CONFIG;
  if (typeof rawConfig !== "string" || rawConfig.trim() === "") return "";

  try {
    const parsed = JSON.parse(rawConfig) as { openAiApiKey?: unknown };
    return typeof parsed.openAiApiKey === "string" ? parsed.openAiApiKey : "";
  } catch {
    return "";
  }
}

function agentStreamApiFromNamespace(args: {
  durableObjectNamespace: StreamDurableObjectNamespace;
  namespace: string;
  streamPath: StreamPath;
}): AgentStreamApi {
  return {
    async append(input) {
      const stream = await getInitializedStreamStub({
        durableObjectNamespace: args.durableObjectNamespace,
        namespace: args.namespace,
        path: resolveProcessorStreamPath({
          basePath: args.streamPath,
          pathInput: input.streamPath,
        }),
      });
      return await stream.append(input.event);
    },
    async appendBatch(input) {
      const stream = await getInitializedStreamStub({
        durableObjectNamespace: args.durableObjectNamespace,
        namespace: args.namespace,
        path: resolveProcessorStreamPath({
          basePath: args.streamPath,
          pathInput: input.streamPath,
        }),
      });
      return await stream.appendBatch(input.events);
    },
    async read(input = {}) {
      const stream = await getInitializedStreamStub({
        durableObjectNamespace: args.durableObjectNamespace,
        namespace: args.namespace,
        path: resolveProcessorStreamPath({
          basePath: args.streamPath,
          pathInput: input.streamPath,
        }),
      });
      return await stream.history({
        after: input.afterOffset,
        before: input.beforeOffset ?? "end",
      });
    },
    async *subscribe(input = {}) {
      void input;
      yield* [];
      throw new Error("Agent processors receive live events through afterAppend RPC.");
    },
  };
}

function resolveProcessorStreamPath(input: { basePath: StreamPath; pathInput?: string }) {
  if (input.pathInput == null) {
    return input.basePath;
  }

  const trimmedPath = input.pathInput.trim();
  if (!trimmedPath) {
    throw new Error("Stream path is required.");
  }

  if (trimmedPath.startsWith("/")) {
    return resolveStreamPath(trimmedPath);
  }

  const relativePath = trimmedPath.replace(/^\.\//, "").replace(/^\/+/, "");
  return StreamPath.parse(
    input.basePath === "/" ? `/${relativePath}` : `${input.basePath}/${relativePath}`,
  );
}

function agentWorkspaceName(input: {
  contextId: string;
  params: AgentDurableObjectStructuredName;
}): WorkspaceStructuredName {
  return {
    projectId: input.params.projectId,
    // Must match the workspace capability this agent provides on its own
    // context (agentContextCapabilities): the context id IS the workspace id.
    workspaceId: input.contextId,
  };
}

function remoteWithToken(input: { remote: string; token: string }) {
  const url = new URL(input.remote);
  url.username = "x";
  url.password = stripArtifactTokenQuery(input.token);
  return url.toString();
}

function parseAgentChatChannel(channel: string | undefined) {
  return channel === "tui" ? "tui" : "web";
}

type DebugProjectInfo = {
  id: string;
  organizationId?: string;
  organizationSlug?: string | null;
  slug: string;
};

type DebugSnapshot = {
  project: { id: string; organizationSlug?: string; slug?: string };
  streamPath: string;
  streamUrl: string;
};

function formatDebugMessage(snapshot: DebugSnapshot) {
  return [
    `*Debug:* <${snapshot.streamUrl}|open stream>`,
    `Path: \`${snapshot.streamPath}\``,
    `Project: \`${snapshot.project.slug ?? snapshot.project.id}\``,
    snapshot.project.organizationSlug
      ? `Organization: \`${snapshot.project.organizationSlug}\``
      : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function parseChatToolMessage(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("ctx.chat.sendMessage requires an object argument.");
  }
  const message = (value as { message?: unknown }).message;
  if (typeof message !== "string" || message.trim() === "") {
    throw new Error("ctx.chat.sendMessage requires a non-empty message string.");
  }
  return message;
}

type CloudflareSocketEventName = "open" | "message" | "close" | "error" | string;
type JsonValue = z.infer<ReturnType<typeof z.json>>;

export function createOpenAiResponsesWebSocketClient(client: OpenAI): OpenAiResponsesWebSocket {
  const sdkWebSocket = new CloudflareResponsesWebSocket(client);

  return {
    get url() {
      return sdkWebSocket.url;
    },
    get socket() {
      return sdkWebSocket.socket;
    },
    send(event) {
      sdkWebSocket.send(event as unknown as ResponsesClientEvent);
    },
    stream() {
      return streamOpenAiResponsesWebSocket(sdkWebSocket);
    },
    close(props) {
      sdkWebSocket.close(props);
    },
  };
}

async function* streamOpenAiResponsesWebSocket(
  sdkWebSocket: CloudflareResponsesWebSocket,
): AsyncIterableIterator<OpenAiResponsesWebSocketStreamMessage> {
  for await (const event of sdkWebSocket.stream()) {
    switch (event.type) {
      case "connecting":
      case "open":
      case "closing":
      case "reconnected":
        yield { type: event.type };
        break;
      case "close":
        yield { type: "close", code: event.code, reason: event.reason };
        break;
      case "reconnecting":
        yield { type: "reconnecting", reconnect: toJsonValue(event.reconnect) };
        break;
      case "message":
        yield { type: "message", message: toJsonValue(event.message) };
        break;
      case "raw":
        yield { type: "raw", data: event.data };
        break;
      case "error":
        yield { type: "error", error: event.error };
        break;
      default:
        event satisfies never;
    }
  }
}

function toJsonValue(value: unknown): JsonValue {
  return z.json().parse(value);
}

class CloudflareResponsesWebSocket extends ResponsesWSBase<CloudflareFetchWebSocket> {
  constructor(client: OpenAI) {
    super(client, { reconnect: null });
    this._connectInitial();
  }

  protected _createSocket(url: URL, authHeaders: Record<string, string>): CloudflareFetchWebSocket {
    return new CloudflareFetchWebSocket(url, {
      ...authHeaders,
      "OpenAI-Beta": "responses_websockets=2026-02-06",
    });
  }
}

class CloudflareFetchWebSocket {
  #listeners = new Map<CloudflareSocketEventName, Set<unknown>>();
  #onceListeners = new Map<CloudflareSocketEventName, Map<unknown, unknown>>();
  #readyState = 0;
  #socket: WebSocket | undefined;

  constructor(
    private readonly url: URL,
    private readonly authHeaders: Record<string, string>,
  ) {
    void this.#connect();
  }

  get readyState(): number {
    return this.#socket?.readyState ?? this.#readyState;
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.#socket == null) throw new Error("OpenAI WebSocket is not open.");
    this.#socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.#readyState = 2;
    this.#socket?.close(code, reason);
  }

  on(event: "open", listener: () => void): void;
  on(
    event: "message",
    listener: (data: string | ArrayBuffer | ArrayBufferView, isBinary: boolean) => void,
  ): void;
  on(event: "close", listener: (code: number, reason: string) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: CloudflareSocketEventName, listener: (...args: never[]) => void): void;
  on(event: CloudflareSocketEventName, listener: unknown): void {
    this.#listenersFor(event).add(listener);
  }

  off(event: "open", listener: () => void): void;
  off(
    event: "message",
    listener: (data: string | ArrayBuffer | ArrayBufferView, isBinary: boolean) => void,
  ): void;
  off(event: "close", listener: (code: number, reason: string) => void): void;
  off(event: "error", listener: (error: Error) => void): void;
  off(event: CloudflareSocketEventName, listener: (...args: never[]) => void): void;
  off(event: CloudflareSocketEventName, listener: unknown): void {
    this.#removeListener(event, listener);
  }

  once(event: "open", listener: () => void): void;
  once(
    event: "message",
    listener: (data: string | ArrayBuffer | ArrayBufferView, isBinary: boolean) => void,
  ): void;
  once(event: "close", listener: (code: number, reason: string) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: CloudflareSocketEventName, listener: (...args: never[]) => void): void;
  once(event: CloudflareSocketEventName, listener: unknown): void {
    const onceListener = (...args: never[]) => {
      this.#removeListener(event, listener);
      (listener as (...args: never[]) => void)(...args);
    };
    this.#onceListenersFor(event).set(listener, onceListener);
    this.on(event, onceListener);
  }

  get socket(): { readonly readyState: number } {
    return { readyState: this.readyState };
  }

  async #connect() {
    try {
      const response = (await fetch(this.url.toString().replace("wss://", "https://"), {
        headers: {
          ...this.authHeaders,
          Upgrade: "websocket",
        },
      })) as Response & { webSocket?: WebSocket | null };

      if (response.webSocket == null) {
        throw new Error(`OpenAI WebSocket upgrade failed with status ${response.status}.`);
      }

      this.#socket = response.webSocket;
      this.#socket.accept();
      this.#bindSocket(this.#socket);
      this.#readyState = this.#socket.readyState;
      this.#emit("open");
    } catch (error) {
      this.#readyState = 3;
      this.#emit("error", error instanceof Error ? error : new Error(String(error)));
      this.#emit("close", 1006, "OpenAI WebSocket upgrade failed.");
    }
  }

  #bindSocket(socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      this.#emit("message", event.data, event.data instanceof ArrayBuffer);
    });
    socket.addEventListener("close", (event) => {
      this.#readyState = 3;
      this.#emit("close", event.code, event.reason);
    });
    socket.addEventListener("error", () => {
      this.#emit("error", new Error("OpenAI WebSocket errored."));
    });
  }

  #listenersFor(event: CloudflareSocketEventName): Set<unknown> {
    const existing = this.#listeners.get(event);
    if (existing != null) return existing;

    const listeners = new Set<unknown>();
    this.#listeners.set(event, listeners);
    return listeners;
  }

  #onceListenersFor(event: CloudflareSocketEventName): Map<unknown, unknown> {
    const existing = this.#onceListeners.get(event);
    if (existing != null) return existing;

    const listeners = new Map<unknown, unknown>();
    this.#onceListeners.set(event, listeners);
    return listeners;
  }

  #removeListener(event: CloudflareSocketEventName, listener: unknown) {
    const listeners = this.#listeners.get(event);
    listeners?.delete(listener);
    const onceListener = this.#onceListeners.get(event)?.get(listener);
    if (onceListener == null) return;
    listeners?.delete(onceListener);
    this.#onceListeners.get(event)?.delete(listener);
  }

  #emit(event: CloudflareSocketEventName, ...args: unknown[]) {
    for (const listener of this.#listeners.get(event) ?? []) {
      (listener as (...args: unknown[]) => void)(...args);
    }
  }
}

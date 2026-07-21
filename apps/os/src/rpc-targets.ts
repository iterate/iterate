/**
 * The public itx capability surface.
 *
 * `/api` — os' one API — gives callers one unauthenticated object.
 * Authentication returns a root catalog, and every object reachable from that
 * catalog is a Cap'n Web / Workers RPC capability. Projects and agents expose
 * stable built-ins (`streams`, `repos`, `workers`, etc.) plus dynamic dotted
 * capabilities mounted on capability hosts (`itx.capabilityHost`,
 * `itx.capabilityHosts.get(path)`). Streams are the durable coordination layer
 * underneath those surfaces: processors, project bootstrap, repo bootstrap,
 * and agent loops all communicate by appending and reducing events.
 *
 * The four nouns. Keeping them distinct is what makes this system legible:
 *
 * - a SESSION is what `os.authenticate()` returns. It is a catalog that *vends*
 *   itxs; it is not itself an itx.
 * - a PROJECT is the tenant / isolation boundary — a `prj_…` id, its Durable
 *   Objects, its streams. You never hold a "project object"; you hold an itx
 *   scoped into a project.
 * - an itx is a capability context scoped into one project at one path. It is
 *   the `itx` in every `async (itx) => { … }` script and what `env.ITX.get()`
 *   returns; `session.projects.get(id)` gives you the itx at the project root,
 *   and an itx at "/agents/…" is what "an agent context" means.
 * - a CAPABILITY HOST is the durable dynamic-capability table (and script
 *   journal) at one scope path. Each itx fronts exactly one host
 *   (`itx.capabilityHost`; `itx.provideCapability`/`revokeCapability` are
 *   shortcuts onto it); `itx.capabilityHosts.get(path)` addresses any other
 *   scope's host, including the project root at `"/"`.
 */
import { RpcTarget } from "cloudflare:workers";
import type { StreamEvent, StreamEventInput, StreamListItem } from "iterate/processors";
import type { ProcessorReads } from "iterate/processors";
import type {
  GetProcessorRuntimeState,
  ProcessEventBatch,
  StreamPushEventBatch,
  ProcessorRuntimeState,
  ProcessorSnapshot,
  StreamEventReadInput,
  StreamProcessorRpc,
  StreamSubscriberPing,
  StreamSubscriberWakeRequest,
  StreamSubscriberWakeResponse,
  StreamSubscriptionHandle,
  WakeableStreamProcessorRpc,
} from "iterate/processors";
import { jsonValuesEqual, StreamReceiverUnavailableError } from "iterate/processors";
import {
  disposeIgnoredRpcResult,
  LiveState,
  LiveStateRpcTarget,
  type LiveStateRpc,
  type LiveStateSubscriptionHandle,
  type LiveUpdate,
} from "iterate/sdk/capnweb";
import type {
  ValidateProjectAppSessionInput,
  ValidatedProjectAppSession,
} from "@iterate-com/auth-contract/worker";
import type { AppConfig } from "./config.ts";
import { parseConfig } from "./config.ts";
import {
  isStreamDeliveryAuth,
  resolveItxAuth,
  resolveOrganizationSlugForCreate,
  userPrincipalOf,
  widenProjectAccess,
} from "./auth.ts";
import { itxEnv as env } from "./env.ts";
import {
  listProjectDirectory,
  primeProjectDirectory,
  readProjectById,
  resolveProjectIdBySlug,
  type ProjectIdentity,
} from "./project-directory.ts";
import { deploymentStatusesFromProbes } from "./project-deployment-status.ts";
import { timedStep } from "./lib/step-timing.ts";
import { buildCollectSecretUrl } from "./lib/collect-secret-link.ts";
import { buildProjectStreamViewerUrl } from "./lib/stream-viewer-url.ts";
import { buildProjectWorkerUrl } from "./lib/project-host-routing.ts";
import type { Env } from "./env.ts";
import { DurableObjectNameCodec, normalizePath } from "./domains/durable-object-names.ts";
import { parseAgentPath, resolveAgentPath } from "./domains/agents/utils.ts";
import {
  AGENT_COLLECTION_PATH,
  type AgentCollectionProcessorState,
} from "./domains/agents/agent-collection-processor-contract.ts";
import {
  describeNode,
  rejectBuiltinCollision,
  installPrototypeInvokeCapabilityFallback,
} from "./domains/itx/utils.ts";
import { projectStub } from "./domains/projects/egress.ts";
import { projectCreationEvents } from "./domains/projects/project-defaults.ts";
import { projectEgressFetcher } from "./domains/projects/utils.ts";
import { RepoProcessorContract } from "./domains/repos/repo-processor-contract.ts";
import { CONFIG_REPO_PATH } from "./domains/repos/paths.ts";
import { defaultProjectWorkerRef, isRepoNotSeededError } from "./domains/repos/utils.ts";
import { isWorkerBuildInProgressError } from "./domains/workers/worker-loader.ts";
import type { SandboxDurableObject } from "./domains/sandboxes/cloudflare/cloudflare-sandbox-durable-object.ts";
import { sandboxCreateClaimEvent } from "./domains/sandboxes/sandbox-defaults.ts";
import {
  SANDBOX_INSTANCE_TYPE_BINDINGS,
  SandboxInstanceType,
} from "./domains/sandboxes/instance-types.ts";
import { assertSandboxPath, sandboxCreateClaimKey } from "./domains/sandboxes/utils.ts";
import {
  SandboxProcessorContract,
  type SandboxProcessorState,
} from "./domains/sandboxes/sandbox-processor-contract.ts";
import { linkRepoToGithub, unlinkRepoFromGithub } from "./domains/repos/github-link.ts";
import {
  agentWorkspacePath,
  normalizeWorkspacePath,
  workspaceCreationEvents,
} from "./domains/workspaces/utils.ts";
import { canonicalRecurrence } from "./domains/scheduler/recurrence.ts";
import { schedulerCreationEvents } from "./domains/scheduler/scheduler-defaults.ts";
import { normalizeSchedulerPath, SCHEDULER_PRIMARY_PATH } from "./domains/scheduler/utils.ts";
import {
  generateProjectApiKeyMaterial,
  normalizeSecretPath,
  PROJECT_API_KEY_SECRET_PATH,
} from "./domains/secrets/utils.ts";
import {
  completeConnect,
  connectTelegram,
  disconnectProvider,
  getConnectionStatus,
  listIntegrationConnections,
  startOAuthFlow,
  type ConnectTelegramResult,
} from "./domains/integrations/connect-flows.ts";
import {
  BUILTIN_INTEGRATION_SLUGS,
  googleConnectionSecretPath,
  integrationConnectionStreamPath,
  isBuiltinIntegrationSlug,
} from "./domains/integrations/utils.ts";
import {
  TelegramProcessorContract,
  type TelegramProcessorState,
} from "./domains/integrations/telegram-processor-contract.ts";
import {
  connectionOctokit,
  GITHUB_CALL_GRAMMAR,
  normalizeGithubError,
} from "./domains/integrations/github-api.ts";
import { replayPathCall } from "./itx/path-proxy.ts";
import { callGmailApi } from "./domains/integrations/gmail-api.ts";
import { capturePosthogStreamEventBatch } from "./domains/integrations/posthog.ts";
import {
  connectionSlackClient,
  normalizeSlackError,
  SLACK_CALL_GRAMMAR,
} from "./domains/integrations/slack-api.ts";
import {
  callProjectTelegramBotApi,
  TELEGRAM_CALL_GRAMMAR,
} from "./domains/integrations/telegram-api.ts";
import {
  connectionWaitroseClient,
  WAITROSE_CALL_GRAMMAR,
} from "./domains/integrations/waitrose-api.ts";
import {
  deleteProjectFile,
  mintProjectFileUrl,
  putProjectFile,
  readProjectFile,
  storeAgentFileAttachments,
} from "./domains/files/project-files.ts";
import {
  buildDurableObjectProcessorSubscriptionConfiguredEvent,
  resolveStreamPath,
} from "./domains/streams/utils.ts";
import { compileJsonataExpression } from "./domains/streams/event-selector.ts";
import { DynamicWorkerRef as WorkerRefSchema } from "./domains/workers/schemas.ts";
import type {
  DynamicWorkerCapability,
  DynamicWorkerDispatchOptions,
  DynamicWorkerRef,
  ProjectWorker,
  StatefulDynamicWorkerRef,
} from "./domains/workers/schemas.ts";
import { retainProcessEventBatch } from "./domains/streams/subscriber-sinks.ts";
import {
  isDurableObjectLifecycleError,
  isStreamWaitTimeoutError,
  rethrowStreamUnavailable,
  retryStreamUnavailableOnce,
  STREAM_WAIT_TIMEOUT_MESSAGE_PREFIX,
} from "./domains/streams/stream-unavailable.ts";
import {
  isObjectSchema,
  listOpenApiOperations,
  operationBodySchema,
  type OpenApiOperation,
} from "./domains/itx/openapi-types.ts";
import { callMcpToolPath, listMcpTools } from "./domains/itx/mcp-client.ts";
import { ITX_EXAMPLES } from "./itx/examples.ts";
import { ITX_API_DECLARATIONS } from "./itx-api-graph.generated.ts";
import {
  declarationsByName,
  oneLineSummary,
  mountDeclaration,
  searchScore,
  weightedDeclarationScore,
  typeSlice,
  type DocsSearchHit,
} from "./domains/itx/itx-api-graph.ts";
import {
  mcpCapabilityTypeDeclaration,
  openApiCapabilityTypeInline,
  openApiCapabilityTypeReference,
} from "./domains/itx/capability-type-declarations.ts";
import { checkItxScript } from "./domains/typecheck/virtual-project.ts";
import type {
  CapabilityDescription,
  Description,
  ProjectDescription,
} from "./domains/itx/describe.ts";
import type { CfExecutionContext } from "./domains/itx/utils.ts";
import type { SandboxCreateInput } from "./domains/sandboxes/utils.ts";
import type {
  CommitRepoFilesInput,
  CommitRepoFilesResult,
  EditRepoFileInput,
  EditRepoFileResult,
  GithubResetResult,
  GithubSyncResult,
  LinkGithubResult,
  RepoCommitDetails,
  RepoLogResult,
} from "./domains/repos/types.ts";
import type {
  BuiltinIntegrationSlug,
  CompleteConnectResult,
  GmailRequestInput,
  GithubConnection,
  GmailConnection,
  IntegrationFamily,
  IntegrationConnectionStatus,
  IntegrationConnectionListEntry,
  OAuthProviderSlug,
  SlackConnection,
  TelegramConnection,
  WaitroseConnection,
} from "./domains/integrations/types.ts";
import type { EmailAttachmentInput } from "./domains/email/utils.ts";
import type { FileData } from "./domains/files/file-url-signing.ts";
import type { ProjectFileMetadata } from "./domains/files/project-files.ts";
import {
  AgentProcessorContract,
  type AgentEventInput,
  type AgentFileAttachment,
  type AgentLiveState,
  type AgentProcessorState,
} from "./domains/agents/agent-processor-contract.ts";
import {
  capabilityHostCreationEvents,
  type CapabilityHostCreateInput,
} from "./domains/capability-host/capability-host-defaults.ts";
import {
  settleByDeadline,
  type DeadlineOutcome,
} from "./domains/capability-host/execution-deadline.ts";
import type { ScheduleView, SetScheduleInput } from "./domains/scheduler/types.ts";
import { unwrapBrowserRunQuickAction } from "./domains/itx/cf-capabilities.ts";
import type {
  CfBrowserQuickAction,
  CfBrowserQuickActionOptions,
  CfImageTransformInput,
  CfAiRunOptions,
  CfMarkdownConversionArgs,
  CfMarkdownConversionOptions,
  CfMarkdownConversionResult,
  CfMarkdownDocument,
  CfMarkdownSupportedFormat,
  CfVideoTransformInput,
} from "./domains/itx/cf-capabilities.ts";
import type { ItxAuth, ItxAuthCredentials } from "./auth.ts";
import {
  authenticateProjectRequest,
  handleProjectAuthFetch,
  parseProjectAuthPolicy,
  projectAuthRequestFromRpc,
  type ProjectAuthActor,
  type ProjectAuthCredentials,
  type ProjectAuthPolicy,
  type ProjectAuthRpcMetadata,
} from "./auth/project-auth.ts";
import {
  localProjectAppSessionValidator,
  verifyProjectAppSessionToken,
} from "./auth/project-app-session-token.ts";
import type {
  McpBeginOAuthInput,
  McpBeginOAuthResult,
  McpClientConnectInput,
  McpClientRpc,
} from "./domains/itx/mcp-client.ts";
import { beginMcpOAuth, fetchLikeFromFetcher } from "./domains/itx/mcp-oauth.ts";
import type { OpenApiConnectInput, OpenApiRpc } from "./domains/itx/openapi-types.ts";
import type { ProjectListEntry } from "./project-deployment-status.ts";
import type {
  EgressResponse,
  ProjectEgressIntercept,
  ProjectEgressInterceptor,
} from "./domains/projects/egress.ts";
import type {
  ProvideCapabilityInput,
  RevokeCapabilityInput,
} from "./domains/capability-host/types.ts";
import type {
  CollectSecretInput,
  CollectSecretLink,
  SecretDescription,
  SecretCreateInput,
  SecretUpdateInput,
} from "./domains/secrets/types.ts";
import type {
  DeviceAppendInput,
  DeviceDescription,
  DeviceEnrollInput,
} from "./domains/devices/types.ts";
import type { StreamRuntimeDebugState } from "./domains/streams/stream-runtime-state.ts";
import type { ProjectProcessorState } from "./domains/projects/project-processor-contract.ts";
import type { ProjectLiveState } from "./domains/projects/project-live-state.ts";
import type { TouchInput } from "./domains/projects/stream-database.ts";
import type { RepoProcessorState } from "./domains/repos/repo-processor-contract.ts";
import type { SchedulerProcessorState } from "./domains/scheduler/scheduler-processor-contract.ts";
import type {
  EditWorkspaceFileInput,
  EditWorkspaceFileResult,
  WorkspaceCommitInput,
  WorkspaceCommitResult,
  WorkspaceGitLogEntry,
  WorkspaceGitLogInput,
  WorkspaceStatus,
} from "./domains/workspaces/types.ts";
import type {
  WorkspaceConfig,
  WorkspaceConfigPatch,
  WorkspaceMount,
  WorkspaceProcessorState,
} from "./domains/workspaces/workspace-processor-contract.ts";
import {
  DynamicWorkerRunner,
  type DynamicWorkerTraceRole,
} from "./domains/workers/worker-runner.ts";
import { integrationStreamStub } from "./domains/integrations/integration-streams.ts";
import {
  buildProjectEmailMessage,
  decodeBase64Attachment,
  emailAddressForProject,
  emailCounterpart,
  emailDomainForDeployment,
  emailThreadReplyAddress,
  EMAIL_INTEGRATION_STREAM_PATH,
  isOwnProjectMail,
  mintOutboundEmailThreadId,
  replySubject,
  type OutboundEmailAttachment,
  type SendEmailBinding,
} from "./domains/email/utils.ts";
import { EmailProcessorContract } from "./domains/email/email-processor-contract.ts";
import { EmailAgentProcessorContract } from "./domains/email/email-agent-processor-contract.ts";
import { agentCreationForPath, type AgentCreateInput } from "./domains/agents/agent-defaults.ts";
import { repoCreationEvents, type RepoCreateInput } from "./domains/repos/repo-defaults.ts";

/**
 * The root of every itx-facing RpcTarget. Extending it (directly, or through
 * another IterateRpcTarget subclass) is the opt-in signal for the generated
 * public contract (scripts/generate-itx-api.ts), and `Name` is the published
 * interface name — spelled exactly once, as a string literal, in the class
 * declaration that defines the surface:
 *
 *     class ProjectEgressRpcTarget extends IterateRpcTarget<"ProjectEgress"> { … }
 *
 * emits `export interface ProjectEgress { … }` from the class's public
 * members (their docstrings and explicit signatures ARE the contract text).
 * A class hierarchy passes the name through its parent's generic — the parent
 * names itself in the parameter default, the subclass in the argument:
 *
 *     class StreamCollectionRpcTarget<Name extends string = "StreamCollection">
 *       extends IterateRpcTarget<Name> { … }
 *     class ProjectStreamCollectionRpcTarget
 *       extends StreamCollectionRpcTarget<"ProjectStreamCollection"> { … }
 *
 * For a class that fronts an existing hand-authored contract instead of
 * defining its own interface, see {@link IterateRpcRelay}.
 */
class IterateRpcTarget<Name extends string> extends RpcTarget {
  /** Phantom carrier for the published name; never assigned, invisible at runtime. */
  declare protected readonly __itxPublicName?: Name;
}

/**
 * A relay: an RpcTarget that forwards to an existing hand-authored contract
 * named `Name` (a subscription handle, a processor RPC facade, a dynamic
 * proxy) rather than defining a surface of its own. The generator renames
 * mentions of the class to `Name` and publishes THAT type — which must be an
 * exported type alias or interface somewhere in the app. The class stays
 * honest either by `implements <contract>` or by its construction sites being
 * typed as the contract.
 */
class IterateRpcRelay<Name extends string> extends IterateRpcTarget<Name> {}

type FetchOnly = Pick<Fetcher, "fetch">;

const ITX_API_DECLARATIONS_BY_NAME = declarationsByName(ITX_API_DECLARATIONS);

const PARALLEL_OPENAPI_SPEC_URL = "https://docs.parallel.ai/public-openapi.json";
const PARALLEL_API_BASE_URL = "https://api.parallel.ai";
// Public create calls are acknowledgement boundaries, not indefinite leases.
// A wedged processor must fail the caller loudly instead of parking an RPC
// forever; the durable birth events remain committed for ordinary redelivery.
const PROCESSOR_BIRTH_WAIT_TIMEOUT_MS = 75_000;

function parallelOpenApiTarget(input: { egress: FetchOnly; parent: string }): OpenApiRpc {
  if (!parseConfig(env).integrations.parallel?.apiKey) {
    throw new Error("Parallel is not configured for this OS deployment.");
  }

  return OpenApiRpcTarget.createLazyClient(
    {
      baseUrl: PARALLEL_API_BASE_URL,
      headers: {
        // A platform API-key reference: resolved by the project egress door
        // from typed deployment config, origin-pinned (platform-secrets.ts).
        "x-api-key": 'getSecret({ platform: "integrations.parallel.apiKey" })',
      },
      specUrl: PARALLEL_OPENAPI_SPEC_URL,
    },
    {
      description: {
        instructions:
          "Parallel API using Iterate's platform API key. Methods are raw OpenAPI operationIds discovered lazily from Parallel's OpenAPI spec.",
        parent: input.parent,
        types: "export type Parallel = OpenApiRpc;",
      },
      egress: input.egress,
    },
  );
}

const STREAM_WAIT_REACQUIRE_MS = 10_000;

function detachPlainRpcResult<T>(result: T[]): T[];
function detachPlainRpcResult<T extends object>(result: T): T;
function detachPlainRpcResult(result: object): object {
  try {
    const detached = Array.isArray(result) ? [...result] : { ...result };
    Reflect.deleteProperty(detached, Symbol.dispose);
    return detached;
  } finally {
    try {
      disposeIgnoredRpcResult(result);
    } catch (error) {
      // The remote method has already succeeded and its plain data is safely
      // detached. Cleanup failure must stay observable without rewriting that
      // authoritative outcome into a product failure.
      console.warn("stream plain-data RPC result dispose failed", { error });
    }
  }
}

/**
 * Durable event stream capability.
 *
 * Streams are the public coordination primitive, not an internal queue hidden
 * behind domain methods. Domain helpers can construct common event shapes, but
 * callers and processors still work with explicit events.
 */
export class StreamRpcTarget extends IterateRpcTarget<"Stream"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions: `A durable event stream at path "${this.props.path}": append(events), readEvents(), getEvents(), waitForEvent(), subscribe(), crossPostTo(), kill(). Streams are the coordination primitive — processors and agents communicate by appending and reducing events. THE LOCALITY RULE: a processor on stream A can only react to events ON stream A; to react to another stream's events, cross-post them here (copies carry full source.crossPostedFrom provenance chains). append({ ..., ephemeral: true }) commits a TRANSIENT product event: live subscribe() connections see it, while default reads and durable subscribers exclude it unless a push/webhook explicitly opts in; the row may be evicted later, so append durable product truth separately.`,
      children: {
        append: "Commit events; returns them with offsets.",
        at: "The stream at a sub-path.",
        crossPostTo:
          "Copy matching events onto another stream (optionally JSONata-transformed). Cross-post subscriptions do not opt into ephemeral rows; a selector matching only ephemeral types delivers nothing.",
        getEvent: "One event by offset or idempotencyKey.",
        getEvents: "Read one bounded page of events.",
        kill: "Abort the current Durable Object incarnation; the next request boots it again.",
        readEvents: "Create a pager for bounded event pages.",
        removeCrossPost: "Remove a cross-post configured by crossPostTo.",
        liveState: "Subscribe to the stream core and delivery-runtime debug state.",
        subscribe: "Ephemeral live event delivery; returns an unsubscribe handle.",
        waitForEvent: "Block until a matching event lands.",
      },
      parent: "streams.get(path)",
    });
  }

  constructor(readonly props: { auth: ItxAuth; projectId: string | null; path: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  /** @internal */
  get durableObjectStub() {
    return env.STREAM.getByName(
      DurableObjectNameCodec.stringify(
        {
          projectId: this.props.projectId,
          path: this.props.path,
        },
        { allowNullProjectId: true },
      ),
    );
  }

  // The explicit signatures below ARE the public contract — the generated itx
  // api file prints them verbatim. Without explicit return annotations
  // TypeScript infers through the generated DurableObjectStub<StreamDurableObject>
  // type and would publish the DO's internal core-processor/runtime-state
  // implementation instead of the RPC API.
  //
  // Plain-data methods `.catch(rethrowStreamUnavailable)`: a stub rejection
  // caused by the DO incarnation dying mid-call (kill/eviction/deploy reset)
  // carries workerd's lifecycle flags HERE and nowhere downstream — capnweb
  // strips them — so this is the one hop that can tag "retryable, the stream
  // reboots on the next call" (`stream-unavailable: …`) apart from an
  // app-level rejection. Untagged, a kill mid-append crossed the wire as a
  // plain `Error("kill requested")` and the browser mirror's retry classifier
  // had to treat it as fatal (the stream-browser double-kill e2e's old CI
  // fixme). Stub-returning methods (readEvents, subscribe) stay bare — a
  // `.catch` would collapse the returned stub — and their data legs already
  // ride the tagged methods. Native Workers RPC also makes every object-valued
  // result disposable: detach its plain data, then release the invocation here
  // so a read cannot inherit the surrounding wake connection's lifetime.
  /** Commit events; resolves with the same events carrying offsets and timestamps. */
  async append(...events: StreamEventInput[]): Promise<StreamEvent[]> {
    const result = await this.durableObjectStub.append(...events).catch(rethrowStreamUnavailable);
    return detachPlainRpcResult(result);
  }

  /** The stream at a sub-path, resolved relative to this stream's path. */
  at(path: string): StreamRpcTarget {
    return new StreamRpcTarget({
      auth: this.props.auth,
      projectId: this.props.projectId,
      path: resolveStreamPath(this.props.path, path),
    });
  }

  /** One event by offset or idempotencyKey; undefined when it does not exist.
   * Point reads return ephemeral rows too — but those rows are evictable, so
   * an offset that once resolved may later read as undefined. */
  async getEvent(
    args: { offset: number; idempotencyKey?: never } | { idempotencyKey: string; offset?: never },
  ): Promise<StreamEvent | undefined> {
    const result = await this.durableObjectStub.getEvent(args).catch(rethrowStreamUnavailable);
    if (result === undefined) return undefined;
    return detachPlainRpcResult(result);
  }

  /**
   * Read one bounded page of committed events (default from the stream's
   * start; filter with `eventTypes`, page forward with `afterOffset`). A full
   * page (500 events) means MORE remain — page with
   * `afterOffset: events.at(-1).offset`; reading a long stream without paging
   * shows you the beginning, not the head.
   */
  async getEvents(args?: StreamEventReadInput): Promise<StreamEvent[]> {
    const result = await this.durableObjectStub.getEvents(args).catch(rethrowStreamUnavailable);
    return detachPlainRpcResult(result);
  }

  /**
   * A stateful pager over a read window: repeated `next()` calls walk forward
   * through pages, `[]` means "caught up for now". Dispose it when finished
   * (`using pager = stream.readEvents(...)`).
   */
  readEvents(args?: StreamEventReadInput): StreamEventPagerRpcTarget {
    return new StreamEventPagerRpcTarget((pageArgs) => this.getEvents(pageArgs), args);
  }

  /**
   * Block until an event lands that is after `afterOffset`, matches
   * `eventTypes`, and passes `predicate`; rejects after `timeoutMs`.
   * Durable rows after `afterOffset` are replayed. It can also match an
   * `ephemeral: true` event appended after this wait opens, but historical
   * ephemeral rows are never replayed.
   */
  async waitForEvent(args: {
    afterOffset?: number;
    eventTypes?: readonly string[];
    predicate?: (event: StreamEvent) => boolean | Promise<boolean>;
    timeoutMs: number;
  }): Promise<StreamEvent> {
    // Preserve the DO's validation error for invalid timeouts instead of
    // manufacturing a deadline from NaN/Infinity/a non-positive duration.
    if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
      const result = await this.durableObjectStub
        .waitForEvent(args)
        .catch(rethrowStreamUnavailable);
      return detachPlainRpcResult(result);
    }

    const deadline = Date.now() + args.timeoutMs;
    let replayAfterOffset = args.afterOffset;

    // A cursor-less DO wait is live-from-the-head at which that individual
    // subscription opens. Re-arming it with no cursor would therefore skip a
    // durable event committed between subscriptions. Pin one post-call-start
    // head and replay from it on every incarnation instead. Acquiring that
    // head is itself sliced under the same public deadline: a silent orphan
    // cannot wedge recovery before the first wait is even armed.
    while (replayAfterOffset === undefined && Date.now() < deadline) {
      const attemptDeadline = Math.min(deadline, Date.now() + STREAM_WAIT_REACQUIRE_MS);
      let head: Promise<number>;
      try {
        head = Promise.resolve(this.durableObjectStub.getMaxOffset());
      } catch (error) {
        rethrowStreamUnavailable(error);
      }
      const outcome = await settleByDeadline(head, attemptDeadline, Date.now);
      if (outcome.status === "fulfilled") {
        replayAfterOffset = outcome.value;
        break;
      }
      if (outcome.status === "rejected") rethrowStreamUnavailable(outcome.error);
    }

    const terminal = Promise.withResolvers<StreamEvent>();
    let lastSliceTimeout: unknown;

    while (Date.now() < deadline) {
      const attemptDeadline = Math.min(deadline, Date.now() + STREAM_WAIT_REACQUIRE_MS);
      // Keep the preceding healthy subscription alive for one extra slice
      // while its replacement opens. This bounds normal overlap at two and
      // avoids introducing an ephemeral-event gap at each recovery boundary;
      // durable events are additionally protected by replayAfterOffset.
      const remoteTimeoutMs = Math.max(
        1,
        Math.min(deadline - Date.now(), STREAM_WAIT_REACQUIRE_MS * 2),
      );
      let wait: Promise<StreamEvent>;
      try {
        wait = Promise.resolve(
          this.durableObjectStub.waitForEvent({
            ...args,
            afterOffset: replayAfterOffset,
            timeoutMs: remoteTimeoutMs,
          }),
        ).then((result) => detachPlainRpcResult(result));
      } catch (error) {
        rethrowStreamUnavailable(error);
      }

      // A superseded call can still report an ephemeral match that a fresh
      // subscription cannot replay. Let that success win. Likewise, retain a
      // late predicate/application/lifecycle failure as the terminal result;
      // only the explicitly modelled slice timeout is safe to replace with a
      // fresh durable replay. In particular, an explicit kill must retain the
      // public `stream-unavailable` rejection contract rather than being
      // hidden behind recovery until the caller's deadline.
      void wait.then(terminal.resolve, (error: unknown) => {
        if (!isStreamWaitTimeoutError(error)) terminal.reject(error);
      });

      const outcome = await settleByDeadline(
        Promise.race([wait, terminal.promise]),
        attemptDeadline,
        Date.now,
      );
      if (outcome.status === "fulfilled") return outcome.value;
      if (outcome.status === "rejected") {
        if (isStreamWaitTimeoutError(outcome.error)) {
          lastSliceTimeout = outcome.error;
          continue;
        }
        rethrowStreamUnavailable(outcome.error);
      }
    }

    throw new Error(
      `${STREAM_WAIT_TIMEOUT_MESSAGE_PREFIX}Timed out waiting for stream event after ${args.timeoutMs}ms ` +
        "(the public deadline expired while recovery re-armed one-shot waits).",
      lastSliceTimeout === undefined ? undefined : { cause: lastSliceTimeout },
    );
  }

  /** The reduced-state snapshot (plus runtime debug info) of one configured processor. */
  async getProcessorRuntimeState(args: {
    subscriptionKey: string;
  }): Promise<ProcessorRuntimeState | null> {
    const result = await this.durableObjectStub
      .getProcessorRuntimeState(args)
      .catch(rethrowStreamUnavailable);
    return result === null ? null : detachPlainRpcResult(result);
  }

  /**
   * Live debug view of the stream Durable Object: core processor state, open
   * connections with real delivery metrics (lag, bytes, commit→settled
   * latency, mutual-ping RTT), per-subscription delivery cursors/lag, and the
   * stream's own throughput windows. All runtime metrics are in-memory and
   * reset on eviction (`metrics.measuredSince` says how long the window has
   * been collecting); latency stats fields are absent until a real sample
   * exists — no value is ever synthesized. Calling this also requests a
   * throttled mutual-ping round over the live connections (observer-driven
   * sampling); live debug surfaces should subscribe through `liveState`.
   */
  async runtimeState(): Promise<StreamRuntimeDebugState> {
    const result = await this.durableObjectStub.runtimeState().catch(rethrowStreamUnavailable);
    return detachPlainRpcResult(result);
  }

  /** Push-driven stream runtime state for polling-free debug surfaces. */
  get liveState(): LiveStateRpc<StreamRuntimeDebugState> {
    return new LiveStateRelayRpcTarget<StreamRuntimeDebugState>(
      () =>
        this.durableObjectStub as unknown as LiveStateDurableObjectStub<StreamRuntimeDebugState>,
    );
  }

  /** Abort the current Durable Object incarnation; the next request boots it again. */
  kill(): Promise<void> {
    return Promise.resolve(this.durableObjectStub.kill());
  }

  /**
   * Session-scoped live event delivery (the "ephemeral" subscription lane):
   * `processEventBatch` first receives durable history after
   * `replayAfterOffset`, then new commits. Ephemeral events are delivered only
   * when appended after this exact subscription opens and are never replayed.
   * Returns an unsubscribe handle.
   * Forgotten on disconnect — durable delivery is configured as data instead,
   * by appending a `subscription-configured` event (wake or push mode) to the
   * stream.
   */
  subscribe(args: {
    subscriptionKey?: string;
    processEventBatch: ProcessEventBatch;
    replayAfterOffset?: number;
    /**
     * Atomically bind this open to the stream identity observed during
     * catch-up. `null` means the caller observed a stream with no committed
     * creation fact yet. A mismatch rejects before replacing any connection.
     */
    expectedIncarnation?: string | null;
    /**
     * Atomically reject instead of opening when the current raw-log head is
     * more than this many offsets beyond `replayAfterOffset`.
     */
    maxReplayOffsetGap?: number;
    /** Sugar for `selector.eventTypes` — one filter shape across every lane. */
    eventTypes?: readonly string[];
    selector?: { eventTypes?: string[]; condition?: string };
    events?: boolean;
    subscriber?: unknown;
    /** Optional live debug hook, retained for the subscription's lifetime. */
    getRuntimeState?: GetProcessorRuntimeState;
    /**
     * Optional mutual-ping responder (see `StreamPingInput`/`StreamPingReply`
     * in rpc-types.ts), retained for the subscription's lifetime. The stream
     * pings it — throttled, and only while someone is watching runtimeState —
     * to measure real transport RTT to this subscriber.
     */
    ping?: StreamSubscriberPing;
  }): Promise<StreamSubscriptionHandle> {
    // The zero-return-frame wire guarantee, relay leg. The Stream DO retains
    // and invokes the delivery callback over Workers RPC, and Workers RPC
    // always ships a call result — so if the DO's calls were forwarded
    // straight through to the subscriber's Cap'n Web stub, this worker would
    // have to PULL the subscriber's resolution to produce that result,
    // putting one subscriber-originated resolve frame per batch on the socket
    // (live-proven against a preview deployment; see stream-wire.e2e.test.ts).
    // Terminating the call HERE keeps the subscriber leg one-way: the
    // forwarder invokes the subscriber's stub and disposes the result
    // unpulled, and the DO's Workers RPC result is the forwarder's own
    // synchronous `undefined`. The retained stub is session-owned — Cap'n Web
    // disposes a session's exports when the session ends, which is exactly an
    // ephemeral subscription's lifetime.
    const forward = retainProcessEventBatch(args.processEventBatch);
    return this.durableObjectStub.subscribe({
      ...args,
      processEventBatch: (batch) => void forward(batch),
    });
  }

  /**
   * Cross-post receiving end: an ordinary push SINK (`(batch) => void`) that
   * appends the batch's events into THIS stream with provenance stamping,
   * structural loop protection, and source-derived idempotency keys. A source
   * stream cross-posts here by configuring
   * `{ delivery: { mode: "push", expression: ["streams", ["get", path], "acceptCrossPost"] } }`.
   */
  acceptCrossPost(batch: StreamPushEventBatch): Promise<void> {
    // Only the platform's own delivery spine dials acceptCrossPost: it arrives
    // through a push expression evaluated against the project's trusted itx
    // root. A session principal appending copies would bypass provenance
    // stamping.
    if (this.props.auth.principal !== "trusted-internal") {
      throw new Error("acceptCrossPost is dialed by stream push subscriptions, not sessions");
    }
    return Promise.resolve(this.durableObjectStub.acceptCrossPost(batch));
  }

  /**
   * "When events matching this land HERE, post them onto stream `path`" — the
   * cross-post verb. Pure sugar over appending a `subscription-configured`
   * push subscription targeting the destination's `acceptCrossPost` sink; the appended
   * event (returned) is the real interface and shows in the log like any
   * other config. Same-`key` calls replace the previous cross-post; remove
   * with `removeCrossPost`. Copies carry the full provenance chain
   * (`source.crossPostedFrom`), multi-hop legal, loop-protected. `transform`
   * is an optional JSONata expression CONSTRUCTING the copied event's body
   * from the original (e.g. `{ "type": "myapp/pr", "payload": { "repo":
   * payload.body.repository.full_name } }`); omitted fields copy verbatim.
   */
  async crossPostTo(args: {
    /** Destination stream path (this project). */
    path: string;
    /** Subscription identity; defaults to `cross-post:<destination path>`. */
    key?: string;
    /**
     * Human-readable note for operators and the stream state panel (why this
     * cross-post exists). Optional on the API; platform call sites always set it.
     */
    description?: string;
    eventTypes?: string[];
    /** JSONata filter; the event is copied only when it evaluates to exactly `true`. */
    condition?: string;
    /** JSONata constructor for the copied event's `{type?, payload?, metadata?}`. */
    transform?: string;
    /** Where to start: "new" (default, from now), "all" (full history), or an offset. */
    deliver?: "all" | "new" | { afterOffset: number };
  }): Promise<StreamEvent> {
    const destination = normalizePath(args.path);
    if (args.transform !== undefined) {
      // Same configure-time posture as selector conditions (#validateAppend
      // compiles them): an unparseable transform must fail THIS call, not
      // park the subscription at delivery time hours later.
      compileJsonataExpression(args.transform);
    }
    const selector = {
      ...(args.eventTypes === undefined ? {} : { eventTypes: args.eventTypes }),
      ...(args.condition === undefined ? {} : { condition: args.condition }),
    };
    const [event] = await this.append({
      type: "events.iterate.com/stream/subscription-configured",
      payload: {
        subscriptionKey: args.key ?? `cross-post:${destination}`,
        delivery: {
          mode: "push",
          expression: ["streams", ["get", destination], "acceptCrossPost"],
        },
        ...(args.description?.trim() ? { description: args.description.trim() } : {}),
        ...(Object.keys(selector).length === 0 ? {} : { selector }),
        ...(args.deliver === undefined ? {} : { deliver: args.deliver }),
        ...(args.transform === undefined ? {} : { params: { transform: args.transform } }),
      },
    });
    return event!;
  }

  /** Remove a cross-post configured by `crossPostTo` (by destination path or explicit key). */
  async removeCrossPost(args: { path?: string; key?: string }): Promise<StreamEvent> {
    const key =
      args.key ?? (args.path === undefined ? undefined : `cross-post:${normalizePath(args.path)}`);
    if (key === undefined) throw new Error("removeCrossPost needs a path or key");
    const [event] = await this.append({
      type: "events.iterate.com/stream/subscription-removed",
      payload: { subscriptionKey: key },
    });
    return event!;
  }
}

/** Stream catalog for either a project or the deployment-wide global scope. */
class StreamCollectionRpcTarget<
  Name extends string = "StreamCollection",
> extends IterateRpcTarget<Name> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions: "Stream catalog: get(path) returns the durable event stream at that path.",
      children: { get: "The stream at a path." },
    });
  }

  constructor(readonly props: { auth: ItxAuth; projectId: string | null }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  /** The durable event stream at a path. */
  get(path: string): StreamRpcTarget {
    return new StreamRpcTarget({
      auth: this.props.auth,
      projectId: this.props.projectId,
      path,
    });
  }
}

/** Project-scoped stream catalog with reduced-state listing. */
class ProjectStreamCollectionRpcTarget extends StreamCollectionRpcTarget<"ProjectStreamCollection"> {
  constructor(readonly projectProps: { auth: ItxAuth; projectId: string }) {
    super(projectProps);
  }

  /** Known streams, read from the project processor's reduced state. */
  list(): Promise<StreamListItem[]> {
    return projectProcessorState(this.projectProps.projectId).then((state) => state.streams);
  }
}

/**
 * One Scheduler: keyed Schedules on one `/scheduler/**` stream, triggered by
 * a durable alarm. Everything it does is events on that stream — `set`/`cancel`
 * append, `list` reads reduced state, and every Trigger's request and outcome
 * are appended back, so the stream is the complete audit log. Scripts run
 * with project-root itx authority, at least once per Trigger (derive append
 * idempotency keys from `trigger.executionId`).
 *
 * A thin forwarder to the SchedulerDurableObject: the command surface runs on
 * the DO so every write returns read-your-writes visible and alarm-armed;
 * this target only normalizes input sugar before dialing.
 */
class SchedulerRpcTarget extends IterateRpcTarget<"Scheduler"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        `The Scheduler at "${this.props.path}": keyed Schedules that run itx scripts on a ` +
        "recurrence ({ at } | { every: seconds } | { cron, timezone? }; set() also accepts " +
        "{ in: seconds }). Scripts are function-expression STRINGS `async (itx, schedule, trigger) " +
        "=> { ... }` running with project-root authority, at least once per Trigger — derive " +
        "append idempotency keys from trigger.executionId. Every Schedule change and Trigger " +
        "outcome is an event on this stream.",
      children: {
        cancel: "Remove a Schedule by key (idempotent).",
        create: "Create the Scheduler on this stream and wait until it has processed its birth.",
        kill: "Restart the scheduler's server-side object; the next request boots it fresh.",
        list: "Every Schedule, reduced from the stream.",
        processor: "The scheduler stream processor (snapshot/state).",
        set: "Upsert a Schedule: { key, recurrence, script, metadata? }.",
        trigger: "Run a Schedule now (advances a recurring clock, consumes a one-shot).",
      },
      parent: "schedulers.get(path)",
    });
  }

  constructor(readonly props: { auth: ItxAuth; projectId: string; path: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  get #durableObjectStub() {
    return env.SCHEDULER.getByName(
      DurableObjectNameCodec.stringify({
        projectId: this.props.projectId,
        path: this.props.path,
      }),
    );
  }

  get #stream(): StreamRpcTarget {
    return new StreamRpcTarget({
      auth: this.props.auth,
      path: this.props.path,
      projectId: this.props.projectId,
    });
  }

  /** The scheduler stream processor (snapshot/state). */
  get processor(): WakeableStreamProcessorRpc<SchedulerProcessorState> {
    return new ProcessorRelayRpcTarget<SchedulerProcessorState>({
      auth: this.props.auth,
      host: () => this.#durableObjectStub as unknown as ProcessorHostStub,
    });
  }

  /** Create this Scheduler and return only after it has processed the complete birth batch. */
  async create(_input: Record<string, never> = {}): Promise<SchedulerRpcTarget> {
    const committed = await this.#stream.append(
      ...schedulerCreationEvents({
        path: this.props.path,
        projectId: this.props.projectId,
      }),
    );
    const offset = committed.reduce((maximum, event) => Math.max(maximum, event.offset), 0);
    if (offset === 0) throw new Error("scheduler create committed no events");
    await this.processor.waitUntilProcessed({
      offset,
      timeoutMs: PROCESSOR_BIRTH_WAIT_TIMEOUT_MS,
    });
    return this;
  }

  /** Upsert by key; returns after the Scheduler has ingested the set (read-your-writes, alarm armed). */
  set(input: SetScheduleInput): Promise<ScheduleView> {
    return this.#durableObjectStub.setSchedule({
      action: { kind: "itx-script", script: input.script },
      key: input.key,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      recurrence: canonicalRecurrence(input.recurrence, Date.now()),
    });
  }

  /** Remove a key. Idempotent; an in-flight Trigger completes as `skipped`. */
  cancel(key: string): Promise<void> {
    return this.#durableObjectStub.cancelSchedule(key);
  }

  /** Restart the scheduler's server-side object; the next request boots it fresh. */
  kill(): Promise<void> {
    return Promise.resolve(this.#durableObjectStub.kill());
  }

  list(): Promise<ScheduleView[]> {
    return this.#durableObjectStub.listSchedules();
  }

  /** Run a Schedule now. Advances a recurring Schedule's clock and consumes a one-shot. */
  trigger(key: string): Promise<{ executionId: string }> {
    return this.#durableObjectStub.triggerSchedule(key);
  }
}

/** Path-addressed Scheduler catalog; `itx.scheduler` is `get("/scheduler/primary")`. */
class SchedulerCollectionRpcTarget extends IterateRpcTarget<"SchedulerCollection"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        'Scheduler catalog: get(path) returns the Scheduler at a /scheduler/** path. The default is itx.scheduler (= get("/scheduler/primary")); extra Schedulers are for isolating noisy workloads.',
      children: { get: "The Scheduler at a path." },
      parent: "a project itx (itx.schedulers)",
    });
  }

  constructor(readonly props: { auth: ItxAuth; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  /** The Scheduler at a `/scheduler/**` path. */
  get(path: string): SchedulerRpcTarget {
    return new SchedulerRpcTarget({
      auth: this.props.auth,
      path: normalizeSchedulerPath(path),
      projectId: this.props.projectId,
    });
  }
}

function rootStream(props: { auth: ItxAuth; projectId: string | null }) {
  return new StreamRpcTarget({
    auth: props.auth,
    projectId: props.projectId,
    path: "/",
  });
}

/** Git-backed repo capability used by project workers and dynamic worker refs. */
class RepoRpcTarget extends IterateRpcTarget<"Repo"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions: `A git repo (over Cloudflare Artifacts) at path "${this.props.path}": readFile/listFiles/commitFiles/edit, plus create() for first use. For coding-agent file changes that do not need a sandbox, readFile then edit is the default targeted workflow; use commitFiles for new files or batch/full-file writes. Optionally GitHub-backed: linkGithub({ connection, owner, repo }) mirrors every commit to a real GitHub repository (created private if missing), imports fast-forward default-branch pushes from GitHub, and cross-posts GitHub webhooks onto this repo's stream; the repo processor state shows the link and last push outcome.`,
      children: {
        commitDetails:
          "One commit's metadata plus its changed files with +/- line counts, diffed against its first parent ({ commitOid }).",
        commitFiles:
          "Commit a batch of file changes ({ message, changes }); each change is { path, content } for text, { path, contentBase64 } for binary, or { path, delete: true }.",
        create:
          "Request the repo creation saga (optional payload = the repos/create-requested source: empty seed by default, or a GitHub import) and wait for its terminal repos/created certificate; returns this same repo handle, or throws the recorded repos/create-failed error.",
        edit: "Replace an exact string in one file and commit it; oldString must match once unless replaceAll is true.",
        kill: "Restart the repo's server-side object; the next request boots it fresh.",
        linkGithub:
          "Back this repo with a GitHub repository via a named GitHub connection ({ connection, owner, repo }); commits mirror out, fast-forward default-branch pushes import in, and webhooks cross-post in.",
        listFiles: "List file paths.",
        listTaskFiles:
          "Every task markdown file's contents at HEAD ({ commitOid, files }) in one read — the task board's bulk load, cheaper than listFiles + a readFile per task.",
        log: "Commit history, newest first ({ limit?, branch? }); per-commit file stats live on commitDetails.",
        pushToGithub:
          "Push the branch head to the linked GitHub repository now (repair verb; { force } to overwrite GitHub).",
        readFile:
          'Read one file ({ path, encoding?, commitOid? }); encoding "base64" for binary files (images, PDFs), commitOid for a pinned read at a historic commit.',
        resetFromGithub:
          "Destructively replace the Artifacts repo with the linked GitHub branch ({ depth? }); GitHub always wins and big repositories require a shallow depth.",
        syncFromGithub:
          "Adopt GitHub's branch head (fast-forward only; { force } discards local-only commits; { depth } requests a bounded history window, while fast-forwards always retain the prior Artifacts head for queue diffs).",
        unlinkGithub: "Remove the GitHub link and its webhook cross-post rule.",
        whoami: "Repo identity string (debug).",
      },
      parent: "repos.get(path); the project's config repo (/repos/config) is itx.repo",
    });
  }

  constructor(readonly props: { auth: ItxAuth; path: string; projectId: string | null }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  // Private on purpose (unlike StreamRpcTarget's public stub getter): the
  // Repo Durable Object carries `gitAccess()`, whose write tokens must not be
  // reachable through the public capnweb surface — itx callers get file-level
  // methods only.
  get #durableObjectStub() {
    return env.REPO.getByName(
      DurableObjectNameCodec.stringify(
        {
          projectId: this.props.projectId,
          path: normalizePath(this.props.path),
        },
        { allowNullProjectId: true },
      ),
    );
  }

  /**
   * Request creation and wait for the repo creation saga's terminal fact.
   * The request chooses an empty starter seed (the default), a private
   * GitHub pull at depth one, or a public import performed by Cloudflare
   * Artifacts outside the Worker isolate (full history unless `depth` is
   * provided). Appends the atomic request batch (`repos/create-requested` +
   * the repo processor subscription, plus the catalog cross-post rule that
   * copies the terminal certificate onto `/`), then waits for
   * `repos/created` and resolves with this same handle, so create chains —
   * or throws the saga's recorded error when creation fails. An
   * identical-payload retry dedupes on the request idempotency keys and
   * resumes the same saga; a create over an existing repo with a different
   * payload fails loudly.
   */
  async create(payload?: RepoCreateInput): Promise<RepoRpcTarget> {
    const requestSchema =
      RepoProcessorContract.events["events.iterate.com/repos/create-requested"].payloadSchema;
    const failureSchema =
      RepoProcessorContract.events["events.iterate.com/repos/create-failed"].payloadSchema;
    const request = requestSchema.parse(payload ?? { type: "empty" });
    const path = normalizePath(this.props.path);
    const stream = new StreamRpcTarget({
      auth: this.props.auth,
      path,
      projectId: this.props.projectId,
    });
    const timing = { projectId: this.props.projectId, path };
    const committed = await timedStep("create-timing", timing, "repo-request-append", () =>
      stream.append(
        ...repoCreationEvents({ path, projectId: this.props.projectId, payload: request }),
        {
          type: "events.iterate.com/stream/subscription-configured",
          idempotencyKey: `repo-catalog-subscription:${this.props.projectId}:${path}`,
          payload: {
            subscriptionKey: "repo-catalog",
            description: "Copy the repo's terminal creation certificate to the project catalog.",
            selector: { eventTypes: ["events.iterate.com/repos/created"] },
            delivery: {
              mode: "push",
              expression: ["streams", ["get", "/"], "acceptCrossPost"],
            },
            deliver: "new",
          },
        },
      ),
    );
    // An idempotency hit returns the FIRST request at its old offset — the
    // loud duplicate-create failure is this comparison, not the stream.
    const recordedRequest = requestSchema.parse(committed[0]?.payload);
    if (!jsonValuesEqual(recordedRequest, request)) {
      throw new Error(`${path} was already requested with a different creation source.`);
    }
    const terminal = await timedStep("create-timing", timing, "wait-repo-created", () =>
      stream.waitForEvent({
        afterOffset: committed[0]!.offset - 1,
        eventTypes: ["events.iterate.com/repos/created", "events.iterate.com/repos/create-failed"],
        predicate: (event) => {
          const terminalRequest =
            event.type === "events.iterate.com/repos/create-failed"
              ? failureSchema.parse(event.payload).request
              : requestSchema.parse(event.payload?.request);
          return jsonValuesEqual(terminalRequest, recordedRequest);
        },
        // Generous on purpose: a public import materializes the full history
        // inside Cloudflare Artifacts before the certificate lands.
        timeoutMs: 300_000,
      }),
    );
    if (terminal.type === "events.iterate.com/repos/create-failed") {
      throw new Error(
        `${path} could not be created: ${failureSchema.parse(terminal.payload).error}`,
      );
    }
    return this;
  }

  /** Repo identity string (debug). */
  whoami(): Promise<string> {
    return this.#durableObjectStub.whoami();
  }

  /** Restart the repo's server-side object; the next request boots it fresh. */
  kill(): Promise<void> {
    return Promise.resolve(this.#durableObjectStub.kill());
  }

  /** Commit a batch of file changes; use `edit` for a targeted single-string replacement. */
  commitFiles(input: CommitRepoFilesInput): Promise<CommitRepoFilesResult> {
    return this.#durableObjectStub.commitFiles(input);
  }

  /**
   * Safely replace text in one committed file and commit the result. The
   * `oldString` must match exactly once unless `replaceAll` is true.
   */
  edit(input: EditRepoFileInput): Promise<EditRepoFileResult> {
    return this.#durableObjectStub.edit(input);
  }

  /** All committed file paths at HEAD. */
  listFiles(): Promise<{ commitOid: string; paths: string[] }> {
    return this.#durableObjectStub.listFiles();
  }

  /**
   * Every task markdown file's contents at HEAD, keyed by path, in a single
   * clone — the task board's bulk load. Cheaper than `listFiles()` plus a
   * `readFile()` per task: the task include mask is applied before contents
   * are read, so cost scales with the number of tasks, not the repo size.
   */
  listTaskFiles(): Promise<{ commitOid: string; files: Record<string, string> }> {
    return this.#durableObjectStub.listTaskFiles();
  }

  /**
   * Commit history of a branch, newest first — oid, message, author,
   * timestamp (epoch ms), parent oids. Deliberately without per-commit file
   * stats (those cost tree checkouts per commit); fetch them lazily per
   * commit through `commitDetails`.
   */
  log(input: { branch?: string; limit?: number } = {}): Promise<RepoLogResult> {
    return this.#durableObjectStub.log(input);
  }

  /**
   * One commit's metadata plus the files it changed versus its first parent
   * (the whole tree for the root commit), with `git diff --numstat`-shaped
   * +/- line counts; binary files are flagged instead of counted.
   */
  commitDetails(input: { branch?: string; commitOid: string }): Promise<RepoCommitDetails> {
    return this.#durableObjectStub.commitDetails(input);
  }

  /**
   * Committed file contents at HEAD — or, with `commitOid`, pinned to that
   * commit — null when the path does not exist there. `encoding: "base64"`
   * reads raw bytes (images, PDFs) base64-encoded.
   */
  readFile(input: { path: string; encoding?: "utf8" | "base64"; commitOid?: string }): Promise<{
    commitOid: string;
    content: string;
    path: string;
  } | null> {
    return this.#durableObjectStub.readFile(input);
  }

  /**
   * Back this repo with a real GitHub repository through a named GitHub
   * connection. From then on every default-branch commit is mirrored to
   * GitHub best-effort (failures journal on the repo stream and self-heal on
   * the next commit), fast-forward default-branch pushes made on GitHub are
   * imported through the Cloudflare Artifacts queue, and every GitHub webhook
   * about that repository is cross-posted onto this repo's stream. If the
   * GitHub repository does not exist and the installation can create org
   * repositories, it is created private. Re-linking replaces the previous
   * link.
   */
  linkGithub(input: {
    connection: string;
    owner: string;
    repo: string;
  }): Promise<LinkGithubResult> {
    return linkRepoToGithub({
      connection: input.connection,
      owner: input.owner,
      projectId: this.#requireProjectId(),
      repo: input.repo,
      repoPath: this.props.path,
    });
  }

  /** Remove the GitHub link and its webhook cross-post rule. */
  unlinkGithub(): Promise<{ unlinked: boolean }> {
    return unlinkRepoFromGithub({
      projectId: this.#requireProjectId(),
      repoPath: this.props.path,
    });
  }

  /**
   * Push the default branch head to the linked GitHub repository now — the
   * repair verb for a failed mirror push. Never forced by default; `force:
   * true` makes this repo win over commits made directly on GitHub.
   */
  pushToGithub(input: { force?: boolean } = {}): Promise<{ branch: string; commitOid: string }> {
    return this.#durableObjectStub.pushToGithub(input);
  }

  /**
   * Adopt the linked GitHub repository's default-branch head into this repo.
   * Fast-forward only: fails when this repo has commits GitHub does not,
   * unless `force: true` discards them. The synced head is immediately live
   * for worker builds.
   *
   * The history transfers in-process. `depth` requests a bounded history
   * window, but fast-forward syncs always retain the previous Artifacts head
   * as well so queue-derived task diffs can read both sides. GitHub retains
   * the full history, and a later deeper sync can always widen the window.
   */
  syncFromGithub(input: { depth?: number; force?: boolean } = {}): Promise<GithubSyncResult> {
    return this.#durableObjectStub.syncFromGithub(input);
  }

  /**
   * Hard recovery: destroy and recreate the Artifacts repository from the
   * linked GitHub repository's default branch. GitHub always wins and the
   * operation runs even when the recorded commit oids already match. The
   * source clone is completed before destruction; `depth` bounds memory for
   * large histories without changing anything on GitHub.
   */
  resetFromGithub(input: { depth?: number } = {}): Promise<GithubResetResult> {
    return this.#durableObjectStub.resetFromGithub(input);
  }

  // GitHub connections are project-scoped (their secrets and streams live in
  // a project), so a global repo has nothing to link through.
  #requireProjectId(): string {
    if (this.props.projectId === null) {
      throw new Error("GitHub-backed repos require a project-scoped repo.");
    }
    return this.props.projectId;
  }

  /** The repo stream processor (snapshot/state). */
  get processor(): WakeableStreamProcessorRpc<RepoProcessorState> {
    return new ProcessorRelayRpcTarget<RepoProcessorState>({
      auth: this.props.auth,
      host: () => this.#durableObjectStub as unknown as ProcessorHostStub,
    });
  }

  /** The repo's live state — its reduced processor state. See {@link LiveStateRpc}. */
  get liveState(): LiveStateRpc<RepoProcessorState> {
    return new LiveStateRelayRpcTarget<RepoProcessorState>(
      () => this.#durableObjectStub as unknown as LiveStateDurableObjectStub<RepoProcessorState>,
    );
  }
}

/** Repo catalog for either a project or the deployment-wide global scope. */
class RepoCollectionRpcTarget<
  Name extends string = "RepoCollection",
> extends IterateRpcTarget<Name> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        "Repo catalog: get(path); get(path).create() runs the repo creation saga at that path (empty seed by default, or a GitHub import).",
      children: { get: "The repo at a path." },
    });
  }

  constructor(readonly props: { auth: ItxAuth; projectId: string | null }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  /** The repo at a path. */
  get(path: string): RepoRpcTarget {
    return new RepoRpcTarget({
      auth: this.props.auth,
      path: normalizePath(path),
      projectId: this.props.projectId,
    });
  }
}

/** Project-scoped repo catalog with reduced-state listing. */
class ProjectRepoCollectionRpcTarget extends RepoCollectionRpcTarget<"ProjectRepoCollection"> {
  constructor(readonly projectProps: { auth: ItxAuth; projectId: string }) {
    super(projectProps);
  }

  async __describe(): Promise<Description> {
    return describeNode({
      instructions: "Project repo catalog: list() or get(path); call create(...) on the repo.",
      children: {
        get: "The repo at a path.",
        list: "Known project repos.",
      },
    });
  }

  /** Known repos, read from the project processor's reduced state. */
  list(): Promise<StreamListItem[]> {
    return projectProcessorState(this.projectProps.projectId).then((state) => state.repos);
  }
}

/** Agent catalog within one project. */
class AgentCollectionRpcTarget extends IterateRpcTarget<"AgentCollection"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        'Agent catalog: get("/agents/<name>") returns the agent control surface. Paths without a leading "/" resolve relative to YOUR scope with filesystem semantics — get("researcher") from an agent script addresses a child agent, get("..") from a child addresses its parent. list() the known agent streams.',
      children: {
        get: "One agent by path (absolute, or relative to the calling scope).",
        list: "Known agents (from the collection processor's reduced state).",
        liveState: "The collection processor's reduced agent database.",
        processor: "The collection's hosted stream processor.",
      },
      parent: "a project itx (itx.agents)",
    });
  }

  get #durableObjectStub() {
    return env.AGENT_COLLECTION.getByName(
      DurableObjectNameCodec.stringify({
        projectId: this.props.projectId,
        path: AGENT_COLLECTION_PATH,
      }),
    );
  }

  get processor(): WakeableStreamProcessorRpc<AgentCollectionProcessorState> {
    return new ProcessorRelayRpcTarget<AgentCollectionProcessorState>({
      auth: this.props.auth,
      // Workers generates the concrete AgentCollection DO stub, while the
      // shared relay accepts the smaller processor-host surface. The DO owns
      // that surface; the double assertion only bridges those generated and
      // generic RPC types.
      host: () => this.#durableObjectStub as unknown as ProcessorHostStub,
    });
  }

  get liveState(): LiveStateRpc<AgentCollectionProcessorState> {
    return new LiveStateRelayRpcTarget<AgentCollectionProcessorState>(
      () => this.#durableObjectStub,
    );
  }

  /** Stateless push sink: forwarding and authorization are its entire job. */
  processEvent(batch: StreamPushEventBatch): Promise<void> {
    if (this.props.auth.principal !== "trusted-internal") {
      throw new Error("agents.processEvent is dialed by stream push subscriptions, not sessions");
    }
    return Promise.resolve(this.#durableObjectStub.processEvent(batch));
  }

  constructor(
    readonly props: {
      auth: ItxAuth;
      ctx: CfExecutionContext;
      projectId: string;
      /**
       * The scope path of the itx this collection was reached through — the
       * "current actor". Relative `get()` paths resolve against it, and
       * `message()` on the returned agents stamps it as the sender when it
       * is an agent path. Captured at itx mint time (itxForScope), so it is
       * a property of the tree, not of per-call auth.
       */
      sourceScopePath?: string;
    },
  ) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  /**
   * The agent control surface at a path (`"/agents/<name>"`, or relative to
   * the calling scope — `".."` climbs). The returned handle is a plain,
   * unproxied RpcTarget ON PURPOSE, so callers can PIPELINE onto this call —
   * `itx.agents.get(path).message(text)` or `.someTool(args)` in one
   * expression for an already-created agent — over workerd RPC (the script
   * lane); dynamic members resolve through the prototype-chain fallback. See
   * AgentRpcTarget's class comment for the mechanism and
   * `agent-handle-pipelining.itx.e2e.test.ts` for the guard.
   */
  get(path: string): AgentRpcTarget {
    const resolved = resolveAgentPath(path, this.props.sourceScopePath);
    return new AgentRpcTarget({
      auth: this.props.auth,
      capabilityHost: new CapabilityHostRpcTarget({
        auth: this.props.auth,
        ctx: this.props.ctx,
        path: resolved,
        projectId: this.props.projectId,
      }),
      ctx: this.props.ctx,
      projectId: this.props.projectId,
      ...(this.props.sourceScopePath === undefined
        ? {}
        : { sourceScopePath: this.props.sourceScopePath }),
    });
  }

  /** Known agents, read from the collection processor's reduced database. */
  async list(): Promise<StreamListItem[]> {
    const { state } = await this.processor.snapshot();
    return Object.values(state.agents).map((agent) => ({
      path: agent.path,
      createdAt: agent.timestamps.createdAt,
    }));
  }
}

/**
 * Human-facing project facts for an agent's boot context, best-effort from
 * the project directory: name, slug, and the served worker URL (via the
 * canonical builder, so loopback bases keep their scheme/port and wildcard
 * bases normalize). Absent (id-only boot line) when the directory has no
 * record yet — never a birth blocker.
 */
async function agentBootProjectFacts(
  projectId: string,
): Promise<{ project?: { name: string; slug: string; workerUrl?: string } }> {
  const record = await readProjectById(env.PROJECT_DIRECTORY, projectId).catch(() => null);
  if (record === null) return {};
  const config = parseConfig(env);
  const workerUrl = buildProjectWorkerUrl({
    projectSlug: record.slug,
    projectHostnameBases: config.projectHostnameBases,
    ...(config.baseUrl === undefined ? {} : { appBaseUrl: config.baseUrl }),
  });
  return {
    project: {
      name: record.name,
      slug: record.slug,
      ...(workerUrl === null ? {} : { workerUrl }),
    },
  };
}

/**
 * One address-first sandbox handle. Addressing never creates or even chooses
 * a container namespace. `create(input)` claims the path in the catalogue,
 * lets the selected Durable Object append and reduce its own birth batch, and
 * returns this handle. Every later SDK call resolves the durable claim and is
 * receiver-preservingly replayed onto the real Cloudflare Sandbox stub.
 */
class SandboxRpcTarget extends IterateRpcTarget<"Sandbox"> {
  constructor(readonly props: { auth: ItxAuth; path: string; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
    assertSandboxPath(props.path);
  }

  get #catalogue() {
    return env.STREAM.getByName(
      DurableObjectNameCodec.stringify({ projectId: this.props.projectId, path: "/sandboxes" }),
    );
  }

  #stub(instanceType: SandboxInstanceType) {
    const binding = SANDBOX_INSTANCE_TYPE_BINDINGS[instanceType].binding as keyof typeof env;
    const namespace = env[binding] as DurableObjectNamespace<SandboxDurableObject>;
    return namespace.getByName(
      DurableObjectNameCodec.stringify({ projectId: this.props.projectId, path: this.props.path }),
    );
  }

  async #claim(): Promise<{ instanceType: SandboxInstanceType } | undefined> {
    const event = await this.#catalogue.getEvent({
      idempotencyKey: sandboxCreateClaimKey(this.props.path),
    });
    if (event === undefined) return undefined;
    return {
      instanceType: SandboxInstanceType.parse(
        (event.payload as { instanceType: string }).instanceType,
      ),
    };
  }

  async #claimedStub() {
    const claim = await this.#claim();
    if (claim === undefined) {
      throw new Error(
        `sandbox "${this.props.path}" does not exist — create it with itx.sandboxes.get(${JSON.stringify(this.props.path)}).create({})`,
      );
    }
    return this.#stub(claim.instanceType);
  }

  async #usableStub() {
    const stub = await this.#claimedStub();
    await stub.assertCreated({ path: this.props.path, projectId: this.props.projectId });
    return stub;
  }

  async __describe(): Promise<Description> {
    const claim = await this.#claim();
    if (claim === undefined) {
      return describeNode({
        instructions: `A not-yet-created sandbox handle at "${this.props.path}". Call create({ instanceType?, sleepAfter?, keepAlive?, env? }) before using the Cloudflare Sandbox SDK surface.`,
        children: { create: "Create this sandbox and return this handle." },
        parent: "sandboxes.get(path)",
      });
    }
    return (await replayPathCall(await this.#usableStub(), {
      args: [],
      path: ["__describe"],
    })) as Description;
  }

  /** Claim, birth, and configure this sandbox; identical re-entry returns this handle. */
  async create(input: SandboxCreateInput = {}): Promise<SandboxRpcTarget> {
    const requestedClaim = sandboxCreateClaimEvent({ create: input, path: this.props.path });
    const instanceType = requestedClaim.payload.instanceType;
    const [claim] = await this.#catalogue.append(requestedClaim);
    if (claim === undefined) {
      throw new Error(`sandbox "${this.props.path}": the catalogue append returned no event`);
    }
    const parsedClaim = SandboxProcessorContract.parseEvent(claim);
    if (parsedClaim.type !== "events.iterate.com/sandbox/create-requested") {
      throw new Error(
        `sandbox "${this.props.path}": catalogue claim has unexpected type "${parsedClaim.type}"`,
      );
    }
    if (parsedClaim.payload.path !== this.props.path) {
      throw new Error(
        `sandbox "${this.props.path}": catalogue claim points at "${parsedClaim.payload.path}"`,
      );
    }
    if (parsedClaim.payload.instanceType !== instanceType) {
      throw new Error(
        `sandbox "${this.props.path}" was already requested as instance type "${parsedClaim.payload.instanceType}" — names are unique per project; pick a new path`,
      );
    }
    const claimedEnv =
      parsedClaim.payload.env === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(parsedClaim.payload.env).map(([key, value]) => [
              key,
              value ?? undefined,
            ]),
          );
    await this.#stub(instanceType).create({
      env: claimedEnv,
      instanceType,
      keepAlive: parsedClaim.payload.keepAlive,
      path: this.props.path,
      projectId: this.props.projectId,
      sleepAfter: parsedClaim.payload.sleepAfter,
    });
    return this;
  }

  /** The sandbox's hosted lifecycle reducer. */
  get processor(): WakeableStreamProcessorRpc<SandboxProcessorState> {
    return new ProcessorRelayRpcTarget<SandboxProcessorState>({
      auth: this.props.auth,
      host: async () => (await this.#claimedStub()) as unknown as ProcessorHostStub,
    });
  }

  /** Push-driven reduced lifecycle state, including after permanent destroy. */
  get liveState(): LiveStateRpc<SandboxProcessorState> {
    return new LiveStateRelayRpcTarget<SandboxProcessorState>(
      async () =>
        (await this.#claimedStub()) as unknown as LiveStateDurableObjectStub<SandboxProcessorState>,
    );
  }

  start(): Promise<void> {
    return this.invokeCapability({ args: [], path: ["start"] }) as Promise<void>;
  }

  sleep(): Promise<void> {
    return this.invokeCapability({ args: [], path: ["sleep"] }) as Promise<void>;
  }

  restart(): Promise<void> {
    return this.invokeCapability({ args: [], path: ["restart"] }) as Promise<void>;
  }

  destroy(): Promise<void> {
    return this.invokeCapability({ args: [], path: ["destroy"] }) as Promise<void>;
  }

  kill(): Promise<void> {
    return this.invokeCapability({ args: [], path: ["kill"] }) as Promise<void>;
  }

  exec(
    command: string,
    options?: {
      cwd?: string;
      encoding?: string;
      env?: Record<string, string | undefined>;
      timeout?: number;
    },
  ): Promise<{
    success: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
    command: string;
    duration: number;
    timestamp: string;
    sessionId?: string;
  }> {
    return this.invokeCapability({
      args: options === undefined ? [command] : [command, options],
      path: ["exec"],
    }) as Promise<{
      success: boolean;
      exitCode: number;
      stdout: string;
      stderr: string;
      command: string;
      duration: number;
      timestamp: string;
      sessionId?: string;
    }>;
  }

  /** Replay any undeclared Cloudflare Sandbox SDK path onto the claimed stub. */
  async invokeCapability(call: { args: unknown[]; path: string[] }): Promise<unknown> {
    return await replayPathCall(await this.#usableStub(), call);
  }
}

/** Path-addressed sandbox catalogue. `get` is pure addressing; creation lives on the handle. */
class SandboxCollectionRpcTarget extends IterateRpcTarget<"SandboxCollection"> {
  constructor(readonly props: { auth: ItxAuth; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        'The project\'s path-addressed Linux sandboxes. get("/sandboxes/<name>") returns a possibly nonexistent handle; call handle.create({ instanceType?, sleepAfter?, keepAlive?, env? }) before the Cloudflare Sandbox SDK surface. Instance types are fixed for life.',
      children: {
        get: "A possibly nonexistent sandbox handle; addressing does not create.",
        list: "Every sandbox stream path, including destroyed sandboxes.",
      },
      parent: "a project itx (itx.sandboxes)",
    });
  }

  get(path: string): SandboxRpcTarget {
    return new SandboxRpcTarget({
      auth: this.props.auth,
      path: assertSandboxPath(path),
      projectId: this.props.projectId,
    });
  }

  list(): Promise<StreamListItem[]> {
    return projectProcessorState(this.props.projectId).then((state) =>
      state.streams.filter((stream) => stream.path.startsWith("/sandboxes/")),
    );
  }
}

/**
 * Catalog of durable workspaces within one project: EVENT-SOURCED,
 * MOUNT-ROUTED workspace filesystems (Durable-Object-hosted, no container,
 * always warm). Every workspace is addressed by its FULL path under
 * `/workspaces/` — the same domain-prefix convention as `/sandboxes/...` and
 * `/repos/...`: an agent's workspace is the agent path under the prefix
 * (`/workspaces/agents/...`, exposed as `itx.workspace` in that agent's
 * scope), and standalone workspaces live under `/workspaces/<anything>`.
 *
 * A workspace's identity + configuration are stream facts. `get(path)` only
 * addresses a handle; `get(path).create({ mounts? })` appends the atomic birth
 * batch. Every birth-requiring method fails loudly until that explicit create.
 */
class WorkspaceCollectionRpcTarget extends IterateRpcTarget<"WorkspaceCollection"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        'Event-sourced, mount-routed workspaces. get("/workspaces/<name>") returns a handle without creating anything; call handle.create({ mounts? }) once before use. Birth always mounts the config repo at "/" with commit-to-main policy; supplied mounts are committed atomically as an initial configured patch on top. An agent\'s own workspace is its agent path under the prefix (what itx.workspace resolves to).',
      children: {
        get: "A possibly nonexistent workspace handle; call get(path).create({ mounts? }) before use.",
      },
      parent: "a project itx (itx.workspaces)",
    });
  }

  constructor(readonly props: { auth: ItxAuth; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  /** A workspace handle at a path. Addressing never creates it. */
  get(path: string): WorkspaceRpcTarget {
    return new WorkspaceRpcTarget({
      auth: this.props.auth,
      path: normalizeWorkspacePath(path),
      projectId: this.props.projectId,
    });
  }
}

/**
 * One durable workspace: an event-sourced, mount-routed private filesystem.
 * Its mount table (getConfig/configure) maps repos into the tree: reads under
 * a mount fall through to that repo's main at HEAD, writes land in a private
 * copy-on-write local layer (large files spill to R2 transparently), and
 * `git.commit({ scope })` turns ONE mount's changes into one commit on that
 * repo's main (honoring the mount's policy). Paths outside every mount are
 * private scratch. The `.git` name is reserved (platform-managed).
 */
class WorkspaceRpcTarget extends IterateRpcTarget<"Workspace"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions: `A workspace at "${this.props.path}" (event-sourced, mount-routed). Its mount table (getConfig/configure) maps repos into the tree — by default the config repo is mounted at "/", so reads see the repo's latest main until a local write shadows a path. Writes stay in a private overlay; git.commit({ message, scope? }) commits ONE mount's changes to that repo's main (read-only mounts reject commits; scope is optional when one mount is dirty). Paths outside every mount are private scratch.`,
      children: {
        create:
          "Create this workspace with the default config-repo root mount plus any supplied mounts; waits through the atomic birth batch and returns this handle.",
        configure:
          "Patch configuration ({ config: { mounts } }) — deep-merged per mount point: unknown keys add mounts, partial values edit one mount, null removes one. Appends workspace/configured.",
        deleteFile: "Delete one file (whiteouts a mount copy; false when it did not exist).",
        edit: "Replace an exact string in one file (copies a mount file up first); private until committed.",
        exists: "Whether a path exists in the merged view.",
        getConfig: "The folded configuration (birth certificate + configured patches).",
        git: "Per-mount git surface: status (changes grouped by mount), commit ({ message, scope? }), log ({ scope? }).",
        glob: "Merged file paths matching a glob pattern.",
        kill: "Restart the workspace's server-side object; the next request boots it fresh.",
        listAllFiles: "Every file path in the merged view (local layer + every mount, sorted).",
        processor: "The workspace stream processor (snapshot/state).",
        readFile: "One file's contents; null when missing.",
        readFileBytes: "One file's raw bytes; null when missing (use for binaries).",
        reset:
          "Wipe the local layer and deletions — back to a pristine view of the mounts. Uncommitted work is LOST.",
        revert: "Un-pin ONE path: drop the local copy/deletion so it follows its mount again.",
        whoami: "Workspace identity string (debug).",
        writeFile: "Write one file into the private overlay.",
        writeFileBytes: "Write raw bytes to one file.",
      },
      parent: "workspaces.get(path); an agent's own workspace is itx.workspace",
    });
  }

  constructor(readonly props: { auth: ItxAuth; path: string; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  /** @internal */
  get durableObjectStub() {
    return env.WORKSPACE_V2.getByName(
      DurableObjectNameCodec.stringify({
        path: this.props.path,
        projectId: this.props.projectId,
      }),
    );
  }

  get #stream(): StreamRpcTarget {
    return new StreamRpcTarget({
      auth: this.props.auth,
      path: this.props.path,
      projectId: this.props.projectId,
    });
  }

  /** Explicitly create this workspace and wait through its complete birth batch. */
  async create(
    input: { mounts?: Record<string, WorkspaceMount> } = {},
  ): Promise<WorkspaceRpcTarget> {
    const committed = await this.#stream.append(
      ...workspaceCreationEvents({
        ...(input.mounts === undefined ? {} : { mounts: input.mounts }),
        path: this.props.path,
        projectId: this.props.projectId,
      }),
    );
    const offset = committed.reduce((maximum, event) => Math.max(maximum, event.offset), 0);
    if (offset === 0) throw new Error("workspace create committed no events");
    await this.processor.waitUntilProcessed({
      offset,
      timeoutMs: PROCESSOR_BIRTH_WAIT_TIMEOUT_MS,
    });
    return this;
  }

  whoami(): Promise<string> {
    return Promise.resolve(this.durableObjectStub.whoami());
  }

  /** Restart the workspace's server-side object; the next request boots it fresh. */
  kill(): Promise<void> {
    return Promise.resolve(this.durableObjectStub.kill());
  }

  /** The workspace stream processor (snapshot/state). */
  get processor(): WakeableStreamProcessorRpc<WorkspaceProcessorState> {
    return new ProcessorRelayRpcTarget<WorkspaceProcessorState>({
      auth: this.props.auth,
      host: () => this.durableObjectStub as unknown as ProcessorHostStub,
    });
  }

  /** The folded configuration (birth certificate + configured patches). */
  getConfig(): Promise<WorkspaceConfig> {
    return this.durableObjectStub.getConfig();
  }

  /** Patch configuration — deep-merged per mount point; null removes a mount (appends workspace/configured). */
  configure(input: { config: WorkspaceConfigPatch }): Promise<WorkspaceConfig> {
    return this.durableObjectStub.configure(input);
  }

  /** One file's contents from the merged view (overlay, then owning mount at HEAD); null when missing. */
  readFile(path: string): Promise<string | null> {
    return this.durableObjectStub.readFile(path);
  }

  /** One file's raw bytes from the merged view; null when missing. */
  readFileBytes(path: string): Promise<Uint8Array | null> {
    return this.durableObjectStub.readFileBytes(path);
  }

  /** Whether a path exists in the merged view. */
  exists(path: string): Promise<boolean> {
    return this.durableObjectStub.exists(path);
  }

  /** Write one file into the private overlay. */
  writeFile(path: string, content: string): Promise<void> {
    return this.durableObjectStub.writeFile(path, content);
  }

  /** Write raw bytes to one file in the private overlay. */
  writeFileBytes(path: string, data: Uint8Array): Promise<void> {
    return this.durableObjectStub.writeFileBytes(path, data);
  }

  /** Replace an exact string in one file (copies a mount file up first). */
  edit(input: EditWorkspaceFileInput): Promise<EditWorkspaceFileResult> {
    return this.durableObjectStub.edit(input);
  }

  /** Delete one file (whiteouts a mount copy; false when it did not exist). */
  deleteFile(path: string): Promise<boolean> {
    return this.durableObjectStub.deleteFile(path);
  }

  /** Every file path in the merged view (local layer + every mount at HEAD, sorted). */
  listAllFiles(): Promise<string[]> {
    return this.durableObjectStub.listAllFiles();
  }

  /** Merged file paths matching a glob pattern. */
  glob(pattern: string): Promise<string[]> {
    return this.durableObjectStub.glob(pattern);
  }

  /** Wipe the local layer and deletions — back to a pristine view of the mounts. Uncommitted work is LOST. */
  reset(): Promise<void> {
    return this.durableObjectStub.reset();
  }

  /** Un-pin ONE path: drop the local copy/deletion so it follows its mount again. */
  revert(path: string): Promise<void> {
    return this.durableObjectStub.revert(path);
  }

  /** Per-mount git surface. */
  get git(): WorkspaceGitRpcTarget {
    return new WorkspaceGitRpcTarget(this.props);
  }
}

/**
 * The per-mount git surface of a workspace. `status()` groups the overlay's
 * changes by owning mount (plus the never-committable unmounted scratch);
 * `commit({ message, scope? })` turns ONE mount's changes into one ordinary
 * commit on that repo's main via its own `commitFiles` lane — scope may be
 * omitted when exactly one mount is dirty, and commits never span mounts.
 * Read-only mounts reject commits. No branches, no push: commit = live on
 * that repo's main.
 */
class WorkspaceGitRpcTarget extends IterateRpcTarget<"WorkspaceGit"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions: `Per-mount git surface of the workspace at "${this.props.path}". status() groups changes by owning mount; commit({ message, scope? }) commits ONE mount's changes to that repo's main (scope optional when exactly one mount is dirty; read-only mounts reject); log({ scope? }) reads a mount's repo history. No branches, no push: commit = live on that repo's main.`,
      children: {
        commit: "Commit one mount's changes to its repo's main ({ message, scope?, author? }).",
        log: "One mount's repo history, newest first ({ scope?, limit? }).",
        status: "Changes grouped by owning mount, plus the unmounted local scratch.",
      },
      parent: "a workspace (workspace.git)",
    });
  }

  constructor(readonly props: { auth: ItxAuth; path: string; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  /** @internal */
  get durableObjectStub() {
    return env.WORKSPACE_V2.getByName(
      DurableObjectNameCodec.stringify({
        path: this.props.path,
        projectId: this.props.projectId,
      }),
    );
  }

  /** Changes grouped by owning mount, plus the unmounted local scratch. */
  status(): Promise<WorkspaceStatus> {
    return this.durableObjectStub.gitStatus();
  }

  /** Commit one mount's changes to its repo's main branch. */
  commit(input: WorkspaceCommitInput): Promise<WorkspaceCommitResult> {
    return this.durableObjectStub.gitCommit(input);
  }

  /** One mount's repo history, newest first. */
  log(input?: WorkspaceGitLogInput): Promise<WorkspaceGitLogEntry[]> {
    return this.durableObjectStub.gitLog(input);
  }
}

/** Secret catalog within one project. */
class SecretCollectionRpcTarget extends IterateRpcTarget<"SecretCollection"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        "Secret catalog: get(path) / list() / collectFromUser(input). Secret VALUES never transit this surface — they substitute into egress requests server-side.",
      children: {
        collectFromUser:
          "Mint a deep link where the user enters a secret value themselves ({ path, egress, description? } → { path, url }); an agent caller is messaged when they submit.",
        get: "The secret at a path.",
        list: "Known secrets (from project state).",
      },
      parent: "a project itx (itx.secrets)",
    });
  }

  constructor(readonly props: { auth: ItxAuth; projectId: string; scopePath: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  /** The secret at a path. */
  get(path: string): SecretRpcTarget {
    return new SecretRpcTarget({
      auth: this.props.auth,
      path: normalizeSecretPath(path),
      projectId: this.props.projectId,
    });
  }

  /**
   * Mint a deep link where the USER enters a secret value themselves — the
   * door for credentials an agent must never see in chat. The page (a
   * minimal, chrome-free form) shows the description and the egress origins
   * the value is pinned to; on submit it stores material + egress in one
   * update, so the secret is born already pinned. When the caller is an
   * agent scope, the page also messages that agent ("The user submitted the
   * secret at …"), which starts its next turn — send the URL to the user,
   * end the turn, and act on the notification. Nothing is created until the
   * user submits; the link itself is stateless. Works for EXISTING secrets
   * too — the page warns before replacing — so it is also the way to rotate
   * a credential (e.g. one the user pasted into chat and should roll).
   */
  async collectFromUser(input: CollectSecretInput): Promise<CollectSecretLink> {
    const path = normalizeSecretPath(input.path);
    if (!path.isWellFormed()) {
      throw new Error("collectFromUser paths must be well-formed strings (no lone surrogates).");
    }
    if (input.egress.urls.length === 0) {
      throw new Error(
        "collectFromUser needs at least one egress URL: the user is shown where the value can ever be sent, and a secret pinned to nothing can never be used.",
      );
    }
    // Pin to ORIGINS, not URLs. Enforcement (assertOriginPinned) only ever
    // compares origins, so a pin of "https://api.acme.com/safe" would in fact
    // authorize the whole origin — the page must not display a promise
    // narrower than what is enforced. Normalizing here also dedupes. Userinfo
    // is rejected: it would ride a plaintext, shareable chat URL while
    // origin-pinning ignores it anyway. Bad input fails on the caller that can
    // fix it, not as a raw "Invalid URL" in the user's face at submit time.
    const egressOrigins = [
      ...new Set(
        input.egress.urls.map((url) => {
          const parsed = URL.canParse(url) ? new URL(url) : null;
          if (parsed === null || !/^https?:$/.test(parsed.protocol)) {
            throw new Error(
              `collectFromUser egress URLs must be absolute http(s) URLs; got ${JSON.stringify(url)}.`,
            );
          }
          if (parsed.username !== "" || parsed.password !== "") {
            throw new Error(
              `collectFromUser egress URLs must not carry credentials; got ${JSON.stringify(url)}.`,
            );
          }
          return parsed.origin;
        }),
      ),
    ];
    const project = await readProjectById(env.PROJECT_DIRECTORY, this.props.projectId);
    if (!project?.slug) {
      throw new Error(`Project ${this.props.projectId} has no slug; cannot build a page URL.`);
    }
    // Unlike read-only viewer links, this link WRITES a secret — never fall
    // back to a default host that could belong to a different deployment.
    const baseUrl = parseConfig(env).baseUrl;
    if (baseUrl === undefined) {
      throw new Error("collectFromUser needs APP_CONFIG_BASE_URL to build the page URL.");
    }
    const scopePath = this.props.scopePath;
    const url = buildCollectSecretUrl({
      baseUrl,
      projectSlug: project.slug,
      search: {
        path,
        egress: egressOrigins,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(scopePath.startsWith("/agents/") ? { notify: scopePath } : {}),
      },
    });
    return { path, url };
  }

  /** Known secrets, read from the project processor's reduced state. */
  list(): Promise<StreamListItem[]> {
    return projectProcessorState(this.props.projectId).then((state) => state.secrets);
  }
}

/** Path-addressed secret capability. Secret material has no public read API:
 * material never leaves the Secret Durable Object except substituted into a
 * request bound for one of the secret's pinned egress hosts. */
class SecretRpcTarget extends IterateRpcTarget<"Secret"> {
  /** Like every other node, the secret's self-report IS `__describe()`: the
   * discovery Description merged with the secret's public SecretDescription
   * (audit, egress, whether material is present, the refresh strategy). The
   * raw value is never part of it. */
  async __describe(): Promise<Description & SecretDescription> {
    const state = await this.durableObjectStub.describe();
    return describeNode({
      instructions: `The secret at "${this.props.path}": __describe() for metadata (audit, egress, hasMaterial, refresh — never the value), update() to set value/egress/refresh, fetch() to use it in an egress request via placeholder substitution.`,
      children: {
        create:
          "Create this secret with its initial egress, material, and refresh config; returns this same secret handle.",
        fetch:
          "Egress fetch with secret placeholders substituted server-side (HTTP headers/URL, including Upgrade handshake).",
        kill: "Restart the secret's server-side object; the next request boots it fresh.",
        reveal:
          "Read the material back — only for a secret born readable (the project ingress key); write-only secrets throw.",
        update:
          "Set the value, egress URLs, and/or refresh strategy. A value requires its complete egress policy in the same update; every update without a value clears stored material.",
      },
      parent: "itx.secrets.get(path)",
      ...state,
    });
  }

  constructor(readonly props: { auth: ItxAuth; path: string; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  /** @internal */
  get durableObjectStub() {
    return env.SECRET.getByName(
      DurableObjectNameCodec.stringify({
        projectId: this.props.projectId,
        path: normalizeSecretPath(this.props.path),
      }),
    );
  }

  /** Egress fetch with this secret's placeholders substituted server-side. */
  fetch(request: Request): Promise<Response> {
    return this.durableObjectStub.fetch(request);
  }

  /** Restart the secret's server-side object; the next request boots it fresh. */
  kill(): Promise<void> {
    return Promise.resolve(this.durableObjectStub.kill());
  }

  /**
   * Create this secret and wait until its processor has reduced the birth
   * certificate, then return this same secret handle, so create chains. The
   * Secret Durable Object owns the birth semantics: it encrypts the material
   * bound to the exact commit offset and appends `secret/created` plus the
   * secret's processor subscription in one atomic batch. An identical-policy
   * retry over an existing secret resolves fine (material is write-only and
   * not comparable — it is kept, never replaced; rotate through `update()`);
   * a create with a DIFFERENT egress/refresh/visibility policy fails loudly.
   */
  async create(input: SecretCreateInput): Promise<SecretRpcTarget> {
    await this.durableObjectStub.create(input);
    return this;
  }

  /**
   * Read the material back — only for a secret born `readable: true` (an
   * immutable birth-certificate fact; every other secret stays write-only
   * and this throws). The born project ingress key at
   * /secrets/project-api-key is the canonical readable secret: show it to an
   * external app as often as needed.
   */
  reveal(): Promise<unknown> {
    return this.durableObjectStub.reveal();
  }

  /** Set secret material, its egress allowlist, and/or refresh strategy.
   * Replacement material requires its complete egress policy in the same
   * update. Every update without replacement material clears stored material. */
  update(input: SecretUpdateInput): Promise<StreamEvent> {
    return this.durableObjectStub.update(input);
  }

  /** The secret stream processor; its public state IS the SecretDescription. */
  get processor(): WakeableStreamProcessorRpc<SecretDescription> {
    return new ProcessorRelayRpcTarget<SecretDescription>({
      auth: this.props.auth,
      host: () => this.durableObjectStub as unknown as ProcessorHostStub,
    });
  }

  /** The secret's live state — its public SecretDescription (never the ciphertext). See {@link LiveStateRpc}. */
  get liveState(): LiveStateRpc<SecretDescription> {
    return new LiveStateRelayRpcTarget<SecretDescription>(
      () => this.durableObjectStub as unknown as LiveStateDurableObjectStub<SecretDescription>,
    );
  }
}

/** Enrolled mobile installations within one project. */
class DeviceCollectionRpcTarget extends IterateRpcTarget<"DeviceCollection"> {
  constructor(readonly props: { auth: ItxAuth; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        "Enrolled phone devices: list() discovers safe metadata; get(deviceId) returns the durable device whose append() requests notifications.",
      children: {
        get: "Get one device by stable installation id.",
        list: "List enrolled devices without exposing push credentials.",
      },
      parent: "a project itx (itx.devices)",
    });
  }

  get(deviceId: string): DeviceRpcTarget {
    assertDeviceId(deviceId);
    return new DeviceRpcTarget({
      auth: this.props.auth,
      deviceId,
      projectId: this.props.projectId,
    });
  }

  async list(): Promise<DeviceDescription[]> {
    const devices = (await projectProcessorState(this.props.projectId)).devices;
    return await Promise.all(
      devices.map((device) =>
        this.get(device.path.replace(/^\/devices\//, "")).durableObjectStub.describe(),
      ),
    );
  }
}

/** One enrolled installation. Push credentials enter only through enroll(). */
class DeviceRpcTarget extends IterateRpcTarget<"Device"> {
  constructor(readonly props: { auth: ItxAuth; deviceId: string; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  async __describe(): Promise<Description & DeviceDescription> {
    const state = await this.durableObjectStub.describe();
    return describeNode({
      instructions:
        `Device ${this.props.deviceId}: append a device/notification-requested event to notify it. ` +
        "enroll/revoke are authenticated phone lifecycle operations; no push credential is readable.",
      children: {
        append: "Append one or more typed notification request/opened facts.",
        enroll: "Enroll or rotate this authenticated user's Expo push token.",
        kill: "Restart the server-side device object.",
        revoke: "Disable push for this authenticated user's installation.",
      },
      parent: "itx.devices.get(deviceId)",
      ...state,
    });
  }

  /** @internal */
  get durableObjectStub() {
    return env.DEVICE.getByName(
      DurableObjectNameCodec.stringify({
        projectId: this.props.projectId,
        path: `/devices/${this.props.deviceId}`,
      }),
    );
  }

  /**
   * Enroll remains a named device-vocabulary door instead of generic create:
   * it first routes the private Expo push token into the device's Secret,
   * then appends the device certificate and processor subscription atomically
   * after that Secret offset. Re-enrollment rotates the credential without
   * rebirthing the Device.
   */
  enroll(input: DeviceEnrollInput): Promise<DeviceDescription> {
    return this.durableObjectStub.enroll({ ...input, ownerId: this.props.auth.principal });
  }

  append(...events: DeviceAppendInput[]): Promise<StreamEvent[]> {
    return this.durableObjectStub.append(...events);
  }

  revoke(reason: "disabled" | "permission-denied" | "sign-out"): Promise<StreamEvent> {
    return this.durableObjectStub.revoke(reason);
  }

  kill(): Promise<void> {
    return Promise.resolve(this.durableObjectStub.kill());
  }

  get processor(): WakeableStreamProcessorRpc<DeviceDescription> {
    return new ProcessorRelayRpcTarget<DeviceDescription>({
      auth: this.props.auth,
      host: () => this.durableObjectStub as unknown as ProcessorHostStub,
    });
  }

  get liveState(): LiveStateRpc<DeviceDescription> {
    return new LiveStateRelayRpcTarget<DeviceDescription>(
      () => this.durableObjectStub as unknown as LiveStateDurableObjectStub<DeviceDescription>,
    );
  }
}

function assertDeviceId(deviceId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(deviceId)) {
    throw new Error("deviceId must contain 1-128 letters, digits, underscores, or hyphens");
  }
}

type AiRunOptions = NonNullable<Parameters<Env["AI"]["run"]>[2]>;

/** One project file, addressed by path. */
class FileHandleRpcTarget extends IterateRpcTarget<"FileHandle"> {
  constructor(readonly props: { auth: ItxAuth; path: string; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        `The project file at "${this.props.path}": put({ data, contentType }) stores bytes ` +
        "(base64 strings, Uint8Array, Blob, or a stream), bytes() reads them back, " +
        "url() mints a signed public link (default 7 days), delete() removes the file.",
      parent: `files.get(${JSON.stringify(this.props.path)})`,
    });
  }

  /** Store bytes at this path (creates or overwrites). */
  put(input: { contentType?: string; data: FileData }): Promise<ProjectFileMetadata> {
    return putProjectFile({
      contentType: input.contentType,
      data: input.data,
      path: this.props.path,
      projectId: this.props.projectId,
    });
  }

  /** The file's bytes. Throws when no file exists at this path. */
  async bytes(): Promise<Uint8Array> {
    const file = await readProjectFile({ path: this.props.path, projectId: this.props.projectId });
    if (file === null) throw new Error(`No file at ${this.props.path}.`);
    return file.bytes;
  }

  /**
   * A signed public HTTPS URL for this file (default expiry 7 days). Anyone
   * holding the URL can fetch the bytes — share it in chat, feed it to
   * vision models, use it as an `<img src>`.
   */
  url(input?: { expiresInSeconds?: number }): Promise<string> {
    return mintProjectFileUrl({
      config: parseConfig(env),
      expiresInSeconds: input?.expiresInSeconds,
      path: this.props.path,
      projectId: this.props.projectId,
    });
  }

  async delete(): Promise<void> {
    await deleteProjectFile({ path: this.props.path, projectId: this.props.projectId });
  }
}

/**
 * Project file storage, R2-backed. Paths are project-scoped, mutable, and
 * last-write-wins; files attached to agent conversations live under the
 * agent's own path. Bytes are served to any HTTP client via signed URLs
 * (`FileHandle.url()`).
 */
class FilesRpcTarget extends IterateRpcTarget<"Files"> {
  constructor(readonly props: { auth: ItxAuth; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        "Project file storage (R2-backed). get(path) returns the file handle at a " +
        "project-scoped path (mutable, last-write-wins). Files attached to agent " +
        "conversations live under the agent's own path; `itx.agent.addFiles` is the " +
        "one-call helper that stores AND attaches.",
      children: { get: "The file handle at a path." },
      parent: "project itx",
    });
  }

  /** A handle for the file at `path` — a pure address, no I/O until called. */
  get(path: string): FileHandleRpcTarget {
    return new FileHandleRpcTarget({
      auth: this.props.auth,
      path: normalizePath(path),
      projectId: this.props.projectId,
    });
  }
}

/** Workers AI binding exposed through itx as a project/agent capability. */
class AiRpcTarget extends IterateRpcTarget<"Ai"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        "Cloudflare Workers AI: run(model, body) executes a model, models() lists the catalog, toMarkdown({ name, blob }) converts documents to Markdown. TEXT generation (summarize, draft, classify, answer) is the common case: run a 'Text Generation' model from models() with { messages: [{ role, content }, …] } and read result.response. First-party docs: Workers AI binding https://developers.cloudflare.com/workers-ai/configuration/bindings/ ; Markdown Conversion https://developers.cloudflare.com/workers-ai/features/markdown-conversion/ ; conversion options https://developers.cloudflare.com/workers-ai/features/markdown-conversion/conversion-options/ ; image model example https://developers.cloudflare.com/ai/models/%40cf/black-forest-labs/flux-2-klein-9b/ ; speech model example https://developers.cloudflare.com/ai/models/xai/grok-tts/ ; transcription example https://developers.cloudflare.com/ai/models/xai/grok-stt/ ; video model example https://developers.cloudflare.com/ai/models/xai/grok-imagine-video/ .",
      children: {
        models: "List available models.",
        run: "Run one model invocation.",
        toMarkdown:
          "Convert one document or an array of { name, blob } to Markdown; call with no args for supported formats.",
      },
      parent: "a project itx (itx.ai)",
    });
  }

  constructor(readonly props: { gateway?: AiRunOptions["gateway"] } = {}) {
    super();
  }

  /** List the Workers AI model catalog. */
  models(): Promise<unknown> {
    return Promise.resolve(env.AI.models());
  }

  /** Run one model invocation (`run("@cf/meta/llama-3.1-8b-instruct", { prompt })`).
   * Outputs are model-shaped: instantiate `run<T>` with the response shape you
   * read (`run<{ response?: string }>(…)`); uninstantiated it stays the honest
   * `unknown`. The optional third argument is the binding's own options object
   * — e.g. `{ gateway: { id: "default", skipCache: true } }` — passed through
   * to `env.AI.run`; its `gateway` wins over any constructor-provided one. */
  run<T = unknown>(model: string, body: unknown, options?: CfAiRunOptions): Promise<T> {
    const gateway = options?.gateway ?? this.props.gateway;
    const merged = gateway === undefined ? options : { ...options, gateway };
    return env.AI.run(
      model,
      body as Record<string, unknown>,
      merged as AiRunOptions | undefined,
    ) as Promise<T>;
  }

  /** Calling with no arguments lists the file formats the converter accepts. */
  toMarkdown(): Promise<CfMarkdownSupportedFormat[]>;
  /** Convert one document (`{ name, blob }`) to Markdown. */
  toMarkdown(
    document: CfMarkdownDocument,
    options?: CfMarkdownConversionOptions,
  ): Promise<CfMarkdownConversionResult>;
  /** Convert a batch of documents to Markdown; results come back in input order. */
  toMarkdown(
    documents: CfMarkdownDocument[],
    options?: CfMarkdownConversionOptions,
  ): Promise<CfMarkdownConversionResult[]>;
  toMarkdown(
    ...args: CfMarkdownConversionArgs
  ): Promise<
    CfMarkdownSupportedFormat[] | CfMarkdownConversionResult | CfMarkdownConversionResult[]
  > {
    if (args.length === 0) {
      return env.AI.toMarkdown().supported();
    }
    const [documents, options] = args;
    return env.AI.toMarkdown(documents as never, options as never) as Promise<
      CfMarkdownConversionResult | CfMarkdownConversionResult[]
    >;
  }
}

/** Cloudflare Browser Run binding exposed through itx. */
class CfBrowserCapabilityRpcTarget extends IterateRpcTarget<"CfBrowserCapability"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        'Cloudflare Browser Run binding. Use quickAction(action, options) for simple browser tasks: content, screenshot, pdf, markdown, snapshot, scrape, json, links, crawl. It returns the RESULT directly — const markdown = await itx.browser.quickAction("markdown", { url }) is a string; screenshot/pdf return bytes (Uint8Array) ready to attach to a chat message. Raw fetch(input, init) exposes the binding for CDP/library integrations. First-party docs: Browser Run https://developers.cloudflare.com/browser-run/ ; Quick Actions https://developers.cloudflare.com/browser-run/quick-actions/ ; Workers binding quickAction https://developers.cloudflare.com/changelog/post/2026-05-28-use-browser-run-quick-actions-directly-from-workers/ .',
      children: {
        fetch: "Raw Browser Run binding fetch for CDP/library use.",
        quickAction:
          'Run a Browser Run quick action and get its result directly: quickAction("markdown", { url }) returns the markdown string; quickAction("screenshot", { url, screenshotOptions }) returns image bytes.',
      },
      parent: "a project itx (itx.browser / itx.integrations.cf.browser)",
    });
  }

  /** Raw Browser Run fetch, primarily for libraries that connect over CDP. */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return env.BROWSER.fetch(input, init);
  }

  /**
   * Browser Run Quick Actions: content, screenshot, pdf, markdown, snapshot,
   * scrape, json, links, crawl. Returns the action's RESULT directly —
   * `quickAction("markdown", { url })` is the markdown string, structured
   * actions (links, json, scrape, …) are their parsed value, and binary
   * actions (screenshot, pdf) are bytes — instead of the binding's raw
   * Response, whose `{ success, result }` JSON envelope every caller was
   * unwrapping by hand (and the agent prompt's one-call recipe promised not
   * to need). A failed action throws with the envelope's error.
   */
  async quickAction(
    action: CfBrowserQuickAction,
    options: CfBrowserQuickActionOptions,
  ): Promise<string | Uint8Array | unknown> {
    const response = await (
      env.BROWSER as BrowserRun & {
        quickAction(action: string, options: Record<string, unknown>): Promise<Response>;
      }
    ).quickAction(action, options);
    return unwrapBrowserRunQuickAction(action, response);
  }
}

/** Cloudflare Images binding exposed through itx as one-call helpers. */
class CfImagesCapabilityRpcTarget extends IterateRpcTarget<"CfImagesCapability"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        "Cloudflare Images binding one-call helpers. Use info(imageStream) to inspect, or transform({ image, transforms, draws, output }) to resize/convert/watermark and receive a Response. First-party docs: Images binding https://developers.cloudflare.com/images/optimization/binding/ ; transformation features https://developers.cloudflare.com/images/optimization/features/ ; draw overlays https://developers.cloudflare.com/images/optimization/draw-overlays/ .",
      children: {
        info: "Inspect an image stream for format/dimensions/file size.",
        transform:
          "Apply ordered image transforms/draws and output a Response, e.g. transform({ image: resp.body, transforms: [{ width: 800 }], output: { format: 'image/webp' } }).",
      },
      parent: "itx.integrations.cf.images",
    });
  }

  /** Inspect an image stream for format/dimensions/file size. */
  info(image: ReadableStream<Uint8Array>): Promise<unknown> {
    return env.IMAGES.info(image);
  }

  /** Apply ordered image transforms/draws and output a Response. */
  async transform(input: CfImageTransformInput): Promise<Response> {
    let image = env.IMAGES.input(input.image);
    for (const transform of input.transforms ?? []) {
      image = image.transform(transform as ImageTransform);
    }
    for (const draw of input.draws ?? []) {
      let overlay = env.IMAGES.input(draw.image);
      for (const transform of draw.transforms ?? []) {
        overlay = overlay.transform(transform as ImageTransform);
      }
      image = image.draw(overlay, draw.options as ImageDrawOptions | undefined);
    }
    return (await image.output(input.output as ImageOutputOptions)).response();
  }
}

/** Cloudflare Media Transformations binding exposed through itx as one-call helpers. */
class CfVideosCapabilityRpcTarget extends IterateRpcTarget<"CfVideosCapability"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        "Cloudflare Media Transformations binding one-call helper for video. Use transform({ video, transform, output: { mode } }) to resize/crop and output video, frame, spritesheet, or audio as a Response. First-party docs: Media Transformations binding https://developers.cloudflare.com/stream/transform-videos/bindings/ ; transform videos https://developers.cloudflare.com/stream/transform-videos/ .",
      children: {
        transform:
          "Transform a video stream and return a Response, e.g. transform({ video: resp.body, transform: { width: 640, fit: 'scale-down' }, output: { mode: 'frame' } }).",
      },
      parent: "itx.integrations.cf.videos",
    });
  }

  /** Transform a video stream and return a Response (video, frame, spritesheet, or audio). */
  async transform(input: CfVideoTransformInput): Promise<Response> {
    const media = env.MEDIA.input(input.video);
    const result =
      input.transform === undefined
        ? media.output(input.output as MediaTransformationOutputOptions)
        : media
            .transform(input.transform as MediaTransformationInputOptions)
            .output(input.output as MediaTransformationOutputOptions);
    return await result.response();
  }
}

/** Grouped first-party Cloudflare platform bindings under integrations.cf. */
class CloudflareIntegrationsRpcTarget extends IterateRpcTarget<"CloudflareIntegrations"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        "Cloudflare first-party platform bindings grouped for agents: ai, browser, images, videos. These wrap env.AI, env.BROWSER, env.IMAGES, and env.MEDIA with project-scoped itx discovery. Each child __describe() links to the relevant Cloudflare docs.",
      children: {
        ai: "Workers AI: run(), models(), toMarkdown().",
        browser: "Browser Run: quickAction() and raw fetch().",
        images: "Images binding: info(), transform().",
        videos: "Media Transformations binding: transform().",
      },
      parent: "itx.integrations.cf",
    });
  }

  /** Workers AI: run(), models(), toMarkdown(). */
  get ai(): AiRpcTarget {
    return new AiRpcTarget();
  }

  /** Browser Run: quickAction() and raw fetch(). */
  get browser(): CfBrowserCapabilityRpcTarget {
    return new CfBrowserCapabilityRpcTarget();
  }

  /** Images binding: info(), transform(). */
  get images(): CfImagesCapabilityRpcTarget {
    return new CfImagesCapabilityRpcTarget();
  }

  /** Media Transformations binding: transform(). */
  get videos(): CfVideosCapabilityRpcTarget {
    return new CfVideosCapabilityRpcTarget();
  }
}

/**
 * The `__describe()` answer for one built-in connection node
 * (`itx.integrations.<slug>.get("<connection>")`). The SDK proxies replay dotted
 * paths onto a real vendor SDK, so there is no member map to reflect — the
 * description states what the node IS, one working example, and the calling
 * grammar: exactly what a scripting agent needs to shape its next call.
 */
function describeConnectionSdk(input: {
  connection: string;
  example: string;
  grammar: string;
  sdk: string;
  slug: string;
  types?: string;
}) {
  return describeNode({
    instructions: [
      `itx.integrations.${input.slug}.get(${JSON.stringify(input.connection)}) is ${input.sdk}.`,
      `Example: ${input.example}`,
      input.grammar,
    ].join("\n"),
    parent: `the integrations collection (itx.integrations.${input.slug})`,
    ...(input.types === undefined ? {} : { types: input.types }),
  });
}

/** A genuine RpcTarget for one selected connection. Keeping this as a real
 * target (instead of returning a function Proxy) makes
 * `integrations.github.get().octokit...` pipelinable through Cap'n Web. The
 * connection lookup is deferred until the first SDK call, so `get()` itself
 * stays synchronous even when it must discover the first connected account. */
class IntegrationConnectionRpcTarget extends RpcTarget {
  #resolvedConnection: Promise<string | null> | undefined;

  constructor(
    readonly props: {
      connection?: string;
      invoke(input: {
        args: unknown[];
        connection: string | null;
        method: string[];
        slug: string;
      }): Promise<unknown>;
      resolve(connection: string | undefined, slug: string): Promise<string | null>;
      slug: string;
    },
  ) {
    super();
  }

  async invokeCapability(call: { args?: unknown[]; path: string[] }): Promise<unknown> {
    this.#resolvedConnection ??= this.props.resolve(this.props.connection, this.props.slug);
    return await this.props.invoke({
      args: call.args ?? [],
      connection: await this.#resolvedConnection,
      method: call.path,
      slug: this.props.slug,
    });
  }
}

/** One integration family. `get(connection?)` is the only connection selector;
 * old bracket/property connection names intentionally are not supported. */
class IntegrationFamilyRpcTarget extends RpcTarget {
  constructor(readonly props: ConstructorParameters<typeof IntegrationConnectionRpcTarget>[0]) {
    super();
  }

  get(connection?: string): IntegrationConnectionRpcTarget {
    if (connection !== undefined && connection.trim() === "") {
      throw new Error(
        `itx.integrations.${this.props.slug}.get(connection) requires a non-empty slug.`,
      );
    }
    return new IntegrationConnectionRpcTarget({ ...this.props, connection });
  }

  async __describe(): Promise<unknown> {
    return describeNode({
      instructions: `Use itx.integrations.${this.props.slug}.get() for the first connected account, or .get("<connection-slug>") when a specific account matters. The returned connection is a pipelinable RPC capability.`,
      parent: "the integrations collection (itx.integrations)",
    });
  }
}

/** Iterate's fixed first-party PostHog stream receiver. */
class PostHogIntegrationRpcTarget extends RpcTarget {
  constructor(readonly props: { auth: ItxAuth; projectId: string }) {
    super();
    if (!isStreamDeliveryAuth(props.auth)) {
      throw new Error("PostHog ingestion is available only to stream delivery");
    }
  }

  async processEventBatch(batch: StreamPushEventBatch): Promise<void> {
    if (batch.projectId !== this.props.projectId) {
      throw new Error("PostHog stream delivery project does not match its itx authority");
    }
    const config = parseConfig(env).posthog;
    if (config === undefined) {
      throw new StreamReceiverUnavailableError("PostHog is not configured for this deployment");
    }
    await capturePosthogStreamEventBatch({
      apiKey: config.apiKey,
      batch,
      projectId: this.props.projectId,
      workerName: env.WORKER_SELF,
    });
  }
}

/**
 * The `itx.integrations` collection.
 *
 * Connection-yielding calls are `{slug}.get(connection?).{...method}`.
 * Public built-in families (`slack`, `gmail`, `github`, `telegram`, `waitrose`)
 * dispatch to deployment code —
 * `itx.integrations.slack.get().chat.postMessage({...})` reaches any Slack Web
 * API method (a real WebClient), `itx.integrations.gmail.get().request({...})`
 * the Gmail REST proxy, and `itx.integrations.github.get().octokit` is a
 * real Octokit — `.rest.apps.listReposAccessibleToInstallation()`, the
 * `.request("GET /repos/{owner}/{repo}")` escape hatch, `.graphql(...)`;
 * there is NO generic `.api.request({ method, path })` shape, and the
 * connection acts as a GitHub App INSTALLATION, so user-scoped
 * `...ForAuthenticatedUser` endpoints answer 403 — and every other slug
 * resolves through the itx capability table under the `integrations` prefix.
 * The exception is `itx.integrations.parallel`: a first-party API-key RPC
 * target, not a connection and not returned by `list()`. With no argument,
 * `get()` selects the first currently connected account in `list()` order.
 *
 * The SDK connection targets are thin dispatchers over the normal vendor
 * clients. A project extends the collection with ordinary
 * `provideCapability({ path: ["integrations", ...] })` — data, not deployment.
 * `completeConnect` is called by the app worker's
 * OAuth callback routes (/api/integrations/<provider>/callback); its
 * authority is the HMAC-signed OAuth state minted by startOAuthFlow,
 * verified itx-side.
 */
class ProjectIntegrationsRpcTarget extends IterateRpcTarget<"ProjectIntegrations"> {
  constructor(readonly props: { auth: ItxAuth; ctx: CfExecutionContext; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  // The project-root capability table: unknown slugs resolve there, and
  // list() reads its mounts.
  get #capabilityHost() {
    return env.CAPABILITY_HOST.getByName(
      DurableObjectNameCodec.stringify({ path: "/", projectId: this.props.projectId }),
    );
  }

  #family(slug: string): IntegrationFamilyRpcTarget {
    return new IntegrationFamilyRpcTarget({
      invoke: (input) => this.#invokeConnectionCapability(input),
      resolve: (connection, familySlug) => this.#resolveConnection(familySlug, connection),
      slug,
    });
  }

  #telegramProcessor(
    connection: string,
  ): ProcessorRelayRpcTarget<TelegramProcessorState, ProjectRouterProcessorHostStub> {
    return new ProcessorRelayRpcTarget<TelegramProcessorState, ProjectRouterProcessorHostStub>({
      auth: this.props.auth,
      host: () =>
        env.PROJECT.getByName(
          DurableObjectNameCodec.stringify({
            path: integrationConnectionStreamPath("telegram", connection),
            projectId: this.props.projectId,
          }),
        ) as unknown as ProjectRouterProcessorHostStub,
      processorFacade: (host) => host.telegramProcessor,
    });
  }

  /** Slack WebClient connections. `get()` selects the first connected workspace. */
  get slack(): IntegrationFamily<SlackConnection> {
    return this.#family("slack") as unknown as IntegrationFamily<SlackConnection>;
  }

  /** Connected Google accounts, exposed as Gmail. `get()` selects the first. */
  get gmail(): IntegrationFamily<GmailConnection> {
    return this.#family("gmail") as unknown as IntegrationFamily<GmailConnection>;
  }

  /** GitHub App installations with the normal all-in-one Octokit package. */
  get github(): IntegrationFamily<GithubConnection> {
    return this.#family("github") as unknown as IntegrationFamily<GithubConnection>;
  }

  /** Telegram Bot API connections. `get()` selects the first connected bot. */
  get telegram(): IntegrationFamily<TelegramConnection> {
    return this.#family("telegram") as unknown as IntegrationFamily<TelegramConnection>;
  }

  /** Waitrose account connections. */
  get waitrose(): IntegrationFamily<WaitroseConnection> {
    return this.#family("waitrose") as unknown as IntegrationFamily<WaitroseConnection>;
  }

  /** Parallel API, preconfigured with Iterate's platform API key. Not a connection. */
  get parallel(): OpenApiRpc {
    return parallelOpenApiTarget({
      egress: projectEgressFetcher(this.props.ctx.exports, this.props.projectId),
      parent: "a project itx (itx.integrations.parallel)",
    });
  }

  /** @internal Iterate's fixed first-party event feed. */
  get posthog(): PostHogIntegrationRpcTarget {
    return new PostHogIntegrationRpcTarget({
      auth: this.props.auth,
      projectId: this.props.projectId,
    });
  }

  /** Cloudflare first-party platform bindings: AI, Browser Run, Images, Media
   * Transformations. Like `parallel`, these ride the deployment's own
   * Cloudflare account — not a per-project connection. */
  get cf(): CloudflareIntegrationsRpcTarget {
    return new CloudflareIntegrationsRpcTarget();
  }

  /** Dynamic provided-integration dispatch. The only selector is
   * `<slug>.get(connection?)`; built-in families are concrete typed getters. */
  async invokeCapability(call: { args?: unknown[]; path: string[] }): Promise<unknown> {
    const { args = [], path } = call;
    const [slug, selector, ...rest] = path;
    if (slug && selector === "__describe" && rest.length === 0 && args.length === 0) {
      return await this.#capabilityHost.invokeCapability({
        path: ["integrations", slug, "__describe"],
      });
    }
    if (!slug || selector !== "get" || rest.length !== 0 || args.length > 1) {
      throw new Error(
        'Integration connections use `.get(connection?)`, for example `itx.integrations.github.get().octokit.rest.repos.get(...)` or `itx.integrations.github.get("work").octokit...`.',
      );
    }
    const connection = args[0];
    if (connection !== undefined && typeof connection !== "string") {
      throw new Error(`itx.integrations.${slug}.get(connection) expects a string connection slug.`);
    }
    return this.#family(slug).get(connection);
  }

  async #resolveConnection(slug: string, requested: string | undefined): Promise<string | null> {
    if (requested !== undefined) return requested;

    const providerSlug = slug === "gmail" ? "google" : slug;
    const candidates = (await this.list()).filter((entry) => entry.integration === slug);
    if (isBuiltinIntegrationSlug(providerSlug)) {
      // A Waitrose connection is its session secret, not a lifecycle journal;
      // appearing in list() is therefore the connected-state proof.
      if (providerSlug === "waitrose") {
        const first = candidates.find((entry) => entry.connection !== null);
        if (first) return first.connection;
      }
      for (const entry of candidates) {
        if (entry.connection === null) continue;
        const status = await getConnectionStatus({
          connection: entry.connection,
          projectId: this.props.projectId,
          provider: providerSlug,
        });
        if (status.connected) return entry.connection;
      }
      throw new Error(
        `No connected ${slug} account is available. Connect one or pass an exact slug to itx.integrations.${slug}.get("<connection-slug>").`,
      );
    }

    const first = candidates.find((entry) => entry.connection !== null);
    if (first) return first.connection;
    throw new Error(
      `No concrete ${slug} integration connection is available. Mount one under ["integrations", "${slug}", "<connection-slug>"] or pass an exact slug to .get("<connection-slug>").`,
    );
  }

  async #invokeConnectionCapability(input: {
    args: unknown[];
    connection: string | null;
    method: string[];
    slug: string;
  }): Promise<unknown> {
    const { args, connection, method, slug } = input;

    if (slug === "slack") {
      if (!connection || method.length === 0) {
        throw new Error(SLACK_CALL_GRAMMAR);
      }
      // Every node answers __describe() — the SDK proxies must not break that
      // promise by replaying it as a Web API path (a live agent stalled on
      // exactly this: the miss error taught it nothing).
      if (method.length === 1 && method[0] === "__describe") {
        return describeConnectionSdk({
          connection,
          example: `await itx.integrations.slack.get(${JSON.stringify(connection)}).chat.postMessage({ channel, text })`,
          grammar: SLACK_CALL_GRAMMAR,
          sdk: "a real Slack WebClient (@slack/web-api): any Web API method as a dotted path, always ONE body object argument",
          slug: "slack",
        });
      }
      // The connection's router processor: the project-class host Durable
      // Object at this connection's stream path. `processor` is a claimed
      // child, not a Web API replay — it is what the connect flow's wake
      // subscription persists (["integrations", "slack",
      // ["get", <connection>], "processor", "wakeStreamSubscriber"]).
      if (method[0] === "processor") {
        const relay = new ProcessorRelayRpcTarget({
          auth: this.props.auth,
          host: () =>
            env.PROJECT.getByName(
              DurableObjectNameCodec.stringify({
                path: `/integrations/slack/${connection}`,
                projectId: this.props.projectId,
              }),
            ) as unknown as ProjectRouterProcessorHostStub,
          processorFacade: (host) => host.slackProcessor,
        });
        if (method.length === 1) return relay;
        return await replayPathCall(relay, { args, path: method.slice(1) });
      }
      // The connection's wrapped Slack WebClient: replay the caller's dotted Web
      // API path onto it (chat.postMessage, conversations.list, …) — the real
      // SDK, its transport riding the connection secret's substituting egress
      // (slack-api.ts).
      const slack = connectionSlackClient({ connection, projectId: this.props.projectId });
      try {
        return await replayPathCall(slack, { args, path: method });
      } catch (error) {
        throw normalizeSlackError(error, connection);
      }
    }

    if (slug === "gmail") {
      if (connection && method.length === 1 && method[0] === "__describe") {
        return describeConnectionSdk({
          connection,
          example: `await itx.integrations.gmail.get(${JSON.stringify(connection)}).request({ path: "/users/me/messages", query: { maxResults: 10, q: "in:inbox" } })`,
          grammar:
            "itx.integrations.gmail.get(connection?).request({...}); paths are relative to https://gmail.googleapis.com/gmail/v1.",
          sdk: "the Gmail REST API behind gmail.request({ path, query, method, headers, body })",
          slug: "gmail",
        });
      }
      // gmail.request is two segments; fewer after the connection means the
      // caller skipped the connection (the pre-connections itx.gmail shape).
      if (!connection || method.length !== 1) {
        throw new Error(
          'itx.integrations.gmail.get(connection?).request({...}) is the Gmail surface (e.g. itx.integrations.gmail.get().request({ path: "/users/me/messages" })).',
        );
      }
      if (method[0] !== "request") {
        throw new Error(
          `itx.integrations.gmail.get(${JSON.stringify(connection)}) exposes request(...); got "${method.join(".")}".`,
        );
      }
      // No in-process token fetch — the Gmail call goes through project egress
      // with a placeholder Authorization header; after project policy permits
      // it, the Secret DO substitutes the access token and refreshes on 401.
      const connectionPath = googleConnectionSecretPath(connection);
      return await callGmailApi({
        authorization: `Bearer getSecret("${connectionPath}", { field: "accessToken" })`,
        projectId: this.props.projectId,
        request: args[0] as GmailRequestInput,
      });
    }

    if (slug === "github") {
      if (!connection || method.length === 0) {
        throw new Error(GITHUB_CALL_GRAMMAR);
      }
      if (method.length === 1 && method[0] === "__describe") {
        return describeConnectionSdk({
          connection,
          example: `await itx.integrations.github.get(${JSON.stringify(connection)}).octokit.rest.apps.listReposAccessibleToInstallation({ per_page: 5 })`,
          grammar: GITHUB_CALL_GRAMMAR,
          sdk: "the all-in-one Octokit exported by octokit, with Iterate supplying GitHub App installation auth and the request transport. Use the package's own types and https://github.com/octokit/octokit.js; normal `.rest`, `.graphql(...)`, and `.request(...)` calls work. Prefer REST for routine endpoints and GraphQL when its query shape or API coverage is useful. For pagination, RPC arguments must be serializable: call `.paginate(\"GET /...\", params)`; endpoint-function overloads, map callbacks, and `.paginate.iterator()` cannot cross the boundary. Installation-scoped calls work; user-scoped ...ForAuthenticatedUser endpoints answer 403. Octokit's retry and throttling plugins are disabled, so it does not replay 5xx, 429, or 408 responses; the secret transport may refresh credentials and repeat once after a 401. Inspect remote state before manually retrying an ambiguous failed write",
          slug: "github",
          types: 'export type GithubConnection = { octokit: import("octokit").Octokit };',
        });
      }
      if (method.length < 2 || method[0] !== "octokit") {
        throw new Error(GITHUB_CALL_GRAMMAR);
      }
      // The connection's mandatory `.octokit` namespace identifies the SDK;
      // replay the remaining dotted path onto the real Octokit. Its transport
      // rides the connection secret's substituting egress (github-api.ts).
      const octokit = connectionOctokit({ connection, projectId: this.props.projectId });
      try {
        return await replayPathCall(octokit, { args, path: method.slice(1) });
      } catch (error) {
        throw normalizeGithubError(error, connection);
      }
    }

    if (slug === "telegram") {
      if (!connection || method.length === 0) {
        throw new Error(TELEGRAM_CALL_GRAMMAR);
      }
      if (method.length === 1 && method[0] === "__describe") {
        return describeConnectionSdk({
          connection,
          example: `await itx.integrations.telegram.get(${JSON.stringify(connection)}).sendMessage({ chat_id, text })`,
          grammar: TELEGRAM_CALL_GRAMMAR,
          sdk: "the Telegram Bot API (https://core.telegram.org/bots/api): any method name as ONE dotted segment (sendMessage, sendPhoto, getMe, …) with ONE params object; the bot token is substituted at the egress door",
          slug: "telegram",
        });
      }
      // The connection's router processor: the project-class host Durable
      // Object at this connection's stream path — same relay shape as Slack's.
      // It is what the connect flow's wake subscription persists
      // (["integrations", "telegram", ["get", <connection>], "processor", ...]).
      if (method[0] === "processor") {
        const relay = this.#telegramProcessor(connection);
        if (method.length === 1) return relay;
        return await replayPathCall(relay, { args, path: method.slice(1) });
      }
      // The Bot API is flat — a deeper path means the caller invented a
      // namespace (telegram.get("bot").chat.sendMessage): answer with the grammar.
      if (method.length !== 1) throw new Error(TELEGRAM_CALL_GRAMMAR);
      return await callProjectTelegramBotApi({
        body: (args[0] ?? {}) as Record<string, unknown>,
        connection,
        method: method[0]!,
        projectId: this.props.projectId,
      });
    }

    if (slug === "waitrose") {
      if (!connection || method.length === 0) {
        throw new Error(WAITROSE_CALL_GRAMMAR);
      }
      if (method.length === 1 && method[0] === "__describe") {
        return describeConnectionSdk({
          connection,
          example: `await itx.integrations.waitrose.get(${JSON.stringify(connection)}).searchProducts("oat milk", { size: 5 })`,
          grammar: WAITROSE_CALL_GRAMMAR,
          sdk: 'the vendored Waitrose client (waitrose-api.ts): shoppingContext(), searchProducts(term, { size, sortBy, start }), trolley(orderId?), addToTrolley(lineNumber, quantity), removeFromTrolley(lineNumber), updateTrolleyItems(items, orderId?). Connect by creating the connection secret: await itx.secrets.get("/secrets/integrations/waitrose/<connection>/session").create({ egress: { urls: ["https://www.waitrose.com"] }, material: { username, password }, refresh: { kind: "waitrose-session", graphqlUrl: "https://www.waitrose.com/api/graphql-prod/graph/live" } }) — the Secret DO logs in on first use and re-logins on 401',
          slug: "waitrose",
        });
      }
      // The connection's vendored Waitrose client: replay the caller's method
      // path onto it — its transport rides the connection secret's
      // substituting egress (waitrose-api.ts), so a session token never
      // enters this isolate. Methods are flat; a deeper path means the caller
      // invented a namespace, and the client's own miss error answers it.
      const waitrose = connectionWaitroseClient({
        connection,
        projectId: this.props.projectId,
      });
      return await replayPathCall(waitrose, { args, path: method });
    }

    if (slug === "gmail" || BUILTIN_INTEGRATION_SLUGS.has(slug)) {
      throw new Error(
        `builtin integration "${slug}" has no dispatch branch — add one in ProjectIntegrationsRpcTarget.invokeCapability`,
      );
    }
    return await this.#capabilityHost.invokeCapability({
      args,
      path: ["integrations", slug, ...(connection === null ? [] : [connection]), ...method],
    });
  }

  /** Every connection the project holds: integration journals,
   * credential-defined Waitrose accounts, plus provided mounts from the
   * capability table (deduped by path). */
  async list(): Promise<IntegrationConnectionListEntry[]> {
    const [journalConnections, mounted, projectState] = await Promise.all([
      listIntegrationConnections(this.props.projectId),
      this.#capabilityHost.describeCapabilities(),
      projectProcessorState(this.props.projectId),
    ]);
    // Waitrose deliberately has no connect flow or lifecycle journal: its
    // session secret is the connection. Surface those secret paths in the
    // same collection so list() and no-argument get() retain one meaning.
    const waitroseConnections = projectState.secrets.flatMap((secret) => {
      const match = /^\/secrets\/integrations\/waitrose\/([^/]+)\/session$/.exec(secret.path);
      return match?.[1] === undefined
        ? []
        : [
            {
              connection: match[1],
              integration: "waitrose" as const,
              path: `/integrations/waitrose/${match[1]}`,
              source: "builtin" as const,
            },
          ];
    });
    const entries: IntegrationConnectionListEntry[] = [
      ...journalConnections.map((entry): IntegrationConnectionListEntry => {
        const { integration } = entry;
        return isBuiltinIntegrationSlug(integration)
          ? {
              ...entry,
              integration: integration === "google" ? "gmail" : integration,
              source: "builtin",
            }
          : { ...entry, source: "provided" };
      }),
      ...mounted
        .filter((capability) => capability.path[0] === "integrations" && capability.path[1])
        .map((capability) => ({
          // A depth-2 mount is integration-level: one recipe serving every
          // connection name beneath it.
          connection: capability.path[2] ?? null,
          integration: capability.path[1]!,
          path: `/${capability.path.join("/")}`,
          source: "provided" as const,
        })),
      ...waitroseConnections,
    ];
    // A provided integration can have both a mount and journals at the same
    // path (e.g. webhooks landing on /integrations/github/main); one entry.
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    return [...byPath.values()];
  }

  async __describe() {
    return describeNode({
      instructions: [
        "The project's integration connections, each at a fully qualified path /integrations/<slug>/<connection>.",
        "await itx.integrations.list() enumerates every connection (built-in and provided).",
        'For every connection family, get() selects the first connected account; pass get("<connection>") only when a specific account matters.',
        "Slack: await itx.integrations.slack.get().chat.postMessage({ channel, thread_ts, text }) — any Slack Web API method as a dotted path, always one body object.",
        'Gmail: await itx.integrations.gmail.get().request({ path: "/users/me/messages", query: { maxResults, q: "in:inbox" } }) — paths relative to https://gmail.googleapis.com/gmail/v1.',
        'GitHub: itx.integrations.github.get().octokit is the all-in-one Octokit from the `octokit` package, with Iterate supplying installation auth and transport. Use its package types and https://github.com/octokit/octokit.js; normal `.rest`, `.graphql(...)`, and `.request(...)` calls work, while pagination uses the RPC-safe `.paginate("GET /...", params)` route-string form. The `.octokit` segment is mandatory.',
        "Telegram: await itx.integrations.telegram.get().sendMessage({ chat_id, text }) — any Bot API method as ONE dotted segment with one params object (sendPhoto, sendChatAction, getMe, …).",
        'Waitrose: await itx.integrations.waitrose.get().searchProducts("oat milk", { size: 5 }) — the vendored grocery client (shoppingContext, trolley, addToTrolley, removeFromTrolley, updateTrolleyItems). Connect by writing the connection secret at /secrets/integrations/waitrose/<connection>/session ({ username, password } + the waitrose-session refresh strategy); see the connection\'s __describe() for the exact recipe.',
        "Parallel: await itx.integrations.parallel.__describe() loads Parallel's OpenAPI spec and lists flat operationId methods. It is not a connection and is not returned by list().",
        'Other names resolve through the PROJECT capability table: mount at the project root — await itx.capabilityHosts.get("/").provideCapability({ path: ["integrations", "<slug>"], ... }) — to add a project-owned integration with the same address shape. itx.provideCapability mounts on YOUR OWN scope, which itx.integrations.* dispatch does not consult (an agent-scope mount is unreachable here). Copy the known-good recipe from itx.docs.get({ name: "github-mcp-connect" }).',
      ].join("\n"),
      types: [
        "type GmailRequestInput = {",
        "  body?: unknown;",
        "  headers?: Record<string, string>;",
        "  method?: string;",
        "  path: string;",
        "  query?: Record<string, boolean | number | string | null | undefined>;",
        "};",
        "// itx.integrations.gmail.get() exposes (data is the addressed REST resource's",
        "// shape — supply it via request<T>; uninstantiated it stays unknown):",
        "interface GmailConnection {",
        "  request<T = unknown>(input: GmailRequestInput): Promise<{ data: T; headers: Record<string, string>; status: number; statusText: string }>;",
        "}",
        "// Exact package type; Iterate supplies auth and transport. See https://github.com/octokit/octokit.js.",
        'type GithubConnection = { octokit: import("octokit").Octokit };',
        "// itx.integrations.slack.get() IS a wrapped Slack WebClient",
        "// (@slack/web-api): any Web API method as a dotted path, ONE body arg.",
        "interface SlackConnection {",
        "  chat: { postMessage(body: Record<string, unknown>): Promise<Record<string, unknown>> };",
        "  // ...every other Web API method, same dotted shape",
        "}",
        "// itx.integrations.telegram.get() is the Telegram Bot API:",
        "// flat method names (ONE segment), one params object, JSON result.",
        "interface TelegramConnection {",
        "  sendMessage(params: { chat_id: number | string; text: string } & Record<string, unknown>): Promise<Record<string, unknown>>;",
        "  // ...every other Bot API method, same flat shape (sendPhoto, getMe, ...)",
        "}",
        "// itx.integrations.parallel exposes a flat OpenAPI RPC target:",
        "type Parallel = OpenApiRpc;",
      ].join("\n"),
      children: {
        cf: "Cloudflare first-party platform bindings: ai, browser, images, videos.",
        completeConnect:
          "OAuth callback completion; authority is the HMAC-signed state minted by startOAuthFlow.",
        connectTelegram:
          "Connect a Telegram bot by BotFather token: { botToken } — no OAuth, no redirect.",
        disconnect: "Disconnect one connection: { provider, connection }.",
        getConnection: "Connection status for { provider, connection }.",
        github:
          'GitHub App installations: github.get().octokit selects the first; github.get("<connection>").octokit selects an exact installation. Full Octokit REST, GraphQL, request, and route-string pagination are available.',
        gmail:
          'Connected Google accounts: gmail.get().request({ path: "/users/me/messages", query }); pass a slug only for an exact account.',
        list: "Every connection the project holds (built-in journals plus provided mounts).",
        parallel: "Parallel API RPC target using Iterate's platform API key.",
        slack:
          "Wrapped Slack WebClient: slack.get().chat.postMessage({ channel, text }); pass a slug only for an exact workspace.",
        startOAuthFlow: "Begin the OAuth connect flow; returns the authorization URL.",
        telegram:
          "Telegram Bot API: telegram.get().sendMessage({ chat_id, text }); pass a slug only for an exact bot.",
        waitrose:
          'Vendored Waitrose client: waitrose.get("<connection>").searchProducts(...); the account is defined by its connection secret.',
      },
      parent: "a project itx (itx.integrations)",
    });
  }

  /** Connection status for { provider, connection }. */
  getConnection(input: {
    connection: string;
    provider: BuiltinIntegrationSlug;
  }): Promise<IntegrationConnectionStatus> {
    return getConnectionStatus({
      connection: input.connection,
      projectId: this.props.projectId,
      provider: input.provider,
    });
  }

  /** The immutable Telegram user ids currently authorized for one bot. Empty
   * means deny-all, including on connections created before this policy was
   * introduced. */
  async getTelegramAccess(input: { connection: string }): Promise<{ allowedUserIds: string[] }> {
    await this.#assertConnectedTelegram(input.connection);
    const { state } = await this.#telegramProcessor(input.connection).snapshot();
    return { allowedUserIds: state.allowedUserIds };
  }

  /** Replace one Telegram bot's complete user allowlist and wait until the
   * ingress router has folded it, so the successful response is the access
   * boundary taking effect—not merely an event being queued. */
  async setTelegramAccess(input: {
    allowedUserIds: string[];
    connection: string;
  }): Promise<{ allowedUserIds: string[] }> {
    await this.#assertConnectedTelegram(input.connection);
    const allowedUserIds = TelegramProcessorContract.events[
      "events.iterate.com/telegram/access-configured"
    ].payloadSchema.shape.allowedUserIds.parse(input.allowedUserIds);
    const configuredEvents = await new StreamRpcTarget({
      auth: this.props.auth,
      path: integrationConnectionStreamPath("telegram", input.connection),
      projectId: this.props.projectId,
    }).append({
      type: "events.iterate.com/telegram/access-configured",
      payload: { allowedUserIds },
    });
    const configured = configuredEvents[0];
    if (configured === undefined) {
      throw new Error("Telegram access policy append returned no configured event.");
    }
    await this.#telegramProcessor(input.connection).waitUntilProcessed({
      offset: configured.offset,
    });
    return { allowedUserIds };
  }

  async #assertConnectedTelegram(connection: string): Promise<void> {
    const status = await getConnectionStatus({
      connection,
      projectId: this.props.projectId,
      provider: "telegram",
    });
    if (!status.connected) {
      throw new Error(`Telegram connection ${JSON.stringify(connection)} is not connected.`);
    }
  }

  /**
   * Connect a Telegram bot by BotFather token — no OAuth, no redirect: getMe
   * validates the token, setWebhook points the bot at this deployment (with a
   * derived secret token), and the token lands in a write-only connection
   * secret. Throws with a human-readable message on failure — except a bot
   * already claimed by ANOTHER project, which answers the structured
   * `ok: false, error: "telegram_bot_already_claimed"` arm so the caller can
   * confirm and retry with `steal: true` (moving the bot: the old project is
   * disconnected first; possession of the token is the authorization).
   */
  connectTelegram(input: { botToken: string; steal?: boolean }): Promise<ConnectTelegramResult> {
    return connectTelegram({
      botToken: input.botToken,
      config: parseConfig(env),
      projectId: this.props.projectId,
      steal: input.steal,
    });
  }

  /** Begin the OAuth connect flow; returns the authorization URL. */
  startOAuthFlow(input: {
    callbackUrl?: string;
    provider: OAuthProviderSlug;
    /** The user to bind the OAuth state to. Browser-supplied, not authority;
     * the callback's check against the signed state is the backstop. */
    userId: string;
  }): Promise<{ authorizationUrl: string }> {
    return startOAuthFlow({
      callbackUrl: input.callbackUrl,
      config: parseConfig(env),
      projectId: this.props.projectId,
      provider: input.provider,
      userId: input.userId,
    });
  }

  /** Called by the app worker's OAuth callback route; authority is the
   * HMAC-signed OAuth state minted by startOAuthFlow. */
  completeConnect(input: {
    /** OAuth authorization code (Slack/Google, or GitHub's proof callback). */
    code?: string;
    /** Untrusted GitHub setup-URL installation id, verified through user OAuth. */
    installationId?: string;
    provider: OAuthProviderSlug;
    state: string;
    userId: string | null;
  }): Promise<CompleteConnectResult> {
    return completeConnect({
      code: input.code,
      config: parseConfig(env),
      installationId: input.installationId,
      projectId: this.props.projectId,
      provider: input.provider,
      state: input.state,
      userId: input.userId,
    });
  }

  /** Disconnect one connection: { provider, connection }. */
  disconnect(input: {
    connection: string;
    provider: BuiltinIntegrationSlug;
  }): Promise<{ success: true }> {
    return disconnectProvider({
      connection: input.connection,
      projectId: this.props.projectId,
      provider: input.provider,
    });
  }
}

/**
 * The `itx.email` built-in: first-party email through the Cloudflare Email
 * Service `EMAIL` binding. Sender authorization is enforced here, not in the
 * binding: mail only leaves from the project's own address
 * (`<slug>@<first project hostname base>`). Every send appends an
 * `email/sent` audit event to the project's /integrations/email stream.
 * Inside an email thread agent scope (`/agents/email/t<id>`), `reply` derives
 * the counterpart, subject, and threading headers from the thread stream.
 */
class EmailCapabilityRpcTarget extends IterateRpcTarget<"EmailCapability"> {
  constructor(readonly props: { auth: ItxAuth; projectId: string; scopePath: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        "First-party email: send({ to, subject, text, html }) delivers through Cloudflare Email Service from this project's own address (<slug>@<hostname base>). An explicit `from` must match that address — a project can never send as anyone else. From ANY agent scope, send binds the conversation to the calling agent: replies to that mail arrive as this agent's inputs, and reply({ text }) answers the latest counterpart with correct threading headers. Both take attachments: [{ path }] (project files via itx.files, any file type) or [{ filename, data }] (inline base64); limits 32 files / 5 MiB total. Both return { messageId }.",
      children: {
        processor:
          "The email router's stream processor (the project-class host at /integrations/email).",
        send: "Send one email from the project's address; agent scopes get replies routed back to them. Returns { from, messageId }.",
        reply:
          "Reply within this agent's email conversation (email thread agents, or any agent that has sent/received project email); returns { from, to, messageId }.",
      },
      parent: "the project itx root",
    });
  }

  /** The email router's stream processor: the project-class host Durable
   * Object at /integrations/email, whose EmailProcessor routes inbound mail.
   * Wake subscriptions for it persist `["email", "processor",
   * "wakeStreamSubscriber"]`. */
  get processor(): WakeableStreamProcessorRpc {
    return new ProcessorRelayRpcTarget({
      auth: this.props.auth,
      host: () =>
        env.PROJECT.getByName(
          DurableObjectNameCodec.stringify({
            path: EMAIL_INTEGRATION_STREAM_PATH,
            projectId: this.props.projectId,
          }),
        ) as unknown as ProjectRouterProcessorHostStub,
      processorFacade: (host) => host.emailProcessor,
    });
  }

  /**
   * Send one email from the project's own address (`<slug>@<hostname base>`).
   * From ANY agent scope, send binds the conversation to the calling agent:
   * replies to that mail arrive as this agent's inputs.
   */
  async send(input: {
    to: string | string[];
    subject: string;
    /** Plain-text body; at least one of text/html is required. */
    text?: string;
    html?: string;
    /** Optional explicit sender; must equal the project's own address. */
    from?: string;
    /** Optional Reply-To; must be the project address or a +tagged variant. */
    replyTo?: string;
    /** RFC 5322 threading: the message id this send replies to. */
    inReplyTo?: string;
    /** RFC 5322 threading: the References chain, oldest first. */
    references?: string[];
    /** Attachments: project files by path and/or inline base64 content. */
    attachments?: EmailAttachmentInput[];
  }): Promise<{ from: string; messageId: string | null }> {
    const identity = await this.#senderIdentity();
    const attachments = await this.#resolveAttachments(input.attachments);
    // Agent-scoped sends bind the conversation to the CALLING agent: the
    // Reply-To carries a thread token routed to this agent's own stream, so
    // the human's reply comes back as this agent's input — whether it is an
    // email thread agent, a Slack agent, or any other agent scope.
    const thread = await this.#bindOutboundThreadToAgent({ identity, request: input });
    const message = buildProjectEmailMessage({
      projectAddress: identity.projectAddress,
      projectName: identity.projectName,
      request: {
        ...input,
        attachments,
        ...(thread !== null && input.replyTo === undefined ? { replyTo: thread.replyTo } : {}),
      },
    });
    const { from, messageId } = await this.#deliver({
      message,
      audit: {
        subject: input.subject,
        to: input.to,
        ...(input.inReplyTo === undefined ? {} : { inReplyTo: input.inReplyTo }),
        ...(thread === null ? {} : { threadId: thread.threadId }),
        attachments,
      },
    });
    return { from, messageId };
  }

  /**
   * Reply within this agent's email conversation — an email thread agent, or
   * any agent scope whose `send` bound a thread. Sends to the latest
   * counterpart with correct subject and threading headers derived from the
   * agent's stream. At least one of text/html is required.
   */
  async reply(input: {
    text?: string;
    html?: string;
    /** Optional subject override; defaults to `Re: <thread subject>`. */
    subject?: string;
    /** Attachments: project files by path and/or inline base64 content. */
    attachments?: EmailAttachmentInput[];
  }): Promise<{ from: string; to: string; messageId: string | null }> {
    const threadId = await this.#threadIdFromBirthCertificate();
    if (threadId === null) {
      throw new Error(
        `email.reply needs an agent scope with a bound email thread (an email thread agent, or any agent that has sent/received project email); this scope is "${this.props.scopePath}". Use email.send for new mail.`,
      );
    }
    if (!input.text && !input.html) {
      throw new Error("email.reply requires a text and/or html body.");
    }
    const identity = await this.#senderIdentity();
    const inbound = await this.#lastReceivedOnThread();
    if (inbound === null) {
      throw new Error("email.reply found no inbound email on this thread to reply to.");
    }
    // THE shared reply-target chain (emailCounterpart): Reply-To → header
    // From → the SMTP envelope from ingress authenticated.
    const to = emailCounterpart(inbound);
    if (to === null) {
      throw new Error("email.reply could not determine the thread counterpart address.");
    }
    const inReplyTo = inbound.message.messageId ?? undefined;
    const attachments = await this.#resolveAttachments(input.attachments);
    const message = buildProjectEmailMessage({
      projectAddress: identity.projectAddress,
      projectName: identity.projectName,
      request: {
        to,
        subject: input.subject ?? replySubject(inbound.message.subject),
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.html === undefined ? {} : { html: input.html }),
        attachments,
        // The thread's own reply address: replies to this mail route straight
        // back to the thread stream, without depending on client headers.
        replyTo: emailThreadReplyAddress({
          slug: identity.slug,
          domain: identity.domain,
          threadId,
        }),
        ...(inReplyTo === undefined ? {} : { inReplyTo }),
        references: [
          ...inbound.message.references,
          ...(inReplyTo === undefined ? [] : [inReplyTo]),
        ],
      },
    });
    const { from, messageId } = await this.#deliver({
      message,
      audit: {
        subject: message.subject,
        to,
        threadId,
        ...(inReplyTo === undefined ? {} : { inReplyTo }),
        attachments,
      },
    });
    return { from, to, messageId };
  }

  /**
   * For an agent-scoped send: durably bind an email thread to the calling
   * agent BEFORE the mail leaves, so a reply can never race the routing
   * table. Establishes three facts, all idempotent:
   * 1. The explicit email-agent birth certificate on the agent's stream.
   * 2. `thread-route-configured` on `/integrations/email` — the router
   *    forwards replies (token or header match) to this agent's stream.
   * 3. The same route event on the agent's own stream — thread context for
   *    the email-agent processor.
   * 4. The email-agent processor subscription on the agent's stream — a
   *    non-email agent (Slack, web chat, …) gains the transcriber that turns
   *    forwarded replies into its input. Email thread agents had it at birth;
   *    the identical birth and subscription idempotency keys dedupe.
   * Project-scoped sends return null and stay plain one-way mail.
   */
  async #bindOutboundThreadToAgent(input: {
    identity: { slug: string; domain: string };
    request: { to: string | string[]; subject: string };
  }) {
    const scopePath = this.props.scopePath;
    if (!scopePath.startsWith("/agents/")) return null;
    const threadId = (await this.#threadIdFromBirthCertificate()) ?? mintOutboundEmailThreadId();
    const firstRecipient = Array.isArray(input.request.to) ? input.request.to[0] : input.request.to;
    const routeEvent = {
      type: "events.iterate.com/email/thread-route-configured",
      idempotencyKey: `email-route:${threadId}`,
      payload: {
        threadId,
        streamPath: scopePath,
        ...(firstRecipient === undefined ? {} : { counterpart: firstRecipient }),
        subject: input.request.subject,
      },
    };
    const durableObjectName = DurableObjectNameCodec.stringify({
      projectId: this.props.projectId,
      path: scopePath,
    });
    await Promise.all([
      integrationStreamStub(this.props.projectId, EMAIL_INTEGRATION_STREAM_PATH).append(routeEvent),
      integrationStreamStub(this.props.projectId, scopePath).append(
        {
          type: "events.iterate.com/email-agent/created",
          idempotencyKey: `email-agent/created:${this.props.projectId}:${scopePath}`,
          payload: { config: { threadId } },
        },
        routeEvent,
        buildDurableObjectProcessorSubscriptionConfiguredEvent({
          durableObjectName,
          idempotencyKey: `stream/subscription-configured:${durableObjectName}#${EmailAgentProcessorContract.slug}`,
          processor: ["agents", ["get", scopePath], "processor"],
          processorSlug: EmailAgentProcessorContract.slug,
        }),
      ),
    ]);
    return {
      threadId,
      replyTo: emailThreadReplyAddress({
        slug: input.identity.slug,
        domain: input.identity.domain,
        threadId,
      }),
    };
  }

  /**
   * The thread explicitly assigned to this agent's email facet, if it has
   * one. Birth is the identity source; the stream path is only an address.
   */
  async #threadIdFromBirthCertificate(): Promise<string | null> {
    if (!this.props.scopePath.startsWith("/agents/")) return null;
    const event = await integrationStreamStub(this.props.projectId, this.props.scopePath).getEvent({
      idempotencyKey: `email-agent/created:${this.props.projectId}:${this.props.scopePath}`,
    });
    if (event === undefined) return null;
    if (event.type !== "events.iterate.com/email-agent/created") {
      throw new Error(
        `email agent birth key on "${this.props.scopePath}" names unexpected event type "${event.type}"`,
      );
    }
    return EmailProcessorContract.events[
      "events.iterate.com/email-agent/created"
    ].payloadSchema.parse(event.payload).config.threadId;
  }

  /**
   * Resolve caller attachment inputs to Email Service attachments: `{ path }`
   * reads the project file (bytes + stored contentType) from itx.files;
   * `{ data }` decodes inline base64. Count/size limits are enforced by
   * buildProjectEmailMessage against the resolved bytes.
   */
  async #resolveAttachments(
    inputs: EmailAttachmentInput[] | undefined,
  ): Promise<OutboundEmailAttachment[]> {
    if (inputs === undefined || inputs.length === 0) return [];
    return await Promise.all(
      inputs.map(async (input): Promise<OutboundEmailAttachment> => {
        if ("path" in input) {
          const file = await readProjectFile({
            path: input.path,
            projectId: this.props.projectId,
          });
          if (file === null) {
            throw new Error(`email attachment not found: no project file at "${input.path}".`);
          }
          return {
            content: file.bytes,
            filename: input.filename ?? input.path.split("/").pop() ?? "attachment",
            type: input.contentType ?? file.contentType,
            disposition: "attachment",
          };
        }
        return {
          content: decodeBase64Attachment(input.data),
          filename: input.filename,
          type: input.contentType ?? "application/octet-stream",
          disposition: "attachment",
        };
      }),
    );
  }

  /** The project's sending identity, resolved per call (slug/name can change). */
  async #senderIdentity() {
    if (!env.EMAIL) {
      throw new Error("email.send requires the EMAIL send_email binding (see wrangler config).");
    }
    const domain = emailDomainForDeployment(parseConfig(env).projectHostnameBases);
    if (!domain) {
      throw new Error(
        "email.send requires APP_CONFIG_PROJECT_HOSTNAME_BASES to derive the sender domain.",
      );
    }
    const record = await readProjectById(env.PROJECT_DIRECTORY, this.props.projectId);
    if (!record) {
      throw new Error(`Project ${this.props.projectId} not found in the project directory.`);
    }
    return {
      domain,
      slug: record.slug,
      projectAddress: emailAddressForProject({ slug: record.slug, domain }),
      projectName: record.name || record.slug,
    };
  }

  /** Send through the EMAIL binding and append the email/sent audit fact. */
  async #deliver(input: {
    message: Parameters<SendEmailBinding["send"]>[0];
    audit: {
      subject: string;
      to: string | string[];
      threadId?: string;
      inReplyTo?: string;
      attachments?: OutboundEmailAttachment[];
    };
  }) {
    const result = (await env.EMAIL.send(input.message)) as
      | { messageId?: string }
      | null
      | undefined;
    const messageId = result?.messageId ?? null;
    const from =
      typeof input.message.from === "string" ? input.message.from : input.message.from.email;
    // Attachment metadata only — bytes never land in the stream.
    const attachments = (input.audit.attachments ?? []).map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.type,
    }));
    const appendAudit = () =>
      integrationStreamStub(this.props.projectId, EMAIL_INTEGRATION_STREAM_PATH).append({
        type: "events.iterate.com/email/sent",
        idempotencyKey: `email-sent:${this.props.projectId}:${messageId ?? crypto.randomUUID()}`,
        // Recipients + subject for audit; bodies stay out of the stream. The
        // threadId (reply path) lets the email router index the outbound
        // messageId so replies route back to the thread.
        payload: {
          from,
          messageId,
          projectId: this.props.projectId,
          subject: input.audit.subject,
          to: input.audit.to,
          ...(input.audit.threadId === undefined ? {} : { threadId: input.audit.threadId }),
          ...(input.audit.inReplyTo === undefined ? {} : { inReplyTo: input.audit.inReplyTo }),
          ...(attachments.length === 0 ? {} : { attachments }),
        },
      });
    // The mail is already on the wire once send() resolved — an audit-append
    // failure must NOT surface as a send failure, or the caller (an agent)
    // retries and the recipient gets the message twice. Retry the append
    // once, then degrade loudly: the thread's +t Reply-To token still routes
    // replies, so losing this outbound messageId from the index only weakens
    // the header-only fallback for this one message.
    try {
      await appendAudit();
    } catch {
      try {
        await appendAudit();
      } catch (error) {
        console.error("[email] sent-audit append failed after successful send", {
          error,
          messageId,
          projectId: this.props.projectId,
        });
      }
    }
    return { from, messageId };
  }

  /**
   * The latest counterpart-authored email/received payload on this scope's
   * thread stream. Skips the project's own looped-back mail (the same filter
   * the email-agent processor applies) so reply never targets ourselves.
   */
  async #lastReceivedOnThread() {
    const schema = EmailProcessorContract.events["events.iterate.com/email/received"].payloadSchema;
    const stream = integrationStreamStub(this.props.projectId, this.props.scopePath);
    let afterOffset = 0;
    let last: ReturnType<(typeof schema)["parse"]> | null = null;
    for (;;) {
      const page = await stream.getEvents({
        afterOffset,
        eventTypes: ["events.iterate.com/email/received"],
        limit: 500,
      });
      for (const event of page) {
        const parsed = schema.safeParse(event.payload);
        // Skip our own looped-back mail AND automated mail (bounces,
        // Auto-Submitted): a mailer-daemon arriving after the human's message
        // must never become the reply target.
        if (parsed.success && !isOwnProjectMail(parsed.data) && !parsed.data.automated) {
          last = parsed.data;
        }
      }
      if (page.length < 500) return last;
      afterOffset = page[page.length - 1]!.offset;
    }
  }
}

async function assertAgentCreated(input: { path: string; projectId: string }): Promise<void> {
  const event = await integrationStreamStub(input.projectId, input.path).getEvent({
    idempotencyKey: `agent/created:${input.projectId}:${input.path}`,
  });
  if (event === undefined) {
    throw new Error(`agent at "${input.path}" has not been created`);
  }
  if (event.type !== "events.iterate.com/agent/created") {
    throw new Error(
      `agent birth key on "${input.path}" names unexpected event type "${event.type}"`,
    );
  }
}

/** Agent-local web chat response tool exposed inside agent script execution. */
class AgentChatRpcTarget extends IterateRpcTarget<"AgentChat"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        "An agent's web-chat door: sendMessage(message, { files? }) appends the agent's reply " +
        "to its stream (what the user sees). The message is a plain string; the optional " +
        "second argument's `files` attaches generated files — base64 strings (itx.ai.run " +
        "image output), Uint8Array, Blob, or a stream — which render inline in the chat " +
        "and stay model-visible on later turns.",
      children: { sendMessage: "Say something to the user (optionally with file attachments)." },
      parent: "agent.chat / itx.chat (agent scopes only)",
    });
  }

  constructor(readonly props: { auth: ItxAuth; path: string; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  /** The agent's own event stream (the chat rides on it). */
  get stream(): StreamRpcTarget {
    return new StreamRpcTarget({
      auth: this.props.auth,
      projectId: this.props.projectId,
      path: this.props.path,
    });
  }

  /**
   * Say something to the user — pass the message as a plain string:
   * `await itx.chat.sendMessage("Here you go!")`.
   *
   * `options.files` attaches project files to the message — THE way to hand
   * the user something you generated (e.g. an `itx.ai.run` image: base64
   * straight into `data`, never pasted into message text). Attached images
   * render inline in the chat and stay visible to the model on later turns.
   */
  async sendMessage(
    message: string,
    options?: { files?: Array<{ contentType: string; data: FileData; filename: string }> },
  ): Promise<StreamEvent> {
    await assertAgentCreated({ path: this.props.path, projectId: this.props.projectId });
    const trimmed = message.trim();
    if (trimmed === "") throw new Error("itx.chat.sendMessage requires a non-empty message.");
    const files =
      options?.files === undefined || options.files.length === 0
        ? undefined
        : await storeAgentFileAttachments({
            agentPath: this.props.path,
            config: parseConfig(env),
            files: options.files,
            projectId: this.props.projectId,
          });
    const [event] = await this.stream.append({
      type: "events.iterate.com/agents/web-message-sent",
      payload: { message: trimmed, ...(files === undefined ? {} : { files }) },
    });
    return event;
  }
}

type AgentRpcTargetProps = {
  auth: ItxAuth;
  // The agent scope's own capability host; its (already-normalized) path IS
  // the agent path. Exposed as `agent.capabilityHost` — the door to the
  // scope's dynamic capabilities (`agent.capabilityHost.someTool(...)`).
  capabilityHost: CapabilityHostRpcTarget;
  ctx: CfExecutionContext;
  projectId: string;
  /** The calling scope's path ("current actor") — see AgentCollectionRpcTarget. */
  sourceScopePath?: string;
};

/**
 * One agent: message loops and agent-local dynamic tools. For an
 * already-created agent, chain calls directly off `get` —
 * `await itx.agents.get("researcher").message(task)`.
 * Unknown members dispatch through the agent scope's capability host, so
 * `agents.get(path).someTool(args)` and
 * `agents.get(path).capabilityHost.someTool(args)` are equivalent; inside
 * the agent's own scripts the same tools are simply `itx.someTool(args)`.
 */
// Engineering note (docs consumers never need this): instances are
// DELIBERATELY plain — never wrapped in a Proxy. This is the surface most
// routinely returned FROM A METHOD CALL, and workerd RPC classifies a call
// result for promise pipelining with native brand checks a JS Proxy can
// never pass (`serializeJsValueWithPipeline` in workerd's worker-rpc.c++
// falls through to `NonPipelinable`, so EVERY pipelined call on the result
// dies with the baffling "The RPC receiver does not implement the method
// ..." — cloudflare/workerd#6873). A plain class instance classifies as a
// single stub and pipelines fine. The dynamic-tool spellings come from the
// PROTOTYPE-CHAIN fallback installed in the registry block at the bottom of
// this file: unknown members walk the prototype chain into a proxied hop and
// dispatch through this agent scope's capability host, while the instance
// itself stays a genuine, natively-branded RpcTarget. See
// installPrototypeInvokeCapabilityFallback (domains/itx/utils.ts) for the
// mechanism, and agent-handle-pipelining.itx.e2e.test.ts for the guard.
class AgentRpcTarget extends IterateRpcTarget<"Agent"> {
  // Private for the same reason as the other capability surfaces: public
  // member names are capability namespace (see ITX_SURFACE_MEMBER_NAMES).
  readonly #props: AgentRpcTargetProps;

  constructor(props: AgentRpcTargetProps) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
    parseAgentPath(props.capabilityHost.path);
    this.#props = props;
  }

  get #path() {
    return this.#props.capabilityHost.path;
  }

  /**
   * The agent scope's own capability host (provide/revoke/runScript/
   * __describe) — and the explicit dotted door to the scope's DYNAMIC
   * capabilities: `agents.get(path).capabilityHost.someTool(args)`. The
   * shorthand `agents.get(path).someTool(args)` resolves through the same
   * host via the handle's prototype-chain fallback; both pipeline over
   * workerd RPC. Inside the agent's own scripts the same capabilities are
   * simply `itx.someTool(args)`.
   */
  get capabilityHost(): CapabilityHostRpcTarget {
    return this.#props.capabilityHost;
  }

  /** Shortcut for `capabilityHost.provideCapability` (mounts on THIS agent's scope). */
  provideCapability(input: ProvideCapabilityInput): Promise<CapabilityProvisionRpcTarget> {
    return this.#props.capabilityHost.provideCapability(input);
  }

  /** Shortcut for `capabilityHost.revokeCapability`. */
  revokeCapability(input: RevokeCapabilityInput): Promise<void> {
    return this.#props.capabilityHost.revokeCapability(input);
  }

  /** @internal */
  get durableObjectStub() {
    return env.AGENT.getByName(
      DurableObjectNameCodec.stringify({
        projectId: this.#props.projectId,
        path: this.#path,
      }),
    );
  }

  /** The agent stream processor (snapshot/state). */
  get processor(): WakeableStreamProcessorRpc<AgentProcessorState> {
    return new ProcessorRelayRpcTarget<AgentProcessorState>({
      auth: this.#props.auth,
      // Workers generates the concrete Agent DO stub, while the shared relay
      // accepts the smaller processor-host surface. The DO implements that
      // surface; the double assertion only bridges those RPC types.
      host: () => this.durableObjectStub as unknown as ProcessorHostStub,
    });
  }

  /** The agent's transient runtime as a push-driven live-state surface. */
  get liveState(): LiveStateRpc<AgentLiveState> {
    return new LiveStateRelayRpcTarget<AgentLiveState>(
      // Workers generates the concrete Agent DO stub, while this generic relay
      // accepts its live-state surface. The DO implements that surface; the
      // double assertion only bridges those RPC types.
      () => this.durableObjectStub as unknown as LiveStateDurableObjectStub<AgentLiveState>,
    );
  }

  /** The agent's own event stream. */
  get stream(): StreamRpcTarget {
    return new StreamRpcTarget({
      auth: this.#props.auth,
      projectId: this.#props.projectId,
      path: this.#path,
    });
  }

  /**
   * Append durable events the Agent processor consumes. The input union and
   * runtime parser both derive from `AgentProcessorContract.consumes`, so the
   * typed helper cannot drift from the processor. This validates shape and
   * vocabulary, not state-machine order or provenance, and grants no special
   * append rights: any project member can append any event through
   * `stream.append`, with the same reducer meaning for a valid matching event.
   * `create()` remains the normal birth path. Use `stream.append` for an event
   * outside the Agent vocabulary or for an intentionally ephemeral event.
   */
  async append(...events: AgentEventInput[]): Promise<StreamEvent[]> {
    await this.#assertCreated();
    const parsed = events.map((event) => AgentProcessorContract.parseConsumedInput(event));
    return await this.stream.append(...parsed);
  }

  /** The agent's web-chat door (what the user sees). */
  get chat(): AgentChatRpcTarget {
    return new AgentChatRpcTarget({
      auth: this.#props.auth,
      path: this.#path,
      projectId: this.#props.projectId,
    });
  }

  /**
   * Create the generic agent machinery on this stream and wait until the
   * agent, capability-host, singleton collection, and explicitly-created
   * workspace processors have reduced their births. The optional payload is
   * the `agent/created` birth certificate
   * (arbitrary birth facts; defaults to `{}`). Configuration, context, and
   * tasks remain separate events: append processor-consumed events through
   * `agent.append()` or use a typed helper such as `message()` after creation.
   * Resolves with this same agent handle, so create chains.
   * Identical-payload retries dedupe on the birth idempotency keys; a create
   * over an existing agent with a different payload fails loudly.
   */
  async create(payload?: AgentCreateInput): Promise<AgentRpcTarget> {
    const workspace = new WorkspaceRpcTarget({
      auth: this.#props.auth,
      path: agentWorkspacePath(this.#path),
      projectId: this.#props.projectId,
    });
    const workspaceReady = workspace.create({});
    const creation = agentCreationForPath({
      agentPath: this.#path,
      projectId: this.#props.projectId,
      ...(payload === undefined ? {} : { payload }),
      ...(await agentBootProjectFacts(this.#props.projectId)),
    });
    const committed = await this.stream.append(...creation.events);
    // append() preserves INPUT order, including idempotency hits at their old
    // offsets. A paired capability host may already exist, so the last input
    // is not necessarily the newest event. The create boundary is the maximum
    // offset across the complete batch.
    const birthOffset = committed.reduce((maximum, event) => Math.max(maximum, event.offset), 0);
    if (birthOffset === 0) throw new Error("agent create committed no events");

    const agentCollection = env.AGENT_COLLECTION.getByName(
      DurableObjectNameCodec.stringify({
        projectId: this.#props.projectId,
        path: AGENT_COLLECTION_PATH,
      }),
    );
    await Promise.all([
      this.processor.waitUntilProcessed({
        offset: birthOffset,
        timeoutMs: PROCESSOR_BIRTH_WAIT_TIMEOUT_MS,
      }),
      this.capabilityHost.processor.waitUntilProcessed({
        offset: birthOffset,
        timeoutMs: PROCESSOR_BIRTH_WAIT_TIMEOUT_MS,
      }),
      agentCollection.waitUntilAgentCreated({
        path: this.#path,
        timeoutMs: PROCESSOR_BIRTH_WAIT_TIMEOUT_MS,
      }),
      workspaceReady,
    ]);
    return this;
  }

  /**
   * Send a message to this agent — THE inbound door for every caller. The
   * context item's actor derives from the calling scope: inside an agent script
   * (itx scoped to an agent path), the message is stamped
   * `{ type: "agent", path }` and does NOT refill the receiver's autonomous
   * turn budget, so agent↔agent reply loops stay bounded; from anywhere else
   * (web UI, CLI, MCP session) it is a user message. The agent must already
   * have been created explicitly. Optional files
   * are stored in project file storage and ride the message as attachments
   * (images stay visible to vision-capable models).
   */
  async message(
    input:
      | string
      | {
          message: string;
          files?: Array<{ contentType: string; data: FileData; filename: string }>;
        },
  ): Promise<StreamEvent> {
    await this.#assertCreated();
    const { message, files: fileInputs } =
      typeof input === "string"
        ? { message: input, files: undefined }
        : { message: input.message, files: input.files };
    const actor = this.#contextActor();
    const files =
      fileInputs === undefined || fileInputs.length === 0
        ? undefined
        : await storeAgentFileAttachments({
            agentPath: actor.type === "agent" ? actor.path : this.#path,
            config: parseConfig(env),
            files: fileInputs,
            projectId: this.#props.projectId,
          });
    const [event] = await this.stream.append({
      type: "events.iterate.com/agents/context-added",
      payload: {
        role: actor.type === "agent" ? "developer" : "user",
        content: message,
        actor,
        ...(files === undefined ? {} : { files }),
      },
    });
    return event;
  }

  /** Provenance for context added through this handle. */
  #contextActor(): { type: "agent"; path: string } | { type: "user"; origin: "web" } {
    const source = this.#props.sourceScopePath;
    return source !== undefined && source.startsWith("/agents/")
      ? { type: "agent", path: source }
      : { type: "user", origin: "web" };
  }

  /**
   * Send-and-wait convenience: appends a message and resolves with the
   * agent's next chat reply on this stream. Replies are matched by order, not
   * correlated per request — concurrent asks on one agent stream interleave
   * exactly like two people typing into the same chat. Like `message`, the
   * sender derives from the calling scope, so an agent asking another agent
   * does not refill the receiver's autonomous turn budget. For delegated child
   * agents, prefer `message()` and read their report from your own inputs:
   * every agent-sourced message is labeled with how to reply (message the
   * sender, whose web chat nobody watches), so `ask()` can time out waiting
   * for a chat reply that never comes.
   */
  async ask(input: {
    message: string;
    /** Where a USER message came from (ignored for agent-scoped callers). Defaults to "web". */
    origin?: "web" | "mcp";
    /** How long to wait for the reply. Defaults to 45s. */
    timeoutMs?: number;
  }): Promise<StreamEvent> {
    await this.#assertCreated();
    const actor = this.#contextActor();
    const [sent] = await this.stream.append({
      type: "events.iterate.com/agents/context-added",
      payload: {
        role: actor.type === "agent" ? "developer" : "user",
        content: input.message,
        actor: actor.type === "user" ? { type: "user", origin: input.origin ?? "web" } : actor,
      },
    });
    return await this.stream.waitForEvent({
      afterOffset: sent.offset,
      eventTypes: ["events.iterate.com/agents/web-message-sent"],
      timeoutMs: input.timeoutMs ?? 45_000,
    });
  }

  /**
   * Store files AND make them part of this agent's conversation in one call.
   * The bytes land in project file storage under the agent's own path
   * (`<agent path>/<short id>-<filename>`), and ONE input event carrying all
   * attachments (each with a signed public `url`) is appended as one context
   * item — so the files show up as a single conversation message, and
   * images become visible to vision-capable models on following turns. Pass
   * `llmRequestPolicy: { behaviour: "dont-trigger-request" }` to record files
   * WITHOUT starting an LLM turn (the right choice for files the agent
   * itself generated, e.g. `itx.ai.run` images).
   */
  async addFiles(input: {
    files: Array<{ contentType: string; data: FileData; filename: string }>;
    /** Conversation text accompanying the files. Defaults to a short attachment note. */
    message?: string;
    llmRequestPolicy?: {
      behaviour: "dont-trigger-request" | "after-current-request" | "interrupt-current-request";
    };
  }): Promise<{ event: StreamEvent; files: AgentFileAttachment[] }> {
    await this.#assertCreated();
    if (input.files.length === 0) throw new Error("agent.addFiles requires at least one file.");
    const files = await storeAgentFileAttachments({
      agentPath: this.#path,
      config: parseConfig(env),
      files: input.files,
      projectId: this.#props.projectId,
    });
    const actor = this.#contextActor();
    const [event] = await this.stream.append({
      type: "events.iterate.com/agents/context-added",
      payload: {
        role: actor.type === "agent" ? "developer" : "user",
        actor,
        content:
          input.message ?? `[Files attached: ${files.map((file) => file.filename).join(", ")}]`,
        files,
        ...(input.llmRequestPolicy === undefined
          ? {}
          : { llmRequestPolicy: input.llmRequestPolicy }),
      },
    });
    return { event, files };
  }

  /** Includes `whoami` (`"agent <projectId>:<agentPath>"`), `projectId`, `agentPath`. */
  async __describe(): Promise<
    Description & { agentPath: string; projectId: string; whoami: string }
  > {
    return describeNode({
      instructions:
        "One agent: the control surface for the agent stream at this path. Besides the members below, the agent scope's dynamic capabilities dispatch directly on this handle — agents.get(path).someTool(args) (equivalently capabilityHost.someTool(args)); from inside the agent's own scope they are simply itx.someTool(args).",
      children: {
        addFiles:
          "Store files in project storage AND attach them to this conversation (one call, one message).",
        append:
          "Append durable Agent-consumed events; the accepted union comes directly from the Agent processor contract.",
        ask: "Send a message and wait for the agent's next chat reply.",
        capabilityHost:
          "This agent scope's durable capability table — also the dotted door to its dynamic capabilities (capabilityHost.<name>(args)).",
        chat: "The agent's web-chat door (sendMessage).",
        create:
          "Create this agent (optional payload = the agent/created birth certificate), wait for its processors to consume the birth batch, and return this same agent handle.",
        kill: "Restart the agent's server-side object; the next request boots it fresh.",
        message:
          "Send this agent a message (string, or { message, files? }); the sender is derived from the calling scope.",
        processor: "The agent stream processor (snapshot/state).",
        provideCapability: "Shortcut: mount a capability on THIS agent's scope.",
        revokeCapability: "Shortcut: remove a mount from THIS agent's scope.",
        stream: "The agent's own event stream.",
      },
      parent: `project ${this.#props.projectId}, via agents.get("${this.#path}")`,
      agentPath: this.#path,
      projectId: this.#props.projectId,
      whoami: `agent ${this.#props.projectId}:${this.#path}`,
    });
  }

  /** Restart the agent's server-side object; the next request boots it fresh. */
  kill(): Promise<void> {
    return Promise.resolve(this.durableObjectStub.kill());
  }

  async #assertCreated(): Promise<void> {
    await assertAgentCreated({ path: this.#path, projectId: this.#props.projectId });
  }
}

/**
 * Public project-facing worker collection.
 *
 * `get(ref)` mirrors the desired capability-tree shape:
 * `itx.projects.get("prj").workers.get(ref).someRpcMethod()`.
 */
class DynamicWorkerCollectionRpcTarget extends IterateRpcTarget<"DynamicWorkerCollection"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        "Dynamic worker refs: get(ref) turns a declarative worker ref (inline modules or repo source; stateless or stateful) into a live dispatch target.",
      children: { get: "The worker for a ref ({ type, path, source, ... })." },
      parent: "a project itx (itx.workers); itx.worker is the default project worker",
    });
  }

  constructor(
    readonly props: {
      auth: ItxAuth;
      ctx: CfExecutionContext;
      projectId: string;
    },
  ) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  /** The live dispatch target for a declarative worker ref (validated by schema). */
  get<T extends object = Record<string, unknown>>(
    ref: DynamicWorkerRef,
    options?: DynamicWorkerDispatchOptions,
  ): DynamicWorkerCapability<T> {
    const parsed = WorkerRefSchema.parse(ref);
    return new DynamicWorkerRpcTarget({
      buildBudgetMs: options?.buildBudgetMs,
      ctx: this.props.ctx,
      flattenNestedPaths: options?.flattenNestedPaths === true,
      projectId: this.props.projectId,
      ref: parsed,
    }) as unknown as DynamicWorkerCapability<T>;
  }
}

/**
 * RPC wrapper around a single DynamicWorkerRef.
 *
 * The returned object is a path proxy: unknown properties become path segments
 * and eventually call `invokeCapability`. Dynamic workers reserve a tiny
 * platform lifecycle surface (`invokeCapability`, `kill`, `setAlarm`,
 * `getAlarm`, disposal); everything else belongs to the loaded worker.
 */
class DynamicWorkerRpcTarget extends IterateRpcRelay<"DynamicWorkerCapability"> {
  readonly #buildBudgetMs: number | undefined;
  readonly #flattenNestedPaths: boolean;
  readonly #props: { ctx: CfExecutionContext; projectId: string };
  readonly #ref: DynamicWorkerRef;
  readonly #traceRole: DynamicWorkerTraceRole | undefined;
  #lazyRunner: DynamicWorkerRunner | undefined;

  constructor(props: {
    buildBudgetMs?: number;
    ctx: CfExecutionContext;
    flattenNestedPaths?: boolean;
    projectId: string;
    ref: DynamicWorkerRef;
    traceRole?: DynamicWorkerTraceRole;
  }) {
    super();
    this.#buildBudgetMs = props.buildBudgetMs;
    this.#flattenNestedPaths = props.flattenNestedPaths === true;
    this.#props = { ctx: props.ctx, projectId: props.projectId };
    this.#ref = props.ref;
    this.#traceRole = props.traceRole;
  }

  // Lazy: __describe answers from the ref alone and must not mint loopback
  // stubs; only an actual invocation needs a runner. A worker reached through
  // the public collection runs in the itx scope of its own path — the itx
  // binding and egress fetcher come from the HOSTING context, not the ref.
  get #runner(): DynamicWorkerRunner {
    this.#lazyRunner ??= new DynamicWorkerRunner({
      exports: this.#props.ctx.exports,
      projectId: this.#props.projectId,
      scopePath: this.#ref.path,
      waitUntil: (promise) => this.#props.ctx.waitUntil(promise),
    });
    return this.#lazyRunner;
  }

  // Answered from the REF alone — describing a worker must not boot it (no
  // loader isolate, no module top-level code, no DO wake). The worker's own
  // live self-report is a separate, explicit act:
  // `invokeCapability({ path: ["__describe"] })` loads the worker and calls a
  // `__describe` the user code may export.
  async __describe() {
    const source = this.#ref.source;
    const build = "createApp" in source ? source.createApp : source.createWorker;
    const describedFiles =
      build.files.type === "inline"
        ? {
            files: Object.fromEntries(
              Object.entries(build.files.files).map(([name, text]) => [
                name,
                `${text.length} bytes`,
              ]),
            ),
            type: "inline" as const,
          }
        : build.files;
    const describedSource =
      "createApp" in source
        ? { createApp: { ...source.createApp, files: describedFiles } }
        : { createWorker: { ...source.createWorker, files: describedFiles } };
    return describeNode({
      instructions:
        `A ${this.#ref.type} dynamic worker (described from its ref — the worker was NOT loaded). ` +
        'Dotted calls load it through the Worker Loader and invoke the entrypoint: `worker.someMethod(x)` is `invokeCapability({ path: ["someMethod"], args: [x] })`. ' +
        "`children` cannot be listed — the worker's methods are whatever its entrypoint exports. " +
        'To ask the worker to describe ITSELF (boots it; only works if its code implements `__describe`), call `invokeCapability({ path: ["__describe"] })`.',
      children: {
        invokeCapability: "Explicit dispatch into the worker: { path, args, flattenNestedPath? }.",
        kill: "Restart the stateful worker's server-side object; stateless worker refs reject.",
        setAlarm:
          "Arm (ms timestamp) or disarm (null) the stateful worker's durable alarm; the fire calls the worker class's alarm(). Stateless worker refs reject.",
        getAlarm: "The stateful worker's armed alarm time (ms) or null.",
      },
      parent: `itx.workers of this project (itx scope path "${this.#ref.path}")`,
      ref: {
        ...(this.#ref.type === "stateless"
          ? { entrypoint: this.#ref.entrypoint, propKeys: Object.keys(this.#ref.props ?? {}) }
          : { className: this.#ref.className, durableWorkerKey: this.#ref.durableWorkerKey }),
        path: this.#ref.path,
        source: describedSource,
        type: this.#ref.type,
      },
    });
  }

  async invokeCapability({
    args = [],
    flattenNestedPath = this.#flattenNestedPaths,
    path,
  }: {
    args?: unknown[];
    flattenNestedPath?: boolean;
    path: string[];
  }) {
    // Every dynamic worker invocation goes through DynamicWorkerRunner:
    // stateless entrypoints, stateful DO facets, provided worker
    // capabilities, and project.worker all share its loader/egress/itx
    // binding rules. Args and return values pass through untouched on
    // purpose: both directions may carry live RPC stubs, and an RpcTarget
    // returned by the dynamic worker must remain a live object-capability so
    // Cap'n Web can serialize it as a chained/pipelined stub for the outer
    // caller.
    return await this.#runner.invokeCapability({
      args,
      buildBudgetMs: this.#buildBudgetMs,
      flattenNestedPath,
      path,
      ref: this.#ref,
      traceRole: this.#traceRole,
    });
  }

  /** Restart the stateful worker's server-side object; stateless worker refs reject. */
  async kill(): Promise<void> {
    await this.#runner.kill(this.#statefulRef("kill"));
  }

  /** Arm (ms timestamp) or disarm (null) the stateful worker's durable alarm —
   * see {@link DynamicWorkerCapability.setAlarm} for the full contract. */
  async setAlarm(atMs: number | null): Promise<void> {
    if (atMs !== null && !Number.isFinite(atMs)) {
      throw new Error("Dynamic worker setAlarm() requires a finite ms timestamp or null.");
    }
    await this.#runner.setAlarm(this.#statefulRef("setAlarm"), atMs);
  }

  /** The stateful worker's armed alarm time (ms since epoch), or null. */
  async getAlarm(): Promise<number | null> {
    return await this.#runner.getAlarm(this.#statefulRef("getAlarm"));
  }

  /** The lifecycle verbs above are durable-identity concepts: they exist for
   * stateful refs only, and reject the rest with the verb's name. */
  #statefulRef(verb: string): StatefulDynamicWorkerRef {
    if (this.#ref.type !== "stateful") {
      throw new Error(`Dynamic worker ${verb}() only applies to stateful worker refs.`);
    }
    return this.#ref;
  }
}

type ProjectListEntryBase = Omit<ProjectListEntry, "deploymentStatus">;

/** Catalog of projects reachable from a {@link Session}. */
export class ProjectCollectionRpcTarget extends IterateRpcTarget<"ProjectCollection"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        'Project catalog: get("prj_..." or a slug) returns a handle; an unknown slug is a prospective handle whose create({ organizationSlug?, projectId? }) registers and births the project. list() enriches known projects with deployment status.',
      children: {
        get: "A known project itx or a prospective slug handle; addressing does not create.",
        list: "The session's projects with deployment status.",
      },
      parent: "session.projects",
    });
  }

  constructor(readonly props: { auth: ItxAuth; config?: AppConfig; ctx: CfExecutionContext }) {
    super();
  }

  /**
   * The itx at the project root, addressable by `prj_…` id OR by URL slug — the
   * browser passes `params.projectSlug` straight through, no client-side
   * slug→id hop (`get("acme")` and `get("prj_123")` both work). Resolution
   * rides the KV-cached project directory ({@link resolveProjectIdBySlug},
   * which passes `prj_` ids through untouched and resolves slugs); slugs are
   * immutable, so a slug handle can't silently repoint. Confinement stays keyed
   * on the resolved id — the access check runs on the id, never the raw input.
   */
  async get(idOrSlug: string): Promise<ProjectRpcTarget> {
    const projectId = await resolveProjectIdBySlug({
      directory: env.PROJECT_DIRECTORY,
      identifier: idOrSlug,
    });
    if (projectId === null) {
      return new ProjectRpcTarget({
        auth: this.props.auth,
        ctx: this.props.ctx,
        prospectiveSlug: idOrSlug,
      });
    }
    // Claims can lag right after a create; the auth context may consult the
    // project directory and widen itself before access is granted. Cap'n Web
    // pipelines through the returned promise.
    await this.props.auth.ensureCanAccessProject?.(projectId);
    return itxForScope({
      auth: this.props.auth,
      ctx: this.props.ctx,
      path: "/",
      projectId,
    });
  }

  /**
   * The session's projects, enriched: identity (id/slug/org) from the auth
   * claims or the project directory, deployment status from a concurrent
   * engine probe (`state.ready` on each project's processor snapshot). A
   * probe failure degrades THAT entry to "unknown" — the list always renders.
   * Scope is explicit: "mine" (default for user principals) is the caller's
   * own claims even when admin credentials ride the same socket;
   * "deployment" (every directory-known project) requires an admin principal
   * and is the default for non-user admin principals, which have no claims.
   */
  async list(input?: { scope?: "mine" | "deployment" }): Promise<ProjectListEntry[]> {
    const bases = await this.#listEntryBases(input?.scope);
    const outcomes = await Promise.allSettled(bases.map((base) => projectProcessorState(base.id)));
    const statuses = deploymentStatusesFromProbes(
      bases.map((base) => base.id),
      outcomes.map((outcome): PromiseSettledResult<boolean> => {
        if (outcome.status === "rejected") return outcome;
        return { status: "fulfilled", value: outcome.value.ready === true };
      }),
    );
    return bases.map((base) => ({
      ...base,
      deploymentStatus: statuses.get(base.id) ?? "unknown",
    }));
  }

  /**
   * Which projects the list covers, and what we know about each before the
   * engine probe. The scope is explicit (see the contract): "mine" reads the
   * caller's claims even when admin credentials ride the same socket; the
   * "deployment" scope (PROJECT_DIRECTORY KV, every known project — record
   * `name` is the PROJECT name, so no organization name) requires an admin
   * principal. Non-user admin principals have no claims, so they default to
   * "deployment"; impersonated users (test lane) list their scopes,
   * directory-read.
   */
  async #listEntryBases(requestedScope?: "mine" | "deployment"): Promise<ProjectListEntryBase[]> {
    const userPrincipal = userPrincipalOf(this.props.auth);
    // Default to the caller's own projects for EVERY principal shape (user,
    // impersonated, admin) — only pure admin principals, which have no
    // projects of their own, default to the deployment listing.
    const scope =
      requestedScope ?? (userPrincipal || !this.props.auth.isAdmin() ? "mine" : "deployment");
    if (scope === "deployment") {
      if (!this.props.auth.isAdmin()) {
        throw new Error('projects.list({ scope: "deployment" }) requires an admin principal');
      }
      const records = await listProjectDirectory(env.PROJECT_DIRECTORY);
      return records.map((record) => ({
        id: record.id,
        slug: record.slug,
        organizationId: record.organizationId,
        organizationName: null,
        organizationSlug: null,
      }));
    }

    if (userPrincipal) {
      const organizationsById = new Map(
        userPrincipal.organizations.map((organization) => [
          organization.id,
          {
            name: organization.name ?? null,
            slug: organization.slug,
          },
        ]),
      );
      const projectIds = new Set([
        ...userPrincipal.projects.map((project) => project.id),
        ...this.props.auth.listAccessibleProjects(),
      ]);
      const claims = new Map(userPrincipal.projects.map((project) => [project.id, project]));
      return await Promise.all(
        [...projectIds].map(async (projectId) => {
          const claim = claims.get(projectId);
          if (claim) {
            return {
              id: claim.id,
              slug: claim.slug,
              organizationId: claim.organizationId,
              organizationName: organizationsById.get(claim.organizationId)?.name ?? null,
              organizationSlug: organizationsById.get(claim.organizationId)?.slug ?? null,
            };
          }
          return await this.#directoryEntryBase(projectId);
        }),
      );
    }

    return await Promise.all(
      this.props.auth
        .listAccessibleProjects()
        .map((projectId) => this.#directoryEntryBase(projectId)),
    );
  }

  async #directoryEntryBase(projectId: string): Promise<ProjectListEntryBase> {
    const record = await readProjectById(env.PROJECT_DIRECTORY, projectId);
    return {
      id: projectId,
      // A scope the directory has never seen (impersonated test principals)
      // still lists — the id doubles as the slug.
      slug: record?.slug ?? projectId,
      organizationId: record?.organizationId ?? null,
      organizationName: null,
      organizationSlug: null,
    };
  }
}

type CapabilityHostRpcTargetProps = {
  auth: ItxAuth;
  ctx: CfExecutionContext;
  // Scope path of the durable capability table this host fronts: `"/"` is the
  // project root, `/agents/bla` an agent scope. Normalized in the constructor.
  path: string;
  projectId: string;
};

/**
 * The host surface for ONE capability scope: mount, revoke, invoke, describe,
 * and run scripts against the durable capability table at `path` (backed by
 * the CapabilityHostDurableObject with that name). Mounting is always local to
 * this scope; on a local miss, reads follow the scope's journaled `fallback`
 * expression — usually one hop straight to the project root host.
 * `itx.capabilityHost` is the current scope's host;
 * `itx.capabilityHosts.get("/")` addresses the project root from anywhere —
 * that is how an agent provides a capability to the whole project.
 */
class CapabilityHostRpcTarget extends IterateRpcTarget<"CapabilityHost"> {
  // Private on purpose: on the capability surfaces, every PUBLIC member name is
  // claimed capability namespace (the fallback proxy checks `key in target`,
  // and ITX_SURFACE_MEMBER_NAMES bans mounts from shadowing members). A public
  // `props` field would burn that name for internals.
  readonly #props: CapabilityHostRpcTargetProps;

  constructor(props: CapabilityHostRpcTargetProps) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
    this.#props = { ...props, path: normalizePath(props.path) };
  }

  /** The scope path this host fronts: `"/"` is the project root, `/agents/bla` an agent. */
  get path(): string {
    return this.#props.path;
  }

  get #durableObject() {
    return env.CAPABILITY_HOST.getByName(
      DurableObjectNameCodec.stringify({
        path: this.#props.path,
        projectId: this.#props.projectId,
      }),
    );
  }

  get #stream(): StreamRpcTarget {
    return new StreamRpcTarget({
      auth: this.#props.auth,
      path: this.#props.path,
      projectId: this.#props.projectId,
    });
  }

  /** This scope's capability-host stream processor (snapshot/state). A real
   * member, so it also claims the name: mounts cannot shadow `processor`. */
  get processor(): WakeableStreamProcessorRpc {
    return new ProcessorRelayRpcTarget({
      auth: this.#props.auth,
      host: () => this.#durableObject as unknown as ProcessorHostStub,
    });
  }

  /**
   * Create this capability host: append the atomic birth batch (created +
   * processor subscription; the payload defaults to `{}` config with the
   * standard one-hop fallback to the project root host — the path is
   * normalized in the constructor), wait until the processor has consumed it,
   * and return this same host handle, so create chains. Identical-payload
   * retries dedupe on the birth idempotency keys; a create over an existing
   * host with a different payload fails loudly.
   */
  async create(payload?: CapabilityHostCreateInput): Promise<CapabilityHostRpcTarget> {
    const committed = await this.#stream.append(
      ...capabilityHostCreationEvents({
        path: this.#props.path,
        projectId: this.#props.projectId,
        ...(payload === undefined ? {} : { payload }),
      }),
    );
    // append() preserves INPUT order, including idempotency hits at their old
    // offsets — the create boundary is the maximum offset across the batch.
    const offset = committed.reduce((maximum, event) => Math.max(maximum, event.offset), 0);
    if (offset === 0) throw new Error("capability host create committed no events");
    await this.processor.waitUntilProcessed({
      offset,
      timeoutMs: PROCESSOR_BIRTH_WAIT_TIMEOUT_MS,
    });
    return this;
  }

  /** Mount a capability on THIS scope; returns an ownership handle that can revoke exactly this mount. */
  async provideCapability(input: ProvideCapabilityInput): Promise<CapabilityProvisionRpcTarget> {
    rejectBuiltinCollision(ITX_SURFACE_MEMBER_NAMES, input.path);
    const provision = await this.#durableObject.provideCapability(input);
    // The Durable Object returns the durable mount coordinates. The public RPC
    // surface returns an ownership handle that can revoke that exact mount on
    // explicit revoke or disposal.
    return new CapabilityProvisionRpcTarget({
      ctx: this.#props.ctx,
      path: input.path,
      providedAtOffset: provision.providedAtOffset,
      revoke: (revokeInput) => this.#durableObject.revokeCapability(revokeInput),
    });
  }

  /** Remove the current mount at a path, or one exact mount by its offset. */
  async revokeCapability(input: RevokeCapabilityInput): Promise<void> {
    await this.#durableObject.revokeCapability(input);
  }

  /** Explicit dynamic dispatch; the dotted-path fallback (`itx.foo.bar(...)`) compiles to exactly this call. */
  async invokeCapability(call: { args?: unknown[]; path: string[] }): Promise<unknown> {
    const { args = [], path } = call;
    return await this.#durableObject.invokeCapability({ args, path });
  }

  /** Includes `capabilities`: everything reachable at this scope — own mounts plus inherited ones, tagged with their declaring scope. */
  async __describe(): Promise<
    Description & { capabilities: CapabilityDescription[]; path: string }
  > {
    const capabilities = await this.#durableObject.describeCapabilities();
    // (DO method name: describeCapabilities — it returns the raw array; the
    // Description envelope is assembled here, where the scope context lives.)
    return describeNode({
      instructions: `The capability host at scope "${this.#props.path}": the durable dynamic-capability table and script journal for this scope. Mounting is local; on a local miss reads follow the scope's journaled fallback (usually the project root host), so \`capabilities\` includes the fallback's mounts tagged with their declaring scope.`,
      children: {
        create:
          "Create this capability host (optional payload = the capability-host/created birth certificate), wait until its processor has processed the birth batch, and return this same host handle.",
        invokeCapability:
          "Explicit dynamic dispatch ({ path, args }); dotted calls compile to this.",
        kill: "Restart this scope's server-side object; the next request boots it fresh.",
        provideCapability: "Mount a capability on THIS scope; returns a revoke handle.",
        revokeCapability: "Remove a mount from THIS scope.",
        runScript: "Run an async (itx) => {...} script in this scope.",
      },
      parent: `project ${this.#props.projectId}; sibling scopes via capabilityHosts.get(path)`,
      capabilities,
      path: this.#props.path,
    });
  }

  /** Run an `async (itx) => { … }` script in this scope; the execution is journaled on the scope stream. */
  async runScript(code: string): Promise<{
    completedEvent: StreamEvent;
    executionId: string;
    result: unknown;
  }> {
    return await this.#durableObject.runScript(code);
  }

  /** Restart this scope's server-side object; the next request boots it fresh. */
  kill(): Promise<void> {
    return Promise.resolve(this.#durableObject.kill());
  }
}

/** Catalog of capability scopes within one project (`itx.capabilityHosts`). */
class CapabilityHostCollectionRpcTarget extends IterateRpcTarget<"CapabilityHostCollection"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        'Capability hosts of ANY scope, by path: get("/") is the project root (mount there to make a capability visible project-wide), get("/agents/<name>") an agent scope.',
      children: { get: "The capability host at a scope path." },
      parent: "a project itx (itx.capabilityHosts)",
    });
  }

  constructor(readonly props: { auth: ItxAuth; ctx: CfExecutionContext; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  /** The capability host at a scope path (`"/"` is the project root). */
  get(path: string): CapabilityHostRpcTarget {
    return new CapabilityHostRpcTarget({
      auth: this.props.auth,
      ctx: this.props.ctx,
      path,
      projectId: this.props.projectId,
    });
  }
}

/** A partial fetch: return its response, or continue the app when it returns null. */
class ProjectAuthRpcTarget extends IterateRpcTarget<"ProjectAuth"> {
  constructor(readonly props: { auth: ItxAuth; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  /** Select the project-member policy for this project's auth gate. */
  get(policy: ProjectAuthPolicy): ProjectAuthRpcTarget {
    parseProjectAuthPolicy(policy);
    return this;
  }

  /**
   * Exchange an exact-origin app cookie for its authenticated actor. An app's
   * unauthenticated Cap'n Web root uses this to construct its own session
   * RpcTarget; the browser never receives the project's itx.
   */
  authenticate(request: Request, credentials: ProjectAuthCredentials): Promise<ProjectAuthActor>;
  async authenticate(
    request: ProjectAuthRpcMetadata | Request,
    credentials: ProjectAuthCredentials,
  ): Promise<ProjectAuthActor> {
    return await authenticateProjectRequest({
      credentials,
      projectId: this.props.projectId,
      request: projectAuthRequestFromRpc(request),
      validateSession: projectAppSessionValidator(),
    });
  }

  /**
   * Own login, callback, logout, and the host-only cookie. Returns null only
   * when this request belongs to a current project member. Like any partial
   * fetch, a null result leaves the request body untouched for the app.
   */
  fetch(request: Request): Promise<Response | null>;
  async fetch(request: ProjectAuthRpcMetadata | Request): Promise<Response | null> {
    return await handleProjectAuthFetch({
      osBaseUrl: parseConfig(env).baseUrl,
      projectId: this.props.projectId,
      request: projectAuthRequestFromRpc(request),
      validateSession: projectAppSessionValidator(),
    });
  }
}

/**
 * Session validation for project app hosts: local HS256 verification when the
 * shared secret is configured (the hot per-request path — no auth-worker
 * hop; the token's TTL bounds membership staleness), else the auth worker's
 * validate RPC, which also re-checks membership live. The mint side always
 * stays with the auth worker — it runs once per login, not per request.
 */
function projectAppSessionValidator(): (
  input: ValidateProjectAppSessionInput,
) => Promise<ValidatedProjectAppSession | null> {
  const secret = parseConfig(env).projectAppSessionSecret;
  if (secret === undefined) return (input) => env.AUTH.validateProjectAppSession(input);
  return localProjectAppSessionValidator(secret.exposeSecret());
}
/**
 * THE one table of project built-ins: member name -> one-line blip. The
 * `children` map in `__describe()` derives from it, so adding a built-in is
 * one entry here plus the getter on ProjectRpcTarget.
 */
const PROJECT_BUILTIN_BLIPS: Record<string, string> = {
  agents: "Agent catalog: get(path), list().",
  ai: "Workers AI: run(model, body), models(), toMarkdown({ name, blob }).",
  auth: "Project web auth: get(policy).fetch(request), or .authenticate(request, credentials) to construct an app RPC session.",
  browser: "Cloudflare Browser Run: quickAction(action, options), fetch().",
  capabilityHost:
    "This scope's own capability host: provideCapability({ path, ... }) mounts a dynamic capability here (itx.provideCapability is a shortcut), revokeCapability removes one, __describe() lists everything reachable, runScript runs a script in this scope.",
  capabilityHosts:
    'Capability hosts of OTHER scopes, addressed by path: itx.capabilityHosts.get("/") is the project root — providing there makes a capability visible to every scope in the project.',
  debug: "Returns formatted OS debug info for this itx scope, including a dashboard stream link.",
  devices:
    "Enrolled phone devices: list() discovers safe metadata; get(deviceId).append(...) requests a push notification.",
  egress: "Project-attributed outbound fetch (+ intercept).",
  email:
    "First-party email: send({ to, subject, text, html, attachments? }) from the project's own address (<slug>@<hostname base>); explicit `from` must match it. Attachments: project files by path or inline base64. Email thread agents (/agents/email/t<id>) reply with email.reply({ text, attachments? }).",
  docs: 'Find working code + types: search({ q: "many related words" }) over the example-script catalogue, type declarations, and mounted capabilities; get({ name }) fetches one.',
  files:
    "Project file storage: files.get(path) → put({ data, contentType }), bytes(), url() (signed public link), delete(). Agent scopes: prefer itx.agent.addFiles to store AND attach in one call.",
  integrations:
    'Integration connection families: get() selects the first connected account and get("<connection>") selects an exact one; e.g. itx.integrations.slack.get().chat.postMessage(...), gmail.get().request(...), github.get().octokit.rest.repos.get(...). list() enumerates all connections; other slugs resolve through the project capability table. Cloudflare first-party bindings live at itx.integrations.cf.{ai,browser,images,videos}.',
  kill: "Restart the project's server-side object; the next request boots it fresh.",
  kv: "Durable project key-value store for small policy knobs: get(key), set(key, value), delete(key), list({ prefix? }).",
  mcp: "Ad-hoc MCP clients: connect(url); itx.mcp.exa is the built-in Exa web search.",
  openapi: "Ad-hoc OpenAPI clients: connect(spec).",
  parallel: "Parallel API: preconfigured OpenAPI client using Iterate's platform API key.",
  processEventBatch:
    "The project's event-batch dispatch point: streams' birth-certificate feeds deliver here; delegates to worker.processEventBatch.",
  processor: "The project stream processor (snapshot/state).",
  provideCapability:
    "Shortcut: mount a capability on THIS scope (capabilityHost.provideCapability).",
  repo: "The project's config repo at /repos/config.",
  repos: "Repo catalog by path.",
  revokeCapability: "Shortcut: remove a mount from THIS scope.",
  sandboxes:
    'The project\'s sandboxes (pets): get("/sandboxes/<name>").create({ instanceType? }), list(); start/sleep/destroy live on the sandbox handle.',
  scheduler:
    'The default project Scheduler (= schedulers.get("/scheduler/primary")): set({ key, recurrence, script }) runs an itx script on a schedule; cancel(key), list(), trigger(key).',
  schedulers: "Scheduler catalog: get(path) for extra /scheduler/** instances.",
  secrets: "Secret catalog by path.",
  streams: "Project stream catalog: get(path), list().",
  worker: "The default repo-backed project worker.",
  workers: "Dynamic worker refs: get(ref).",
  workspaces:
    'Event-sourced, mount-routed workspaces by path: get("/workspaces/<name>") returns a possibly nonexistent handle; handle.create({ mounts? }) commits the atomic birth batch. git.commit({ scope? }) commits per mount. An agent\'s own workspace is itx.workspace.',
};

type ExistingProjectRpcTargetProps = {
  auth: ItxAuth;
  // This scope's own capability host. Its `path` decides which scope this itx
  // IS — `"/"` for the project root, `/agents/bla` for an agent context. It is
  // exposed as `itx.capabilityHost` and doubles as the fallback for dynamic
  // dotted-path calls (`itx.foo.bar(...)` → `capabilityHost.invokeCapability`).
  capabilityHost: CapabilityHostRpcTarget;
  ctx: CfExecutionContext;
  projectId: string;
};

type ProspectiveProjectRpcTargetProps = {
  auth: ItxAuth;
  ctx: CfExecutionContext;
  prospectiveSlug: string;
};

type ProjectRpcTargetProps = ExistingProjectRpcTargetProps | ProspectiveProjectRpcTargetProps;

/**
 * The server-side **itx** — the object an `async (itx) => { … }` script holds and
 * what `env.ITX.get()` returns. One class serves the project root and every nested
 * (agent) scope; the injected `capabilityHost` selects which scope's dynamic
 * capability table backs it.
 *
 * DESIGN NOTE — this RpcTarget sits *in front of* the capability-host Durable
 * Object. Its built-in members (`streams`, `agents`, `repo`, …) are resolved here
 * in the isolate; only unknown roots fall through the prototype-chain
 * fallback (the registry block at the bottom of this file) to the capability
 * host's dynamic table (which follows its journaled fallback host on a
 * miss). So the
 * common `itx.streams.get(...)` path never makes a round trip
 * just to check whether `streams` was shadowed. The deliberate cost: a dynamic
 * capability can never shadow a built-in name — the built-in always wins
 * (`rejectBuiltinCollision` enforces this at provide time). If we end up needing
 * shadowable built-ins a lot, we'd move resolution behind the DO and pay the
 * round trip; today we don't.
 */
/**
 * The project Durable Object's methods this isolate reaches — one typed view
 * instead of re-declaring each signature at every `durableObjectStub` cast.
 */
type ProjectDurableObjectRpc = {
  liveState: PromiseLike<LiveStateRpc<ProjectLiveState>>;
  notificationProcessor: PromiseLike<StreamProcessorRpc>;
  incrementLiveDemo(): Promise<void>;
  indexCommittedBatchFacts(input: { stream: TouchInput }): Promise<void>;
};

/**
 * An itx: the project capability surface, scoped to one path (the project
 * root "/", an agent path, ...). Built-ins (streams, repo, agents, files,
 * integrations, sandboxes, scheduler, docs, ...) are project-global and
 * identical at every scope; what differs by scope is the capability host
 * chain (which mounts resolve) and the agent-scope extras (`agent`, `chat`).
 * Unknown dotted members dispatch dynamically against the scope's capability
 * host, chaining up to the project root.
 */
export class ProjectRpcTarget extends IterateRpcTarget<"Project"> {
  // Private for the same reason as the other capability surfaces: public
  // member names are capability namespace (see ITX_SURFACE_MEMBER_NAMES).
  #props: ProjectRpcTargetProps;

  constructor(props: ProjectRpcTargetProps) {
    super();
    if ("projectId" in props) props.auth.assertCanAccessProject(props.projectId);
    this.#props = props;
  }

  get #existingProps(): ExistingProjectRpcTargetProps {
    if (!("projectId" in this.#props)) {
      throw new Error(
        `project "${this.#props.prospectiveSlug}" does not exist — create it with session.projects.get(${JSON.stringify(this.#props.prospectiveSlug)}).create({})`,
      );
    }
    return this.#props;
  }

  get #capabilityHost(): CapabilityHostRpcTarget {
    return this.#existingProps.capabilityHost;
  }

  get #projectId(): string {
    return this.#existingProps.projectId;
  }

  /** The project this itx is scoped into. */
  get projectId(): string {
    return this.#projectId;
  }

  /**
   * Register (for a prospective slug), append the complete root birth batch,
   * and drive both armed processors through it. By default, also wait for
   * `project/ready`; pass `waitUntilReady: false` when the caller renders
   * bootstrap progress itself. Either lane returns this same handle, and
   * addressing an unknown slug is side-effect free.
   */
  async create(
    args: { organizationSlug?: string; projectId?: string } = {},
    options?: { waitUntilReady?: boolean },
  ): Promise<ProjectRpcTarget> {
    if ("projectId" in this.#props && this.#capabilityHost.path !== "/") {
      throw new Error("project create() is only available on the project-root handle");
    }

    let registered: { organizationId: string | null; projectId: string; slug: string };
    if ("prospectiveSlug" in this.#props) {
      const prospective = this.#props;
      registered = await timedStep(
        "create-timing",
        { slug: prospective.prospectiveSlug },
        "auth-register",
        () =>
          this.#registerProject({
            ...args,
            slug: prospective.prospectiveSlug,
          }),
      );
      const timing = { projectId: registered.projectId };
      widenProjectAccess(prospective.auth, registered.projectId);
      await timedStep("create-timing", timing, "prime-directory", () =>
        primeProjectDirectory(env.PROJECT_DIRECTORY, {
          id: registered.projectId,
          slug: registered.slug,
          organizationId: registered.organizationId,
          name: registered.slug,
        }),
      );
      const existing: ExistingProjectRpcTargetProps = {
        auth: prospective.auth,
        capabilityHost: new CapabilityHostRpcTarget({
          auth: prospective.auth,
          ctx: prospective.ctx,
          path: "/",
          projectId: registered.projectId,
        }),
        ctx: prospective.ctx,
        projectId: registered.projectId,
      };
      existing.auth.assertCanAccessProject(existing.projectId);
      this.#props = existing;
    } else {
      if (args.projectId !== undefined && args.projectId !== this.#projectId) {
        throw new Error(
          `project create() received id "${args.projectId}" for handle "${this.#projectId}"`,
        );
      }
      const identity = await this.identity();
      registered = {
        organizationId: identity.organizationId,
        projectId: identity.projectId,
        slug: identity.slug,
      };
    }

    const timing = { projectId: registered.projectId };
    const creatorEmail = userPrincipalOf(this.#props.auth)?.email;
    const committed = await timedStep("create-timing", timing, "root-append", () =>
      retryStreamUnavailableOnce(
        () =>
          rootStream({ auth: this.#props.auth, projectId: registered.projectId }).append(
            ...projectCreationEvents({
              projectId: registered.projectId,
              payload: {
                config: {
                  onboardingActive: true,
                  slug: registered.slug,
                  ...(creatorEmail === undefined ? {} : { creatorEmail }),
                },
              },
            }),
          ),
        (error) => {
          console.info("project create: root stream lifecycle reset; replaying birth batch once", {
            projectId: registered.projectId,
            message: error instanceof Error ? error.message : String(error),
          });
        },
      ),
    );
    const maxOffset = Math.max(...committed.map((event) => event.offset));

    // The ingress API key is a sibling Secret birth with its own atomic
    // builder/create barrier. It remains outside the root stream batch because
    // secret material never belongs in the project journal.
    await timedStep("create-timing", timing, "seed-project-api-key", () =>
      env.SECRET.getByName(
        DurableObjectNameCodec.stringify({
          projectId: registered.projectId,
          path: normalizeSecretPath(PROJECT_API_KEY_SECRET_PATH),
        }),
      )
        .create({
          egress: { urls: [] },
          material: generateProjectApiKeyMaterial(),
          visibility: "readable",
        })
        .then(
          () => undefined,
          (error: unknown) => {
            console.warn("project create: api-key seed failed (ensure-create on reveal heals)", {
              projectId: registered.projectId,
              message: error instanceof Error ? error.message : String(error),
            });
          },
        ),
    );
    await timedStep("create-timing", timing, "wait-project-birth", () =>
      Promise.all([
        this.processor.waitUntilProcessed({
          offset: maxOffset,
          timeoutMs: PROCESSOR_BIRTH_WAIT_TIMEOUT_MS,
        }),
        this.notificationProcessor.waitUntilProcessed({
          offset: maxOffset,
          timeoutMs: PROCESSOR_BIRTH_WAIT_TIMEOUT_MS,
        }),
      ]),
    );
    if (options?.waitUntilReady !== false) {
      await timedStep("create-timing", timing, "wait-project-ready", () => this.waitUntilReady());
    }
    return this;
  }

  /** Register a prospective project with the auth-owned directory/id authority. */
  async #registerProject(args: {
    organizationSlug?: string;
    projectId?: string;
    slug: string;
  }): Promise<{ organizationId: string | null; projectId: string; slug: string }> {
    const userPrincipal = userPrincipalOf(this.#props.auth);
    if (userPrincipal) {
      const organizationSlug = resolveOrganizationSlugForCreate(
        userPrincipal,
        args.organizationSlug,
      );
      const result = await env.AUTH.createProjectForOrganization({
        organizationSlug,
        name: args.slug,
        slug: args.slug,
        ...(args.projectId === undefined ? {} : { id: args.projectId }),
      });
      if (!result.ok) throw new Error(result.message);
      return {
        organizationId: result.project.organizationId,
        projectId: result.project.id,
        slug: result.project.slug,
      };
    }
    if (!this.#props.auth.isAdmin()) {
      throw new Error(`principal "${this.#props.auth.principal}" cannot create projects`);
    }
    if (args.projectId !== undefined) {
      return { organizationId: null, projectId: args.projectId, slug: args.slug };
    }
    const minted = await env.AUTH.mintProjectId();
    return { organizationId: null, projectId: minted.id, slug: args.slug };
  }

  /**
   * Canonical identity from the project directory: id, slug (the auth
   * worker's normalized form — what URLs and ingress hostnames use),
   * organization, and display name. A directory read only — no project DO
   * dial — so it is safe pre-birth and cheap to pipeline through
   * `projects.get(slug).create()`.
   */
  async identity(): Promise<ProjectIdentity> {
    // readProjectById folds transient KV read errors into null; one retry
    // keeps a blip from reporting a just-created project as missing.
    const record =
      (await readProjectById(env.PROJECT_DIRECTORY, this.#projectId)) ??
      (await readProjectById(env.PROJECT_DIRECTORY, this.#projectId));
    if (record == null) {
      throw new Error(`Project ${this.#projectId} is missing from the project directory.`);
    }
    return {
      projectId: record.id,
      slug: record.slug,
      organizationId: record.organizationId,
      name: record.name,
    };
  }

  /**
   * Resolve once the bootstrap saga has committed `project/ready`. Replays
   * stream history first, so an already-ready project resolves immediately,
   * and dialing the processor here heals a lost birth wake rather than just
   * observing. `create()` waits here by default; this remains useful after a
   * non-blocking create or when a caller receives an existing handle while a
   * bootstrap is in flight.
   */
  async waitUntilReady(args?: { timeoutMs?: number }): Promise<void> {
    // snapshot() pulls the journal through the registry's catch-up, so this
    // wait drives a stalled saga instead of just watching it. Post-response
    // work (waitUntil), never awaited: a wedged DO dial must not burn the
    // caller's timeout budget before the timed waiter below even opens.
    this.#props.ctx.waitUntil(
      this.processor.snapshot().then(
        () => undefined,
        () => undefined,
      ),
    );
    await rootStream({ auth: this.#props.auth, projectId: this.#projectId }).waitForEvent({
      afterOffset: 0,
      eventTypes: ["events.iterate.com/project/ready"],
      // Tight on purpose: the saga should complete in seconds (see
      // tasks/os-cold-create-latency.md for the cold-slot outliers that must
      // be fixed, not waited out). Preview CI warms slots before the suites.
      timeoutMs: args?.timeoutMs ?? 60_000,
    });
  }

  /** @internal */
  get durableObjectStub() {
    return env.PROJECT.getByName(
      DurableObjectNameCodec.stringify({ path: "/", projectId: this.#projectId }),
    );
  }

  /**
   * Identity + full capability inventory: `projectId`/`name`, every reachable
   * capability (built-ins + dynamic mounts), the children map, and the
   * `Project` declaration in `types` (the full surface is one
   * `itx.docs.get({ name })` per declaration away).
   */
  async __describe(): Promise<ProjectDescription> {
    const scopePath = this.#capabilityHost.path;
    const [project, hostDescription] = await Promise.all([
      this.durableObjectStub.describe(),
      this.#capabilityHost.__describe(),
    ]);
    const mountedCapabilities = hostDescription.capabilities;
    return describeNode({
      instructions:
        `An itx: project "${project.name}" (${project.projectId}) at scope "${scopePath}". ` +
        "Built-ins are project-global and identical at every scope — `children` below lists them; `capabilities` lists this scope's dynamic mounts. " +
        "Unknown dotted members dispatch dynamically against this scope's capability host, chaining up to the project root. " +
        'To find anything — e2e-tested example scripts, type declarations, mounted capabilities — use itx.docs.search({ q: "several related words" }) then itx.docs.get({ name }); __describe() works on every child.',
      // The Project declaration alone is ~1.4k tokens; 2000 fits it plus a
      // little of its closure, and the trailer names the rest.
      types: typeSlice({
        declarations: ITX_API_DECLARATIONS_BY_NAME,
        rootName: "Project",
        maxTokens: 2000,
      }).sourceText,
      children: {
        ...PROJECT_BUILTIN_BLIPS,
        ...(scopePath.startsWith("/agents/")
          ? {
              agent: "THIS agent's control surface (present because this is an agent scope).",
              chat: "THIS agent's web-chat door.",
            }
          : {}),
      },
      parent: scopePath === "/" ? "session.projects" : `the project-root itx (scope "/")`,
      // Dynamic mounts only: the builtins are already the `children` map, and
      // repeating their rows (and their types) turned the identity card into
      // a 16KB wall that printed the same 29 members three times.
      capabilities: mountedCapabilities,
      name: project.name,
      projectId: project.projectId,
    });
  }

  /** Formatted dashboard/debug info for this itx scope, suitable for Slack messages. */
  async debug(): Promise<string> {
    const [project, config] = await Promise.all([
      readProjectById(env.PROJECT_DIRECTORY, this.#projectId).catch(() => null),
      Promise.resolve(parseConfig(env)),
    ]);
    const streamPath = this.#capabilityHost.path;
    const streamUrl =
      project?.slug == null
        ? (config.baseUrl ?? "https://os.iterate.com")
        : buildProjectStreamViewerUrl({
            baseUrl: config.baseUrl,
            projectSlug: project.slug,
            streamPath,
          });

    return [
      `*Debug:* <${streamUrl}|open stream>`,
      `Path: \`${streamPath}\``,
      `Project: \`${project?.slug ?? this.#projectId}\``,
    ].join("\n");
  }

  /** Restart the project's server-side object; the next request boots it fresh. */
  kill(): Promise<void> {
    return Promise.resolve(this.durableObjectStub.kill());
  }

  /** The project stream processor (snapshot/state; `state.ready` flips when bootstrap lands). */
  get processor(): WakeableStreamProcessorRpc<ProjectProcessorState> {
    return new ProcessorRelayRpcTarget<ProjectProcessorState>({
      auth: this.#props.auth,
      host: () => this.durableObjectStub as unknown as ProcessorHostStub,
    });
  }

  /** @internal Wake door for the notification-policy processor hosted beside
   * the public project processor. Persisted stream delivery resolves this
   * member through the project itx, but generated user APIs must not expose
   * processor-host plumbing as a product capability. */
  get notificationProcessor(): WakeableStreamProcessorRpc {
    return new ProcessorRelayRpcTarget({
      auth: this.#props.auth,
      host: () => this.durableObjectStub as unknown as ProcessorHostStub,
      processorFacade: (host) => (host as unknown as ProjectDurableObjectRpc).notificationProcessor,
    });
  }

  /** The project DO's methods this isolate reaches — typed once (see {@link ProjectDurableObjectRpc}). */
  get #projectDo(): ProjectDurableObjectRpc {
    return this.durableObjectStub as unknown as ProjectDurableObjectRpc;
  }

  /** The project's live state — reduced processor state plus non-folded slices. See {@link LiveStateRpc}. */
  get liveState(): LiveStateRpc<ProjectLiveState> {
    return new LiveStateRelayRpcTarget<ProjectLiveState>(() => this.#projectDo);
  }

  /** Demo capability for the live-state playground — `ticker` (stateless) + `increment()` (a durable server-side counter). */
  get liveDemo(): LiveDemoRpcTarget {
    return new LiveDemoRpcTarget(() => this.#projectDo.incrementLiveDemo());
  }

  /** Small durable project key-value store: get/set/delete/list. */
  get kv(): KvRpcTarget {
    return new KvRpcTarget(this.#projectId);
  }

  /** Workers AI: run(model, body), models(). */
  get ai(): AiRpcTarget {
    return new AiRpcTarget();
  }

  /** Browser auth for project-host web apps. */
  get auth(): ProjectAuthRpcTarget {
    return new ProjectAuthRpcTarget({
      auth: this.#props.auth,
      projectId: this.#projectId,
    });
  }

  /** Cloudflare Browser Run: quickAction() and raw fetch(). */
  get browser(): CfBrowserCapabilityRpcTarget {
    return new CfBrowserCapabilityRpcTarget();
  }

  // `agent` and `chat` are address-context conveniences for itx scopes under
  // `/agents/`. The path does not confer agent identity or create a processor:
  // `agent/created` does that, and operations on the returned handle assert the
  // birth certificate. Synchronous getters keep the contextual handle free of
  // bootstrap state while `env.ITX.get()` can return one class at every path.
  // On a project-root itx both are undefined.
  /** This scope's agent control handle, when its address is under `/agents/`. */
  get agent(): AgentRpcTarget | undefined {
    const path = this.#capabilityHost.path;
    return path.startsWith("/agents/") ? this.agents.get(path) : undefined;
  }

  /** THIS agent's web-chat door — present only on an agent-scoped itx. */
  get chat(): AgentChatRpcTarget | undefined {
    return this.agent?.chat;
  }

  // The scope's own host, plus the catalog that addresses ANY scope in the
  // project. Host operations live on the hosts — mounting is an operation on a
  // scope, and the scope is explicit at the callsite: `itx.capabilityHost`
  // mounts here, `itx.capabilityHosts.get("/")` mounts on the project root.
  // `provideCapability`/`revokeCapability` below are shortcuts onto the own
  // host, because own-scope mounting is the overwhelmingly common case.
  /**
   * This scope's own capability host: the durable capability table behind
   * this itx (`provideCapability`, `revokeCapability`, `runScript`,
   * `__describe`). Dynamic dotted calls (`itx.foo.bar(...)`) fall back to it.
   */
  get capabilityHost(): CapabilityHostRpcTarget {
    return this.#capabilityHost;
  }

  /**
   * Capability hosts of OTHER scopes, by path. `capabilityHosts.get("/")` is
   * the project root — providing there makes a capability visible to every
   * scope in the project (child scopes inherit ancestors' mounts).
   */
  get capabilityHosts(): CapabilityHostCollectionRpcTarget {
    return new CapabilityHostCollectionRpcTarget({
      auth: this.#props.auth,
      ctx: this.#props.ctx,
      projectId: this.#projectId,
    });
  }

  /** Shortcut for `capabilityHost.provideCapability` (mounts on THIS scope). */
  provideCapability(input: ProvideCapabilityInput): Promise<CapabilityProvisionRpcTarget> {
    return this.#capabilityHost.provideCapability(input);
  }

  /** Shortcut for `capabilityHost.revokeCapability`. */
  revokeCapability(input: RevokeCapabilityInput): Promise<void> {
    return this.#capabilityHost.revokeCapability(input);
  }

  /** Project stream catalog: get(path), list(). */
  get streams(): ProjectStreamCollectionRpcTarget {
    return new ProjectStreamCollectionRpcTarget({
      auth: this.#props.auth,
      projectId: this.#projectId,
    });
  }

  /** Agent catalog: get(path), list(). */
  get agents(): AgentCollectionRpcTarget {
    return new AgentCollectionRpcTarget({
      auth: this.#props.auth,
      ctx: this.#props.ctx,
      projectId: this.#projectId,
      // The "current actor": this itx's own scope path. Relative agent paths
      // resolve against it, and message() stamps it as the sender when the
      // scope is an agent — how delegated reports know who they are from.
      sourceScopePath: this.#capabilityHost.path,
    });
  }

  /** Project-attributed outbound fetch (+ intercept). */
  get egress(): ProjectEgressRpcTarget {
    return new ProjectEgressRpcTarget({ projectId: this.#projectId });
  }

  /** Project email: send(...) and the connection-scoped inbound address. */
  get email(): EmailCapabilityRpcTarget {
    return new EmailCapabilityRpcTarget({
      auth: this.#props.auth,
      projectId: this.#projectId,
      // The scope path makes email.reply thread-aware inside email agent
      // scopes; everywhere else reply throws with a pointer to send.
      scopePath: this.#capabilityHost.path,
    });
  }

  /** The docs door: `search({ q })` finds e2e-tested example scripts, type
   * declarations, and this scope's mounted capabilities; `get({ name })`
   * fetches one. Pass search MANY related words — matching is dumb word
   * overlap. */
  get docs(): ItxDocsRpcTarget {
    return new ItxDocsRpcTarget({ capabilityHost: this.#capabilityHost });
  }

  /** Project file storage (R2-backed): `files.get(path)` → put/bytes/url/delete. */
  get files(): FilesRpcTarget {
    return new FilesRpcTarget({
      auth: this.#props.auth,
      projectId: this.#projectId,
    });
  }

  /** The integrations collection: built-in connection families selected with
   * `.get()` (first connected) or `.get("slug")` (exact), provided
   * integrations through the capability table, management verbs, `list()`. */
  get integrations(): ProjectIntegrationsRpcTarget {
    return new ProjectIntegrationsRpcTarget({
      auth: this.#props.auth,
      ctx: this.#props.ctx,
      projectId: this.#projectId,
    });
  }

  /** Ad-hoc MCP clients: connect(url); `itx.mcp.exa` is the built-in Exa web search. */
  get mcp(): McpClientCollectionRpcTarget {
    return new McpClientCollectionRpcTarget({
      egress: projectEgressFetcher(this.#props.ctx.exports, this.#projectId),
      projectId: this.#projectId,
      // Makes beginOAuth links notify the calling agent when the flow completes.
      scopePath: this.#capabilityHost.path,
    });
  }

  /** Ad-hoc OpenAPI clients: connect(spec). */
  get openapi(): OpenApiCollectionRpcTarget {
    return new OpenApiCollectionRpcTarget({
      egress: projectEgressFetcher(this.#props.ctx.exports, this.#projectId),
    });
  }

  /** Parallel API, preconfigured with Iterate's platform API key. */
  get parallel(): OpenApiRpc {
    return parallelOpenApiTarget({
      egress: projectEgressFetcher(this.#props.ctx.exports, this.#projectId),
      parent: "a project itx (itx.parallel)",
    });
  }

  /** Repo catalog by path. */
  get repos(): ProjectRepoCollectionRpcTarget {
    return new ProjectRepoCollectionRpcTarget({
      auth: this.#props.auth,
      projectId: this.#projectId,
    });
  }

  /** Enrolled phone installations and their durable notification journals. */
  get devices(): DeviceCollectionRpcTarget {
    return new DeviceCollectionRpcTarget({
      auth: this.#props.auth,
      projectId: this.#projectId,
    });
  }

  /** The project's sandboxes — explicitly created, sized Linux containers
   * (`itx.sandboxes.get(path).create(input)` / `list`) — see {@link SandboxCollection}. */
  get sandboxes(): SandboxCollectionRpcTarget {
    return new SandboxCollectionRpcTarget({
      auth: this.#props.auth,
      projectId: this.#projectId,
    });
  }

  /** The default project Scheduler — shorthand for `schedulers.get("/scheduler/primary")`. */
  get scheduler(): SchedulerRpcTarget {
    return this.schedulers.get(SCHEDULER_PRIMARY_PATH);
  }

  /** Path-addressed Schedulers; the default at `/scheduler/primary` covers almost every use. */
  get schedulers(): SchedulerCollectionRpcTarget {
    return new SchedulerCollectionRpcTarget({
      auth: this.#props.auth,
      projectId: this.#projectId,
    });
  }

  /** Secret catalog by path. */
  get secrets(): SecretCollectionRpcTarget {
    return new SecretCollectionRpcTarget({
      auth: this.#props.auth,
      projectId: this.#projectId,
      // The scope path makes collectFromUser's links notify the calling
      // agent when the user submits; non-agent scopes mint plain links.
      scopePath: this.#capabilityHost.path,
    });
  }

  /** The project's config repo at /repos/config — shorthand for `repos.get("/repos/config")`. */
  get repo(): RepoRpcTarget {
    return new RepoRpcTarget({
      auth: this.#props.auth,
      path: CONFIG_REPO_PATH,
      projectId: this.#projectId,
    });
  }

  /** Dynamic worker refs: get(ref). */
  get workers(): DynamicWorkerCollectionRpcTarget {
    return new DynamicWorkerCollectionRpcTarget({
      auth: this.#props.auth,
      ctx: this.#props.ctx,
      projectId: this.#projectId,
    });
  }

  /** Path-addressed, event-sourced, mount-routed workspaces (`itx.workspaces.get(path)`). */
  get workspaces(): WorkspaceCollectionRpcTarget {
    return new WorkspaceCollectionRpcTarget({
      auth: this.#props.auth,
      projectId: this.#projectId,
    });
  }

  /**
   * Platform dispatch point: streams deliver committed event batches here
   * for the project worker. Scripts should not call this — subscribe to a
   * stream (or configure a subscription) instead.
   */
  // Why it exists (engineering, not caller-facing): every project-scoped
  // stream's subscription expression names `["processEventBatch"]` — the
  // INTENT, not the implementation — so envelope evolution happens here in
  // deployment code instead of by patching user repos, and first-party
  // per-event work joins the same ordered, checkpointed delivery. Same access
  // model as worker.processEventBatch itself: any project principal.
  async processEventBatch(batch: StreamPushEventBatch): Promise<void> {
    await this.#indexCommittedBatchFacts(batch);
    try {
      await this.worker.processEventBatch(batch);
    } catch (error) {
      // The bootstrap window: the worker cannot be MATERIALIZED yet (config
      // repo unseeded, or its first build still in flight). That is this
      // receiver being unavailable, not the batch being poison — say so in
      // the delivery contract's vocabulary so the spine backs off and
      // redelivers instead of skip-confirming real events. (A skipped
      // A skipped first batch loses real userspace reactions; this exact race
      // previously skipped offset 1 of every fresh project's root stream
      // against the config-repo seed.)
      if (isRepoNotSeededError(error) || isWorkerBuildInProgressError(error)) {
        throw new StreamReceiverUnavailableError(
          `project worker is not ready yet: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  /** Materialize one committed delivery's stream facts. */
  async #indexCommittedBatchFacts(batch: StreamPushEventBatch): Promise<void> {
    const last = batch.events.at(-1);
    if (last === undefined) return;

    await this.#projectDo.indexCommittedBatchFacts({
      stream: {
        path: batch.path,
        at: last.createdAt,
        type: last.type,
        maxOffset: batch.streamMaxOffset,
      },
    });
  }

  /**
   * The default repo-backed project worker — a convenience alias; the general
   * API is `workers.get(ref)`. Flattened: the seeded worker implements
   * invokeCapability in userspace, so a dotted call onto any getter the
   * worker adds (`itx.worker.<getter>.<method>(...)`) is one RPC end to end.
   */
  get worker(): DynamicWorkerCapability<ProjectWorker> {
    return new DynamicWorkerRpcTarget({
      ctx: this.#props.ctx,
      flattenNestedPaths: true,
      projectId: this.#projectId,
      ref: defaultProjectWorkerRef(),
      traceRole: "project_config",
    }) as unknown as DynamicWorkerCapability<ProjectWorker>;
  }
}

// Provide-time collision guard: a dynamic capability's root segment may not
// shadow any member of the itx-facing surfaces — built-ins always win
// isolate-side resolution (see the ProjectRpcTarget design note), so a mount
// behind one would be silently unreachable. Prototypes are the whole story
// because these classes keep their state in #private fields (invisible to
// `in` and to Object.getOwnPropertyNames), so no instance-field entries are
// needed here.
const ITX_SURFACE_MEMBER_NAMES: ReadonlySet<string> = new Set(
  [ProjectRpcTarget.prototype, AgentRpcTarget.prototype, CapabilityHostRpcTarget.prototype].flatMap(
    (prototype) => Object.getOwnPropertyNames(prototype),
  ),
);

/**
 * THE one recipe for constructing an itx: a ProjectRpcTarget wired to the
 * capability host at `path`. Everything that vends an itx goes through here —
 * session.projects.get/create (path "/"), the ItxEntrypoint behind dynamic
 * workers' env.ITX, and the capability-host DO's own script-execution itx —
 * so scope wiring cannot drift between them.
 */
export function itxForScope(props: {
  auth: ItxAuth;
  ctx: CfExecutionContext;
  path: string;
  projectId: string;
}): ProjectRpcTarget {
  return new ProjectRpcTarget({
    auth: props.auth,
    capabilityHost: new CapabilityHostRpcTarget(props),
    ctx: props.ctx,
    projectId: props.projectId,
  });
}

/**
 * The deployment-global trusted root: what a GLOBAL (`projectId: null`)
 * stream's delivery dial evaluates expressions against. Session-shaped on
 * purpose — deployment-wide repos/streams live on the session — so a global
 * repo stream's wake expression (`["repos", ["get", path], "processor",
 * "wakeStreamSubscriber"]`) walks the same shape a project stream's does.
 */
export function deploymentItxForInternal(props: { auth: ItxAuth; ctx: CfExecutionContext }) {
  return new SessionRpcTarget(props);
}

async function projectProcessorState(projectId: string) {
  const project = env.PROJECT.getByName(DurableObjectNameCodec.stringify({ path: "/", projectId }));
  const processor = await project.processor;
  const { state } = await processor.snapshot();
  return state;
}

/**
 * What you authenticate into: a catalog that vends itxs.
 *
 * A session is NOT an itx — it is the directory you use to reach one.
 * `projects` is principal-scoped. `streams` and `repos` here are the
 * deployment-wide surfaces backed by `projectId: null`, so only admin/internal
 * auth can reach them.
 */
class SessionRpcTarget extends IterateRpcTarget<"Session"> {
  constructor(readonly props: { auth: ItxAuth; config?: AppConfig; ctx: CfExecutionContext }) {
    super();
  }

  /** Includes `principal` — who this session is. */
  async __describe(): Promise<Description & { principal: string }> {
    return describeNode({
      instructions:
        "An OS Session: the catalog authenticate() returned. Not a project context — use projects.get(id)/create({ slug }) to obtain one. `principal` is who you are.",
      children: {
        projects: "Project catalog: list(), get(projectId), create({ slug }) — each vends an itx.",
        repos: "Deployment-wide repos (admin only; projectId: null).",
        streams: "Deployment-wide streams (admin only; projectId: null).",
      },
      parent: "the /api unauthenticated entrypoint, via authenticate(credentials)",
      principal: this.props.auth.principal,
    });
  }

  /** Deployment-wide streams (admin only; projectId: null). */
  get streams(): StreamCollectionRpcTarget {
    return new StreamCollectionRpcTarget({
      auth: this.props.auth,
      projectId: null,
    });
  }

  /** Deployment-wide repos (admin only; projectId: null). */
  get repos(): RepoCollectionRpcTarget {
    return new RepoCollectionRpcTarget({
      auth: this.props.auth,
      projectId: null,
    });
  }

  /** Project catalog: list(), get(projectId), create({ slug }) — each vends an itx. */
  get projects(): ProjectCollectionRpcTarget {
    return new ProjectCollectionRpcTarget({
      auth: this.props.auth,
      config: this.props.config,
      ctx: this.props.ctx,
    });
  }
}

/**
 * Entry point exposed before any principal or project authority is known.
 *
 * `/api` hands every caller one of these; the only thing it can do is
 * `authenticate(...)`, which on success returns a {@link Session}. This is the
 * canonical Cap'n Web pattern: authority cannot be forged, only handed back by a
 * method that already checked you.
 */
export class UnauthenticatedOsRpcTarget extends IterateRpcTarget<"UnauthenticatedOs"> {
  constructor(
    readonly props: {
      config: AppConfig;
      ctx: CfExecutionContext;
      headers: Headers;
      requestUrl: string;
    },
  ) {
    super();
  }

  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        "os' one API (/api), before any authority is known. authenticate(credentials) is the only door; it returns a Session.",
      children: {
        authenticate: "Exchange credentials (session cookie, bearer, admin secret) for a Session.",
      },
    });
  }

  /** Exchange credentials for a {@link Session}; rejects when they prove nothing. */
  async authenticate(input: ItxAuthCredentials): Promise<SessionRpcTarget> {
    const auth = await resolveItxAuth({
      config: this.props.config,
      credentials: input,
      headers: this.props.headers,
      requestUrl: this.props.requestUrl,
      // The project-secret lane's verifier: a one-bit constant-time compare
      // INSIDE the project's born ingress-credential Secret DO — material
      // never leaves the secret system, this door included.
      verifyProjectSecret: ({ projectId, secret }) =>
        env.SECRET.getByName(
          DurableObjectNameCodec.stringify({
            projectId,
            path: normalizeSecretPath(PROJECT_API_KEY_SECRET_PATH),
          }),
        ).verifyMaterialField({ value: secret }),
      // The project-app-session lane's verifier: local HS256 against the
      // shared session secret — no auth-worker hop; membership was checked
      // at mint time and the token's 15-minute TTL bounds revocation lag.
      verifyProjectAppSession: async (token) => {
        const secret = this.props.config.projectAppSessionSecret;
        if (secret === undefined) return null;
        const claims = await verifyProjectAppSessionToken(token, secret.exposeSecret());
        return claims === null ? null : { projectId: claims.projectId, userId: claims.userId };
      },
    });
    return new SessionRpcTarget({ auth, config: this.props.config, ctx: this.props.ctx });
  }
}

// ---------------------------------------------------------------------------
// Every OS-owned RpcTarget that defines or relays an itx contract lives in this
// module. Transport primitives shared with userspace, such as the read-only
// target from `iterate/sdk/capnweb`, stay in that package; the local relay below
// only bridges that target across the Durable Object hop.
// ---------------------------------------------------------------------------

type RevokeCapability = (input: RevokeCapabilityInput) => Promise<void>;

/**
 * Stateful page reader for one stream read window.
 *
 * A tiny object-capability cursor: it holds only the caller's read window and
 * the last offset it returned, so there is no server-side snapshot or lease to
 * maintain (events still come from the Stream DO on every page). This is not a
 * live subscription; `[]` means "caught up for now". Dispose it when finished
 * (`using pager = stream.readEvents(...)`).
 */
class StreamEventPagerRpcTarget extends IterateRpcTarget<"StreamEventPager"> {
  readonly #input: Omit<StreamEventReadInput, "afterOffset">;
  readonly #readPage: (input?: StreamEventReadInput) => Promise<StreamEvent[]>;
  #afterOffset: number;
  #disposed = false;

  constructor(
    readPage: (input?: StreamEventReadInput) => Promise<StreamEvent[]>,
    input: StreamEventReadInput = {},
  ) {
    super();
    const { afterOffset = 0, ...pageInput } = input;
    this.#afterOffset = afterOffset;
    this.#input = pageInput;
    this.#readPage = readPage;
  }

  /** Returns [] when no newer matching page is currently available. */
  async next(): Promise<StreamEvent[]> {
    if (this.#disposed) throw new Error("stream event pager is disposed.");
    const page = await this.#readPage({
      ...this.#input,
      afterOffset: this.#afterOffset,
    });
    const lastOffset = page.at(-1)?.offset;
    if (lastOffset !== undefined) this.#afterOffset = lastOffset;
    return page;
  }

  [Symbol.dispose](): void {
    this.#disposed = true;
  }
}

/**
 * Ownership handle for one `provideCapability()` call.
 *
 * Cap'n Web and Workers RPC model returned class instances as object
 * capabilities: callers hold a stub and dispose that stub when they are done.
 * See:
 * - https://github.com/cloudflare/capnweb#memory-management
 * - https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
 *
 * We still keep the explicit `revoke()` method because it is a domain operation
 * callers can await and assert on. `[Symbol.dispose]` is the lifecycle fallback
 * for scopes (`using provision = ...`) and abandoned stubs. The handle is keyed
 * by the stream offset that mounted the capability, so disposing an older
 * provision after a replacement cannot revoke the newer mount at the same path.
 */
class CapabilityProvisionRpcTarget extends IterateRpcTarget<"CapabilityProvision"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions: `The ownership handle for the mount at "${this.path.join(".")}" (providedAtOffset ${this.providedAtOffset}): revoke() removes exactly this mount; disposal (\`using\`) revokes too.`,
      children: { revoke: "Remove this mount." },
      parent: "returned by provideCapability",
    });
  }

  readonly #ctx: Pick<CfExecutionContext, "waitUntil"> | undefined;
  readonly #path: string[];
  readonly #providedAtOffset: number;
  readonly #revoke: RevokeCapability;
  #revokePromise: Promise<void> | undefined;

  constructor(args: {
    ctx?: Pick<CfExecutionContext, "waitUntil">;
    path: string[];
    providedAtOffset: number;
    revoke: RevokeCapability;
  }) {
    super();
    this.#ctx = args.ctx;
    this.#path = [...args.path];
    this.#providedAtOffset = args.providedAtOffset;
    this.#revoke = args.revoke;
  }

  /** The capability path this mount claimed. */
  get path(): string[] {
    return [...this.#path];
  }

  /** The stream offset of the `capability-provided` event this handle owns. */
  get providedAtOffset(): number {
    return this.#providedAtOffset;
  }

  /** Remove exactly this mount (never a newer mount at the same path). */
  async revoke(): Promise<void> {
    await this.#startRevoke();
  }

  [Symbol.dispose](): void {
    const work = this.#startRevoke().catch((error: unknown) => {
      console.error("capability provision dispose failed", {
        error,
        path: this.#path,
        providedAtOffset: this.#providedAtOffset,
      });
    });
    this.#ctx?.waitUntil?.(work);
  }

  #startRevoke(): Promise<void> {
    this.#revokePromise ??= this.#revoke({
      path: this.#path,
      providedAtOffset: this.#providedAtOffset,
    });
    return this.#revokePromise;
  }
}

/**
 * RPC ownership handle for a live stream connection.
 *
 * This follows Cap'n Web/Workers RPC lifecycle conventions: returned class
 * instances are object capabilities, and `using`/`[Symbol.dispose]` releases
 * the caller's ownership of the live resource.
 *
 * Docs:
 * - https://github.com/cloudflare/capnweb#memory-management
 * - https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
 *
 * `unsubscribe()` remains the explicit, awaitable domain operation. Disposal is
 * the scoped cleanup path and calls the same captured close function. Capturing
 * the close function matters: a later subscription can reuse the same key, and
 * an old handle must not look up by key and close the replacement.
 */
export class StreamSubscriptionRpcTarget extends IterateRpcRelay<"StreamSubscriptionHandle"> {
  readonly #close: () => void;
  readonly #isLive: () => boolean;
  readonly #streamMaxOffset: number;
  readonly #subscriptionKey: string;
  #closed = false;

  constructor(args: {
    close: () => void;
    isLive: () => boolean;
    streamMaxOffset: number;
    subscriptionKey: string;
  }) {
    super();
    this.#close = args.close;
    this.#isLive = args.isLive;
    this.#streamMaxOffset = args.streamMaxOffset;
    this.#subscriptionKey = args.subscriptionKey;
  }

  /** Stable identity of this subscription connection. */
  get subscriptionKey(): string {
    return this.#subscriptionKey;
  }

  /** The stream's max offset at subscribe time (replay starts behind it). */
  get streamMaxOffset(): number {
    return this.#streamMaxOffset;
  }

  /**
   * Liveness probe (see `StreamSubscriptionHandle.ping` in
   * domains/streams/rpc-types.ts). Captures
   * the connection's own open flag, not a lookup by key, so a replacement
   * subscription under the same key reports `false` here.
   */
  ping(): boolean {
    return !this.#closed && this.#isLive();
  }

  /** Close this connection; safe to call more than once. */
  unsubscribe(): void {
    this.#closeOnce();
  }

  [Symbol.dispose](): void {
    this.#closeOnce();
  }

  #closeOnce(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#close();
  }
}

/**
 * Public project egress facet.
 *
 * The Project Durable Object is the single egress decision point: it owns the
 * live runtime interceptor slot and, when there is no interceptor, performs the
 * terminal secret-substitution fetch path.
 */
class ProjectEgressRpcTarget extends IterateRpcTarget<"ProjectEgress"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        "Project-attributed outbound fetch: fetch(request) egresses with the project's identity and secret substitution. Headers and URL paths interpolate getSecret(...); an application/json body substitutes exact string values when x-iterate-secret-template: json is set. intercept(handler) installs a live egress interceptor (last writer wins).",
      children: {
        fetch: "Outbound fetch through project egress.",
        intercept: "Install an egress interceptor; returns a release handle.",
      },
      parent: "a project itx (itx.egress)",
    });
  }

  constructor(readonly props: { projectId: string }) {
    super();
  }

  /** Outbound fetch with project identity and secret substitution. Set
   * `x-iterate-secret-template: json` to replace exact `getSecret(...)` string
   * values in an `application/json` (or `+json`) body. */
  fetch(request: Request): Promise<EgressResponse> {
    return projectStub(env.PROJECT, this.props.projectId).fetch(request);
  }

  /** Install a live egress interceptor (last writer wins); returns a release handle. */
  intercept(handler: ProjectEgressInterceptor): Promise<ProjectEgressIntercept> {
    return projectStub(env.PROJECT, this.props.projectId).interceptEgress(handler);
  }
}

/**
 * Disposable ownership handle returned by `project.egress.intercept(...)`.
 *
 * The Project Durable Object owns the retained live callback. This handle only
 * releases that exact retained callback if it is still the current interceptor.
 */
export class ProjectEgressInterceptRpcTarget extends IterateRpcRelay<"ProjectEgressIntercept"> {
  readonly #ctx: Pick<CfExecutionContext, "waitUntil"> | undefined;
  readonly #release: () => void | Promise<void>;
  #releasePromise: Promise<void> | undefined;

  constructor(args: {
    ctx?: Pick<CfExecutionContext, "waitUntil">;
    release: () => void | Promise<void>;
  }) {
    super();
    this.#ctx = args.ctx;
    this.#release = args.release;
  }

  /** Release this interceptor if it is still the current one. */
  async release(): Promise<void> {
    await this.#startRelease();
  }

  [Symbol.dispose](): void {
    const work = this.#startRelease().catch((error: unknown) => {
      console.error("project egress intercept dispose failed", { error });
    });
    this.#ctx?.waitUntil?.(work);
  }

  #startRelease(): Promise<void> {
    this.#releasePromise ??= Promise.resolve(this.#release());
    return this.#releasePromise;
  }
}

/**
 * The read-only capability a hosting Durable Object hands out for one of its
 * processors.
 *
 * A `StreamProcessor` is itself an `RpcTarget`, and its fold lives in the
 * driving StreamProcessorRunner, not the instance — so the readable surface is
 * the registry's runner-backed reads (`registry.reads(processor)`,
 * stream-processor-registry.ts), and this facade forwards only the inspection
 * methods of the public `StreamProcessorRpc` contract. Returning a processor
 * instance over RPC would expose author-side plumbing without answering a
 * single read correctly.
 */
export class StreamProcessorRpcTarget<State, PublicState = State>
  extends IterateRpcRelay<"StreamProcessorRpc">
  implements StreamProcessorRpc<PublicState>
{
  readonly #reads: ProcessorReads<State>;
  readonly #catchUpBeforeSnapshot: (() => Promise<void>) | undefined;
  readonly #publicState: ((state: State) => PublicState) | undefined;

  constructor(
    reads: ProcessorReads<State>,
    options: {
      /**
       * Registry-provided pull-through (`StreamProcessorRegistry.catchUp`):
       * snapshots served over this target reflect events the push delivery
       * has not brought yet, giving remote readers read-your-writes.
       */
      catchUpBeforeSnapshot?: () => Promise<void>;
      /**
       * Projection applied to EVERY state that leaves this facade — snapshots
       * and runtime state. This is where a domain redacts internals from its
       * public state (secrets project away the ciphertext, exposing
       * `hasMaterial` instead); the node's `.liveState` applies the SAME
       * redaction through the host's `getLiveState`. Omitted = identity.
       */
      publicState?: (state: State) => PublicState;
    } = {},
  ) {
    super();
    this.#reads = reads;
    this.#catchUpBeforeSnapshot = options.catchUpBeforeSnapshot;
    this.#publicState = options.publicState;
  }

  #project(state: State): PublicState {
    return this.#publicState === undefined
      ? (state as unknown as PublicState)
      : this.#publicState(state);
  }

  async snapshot(): Promise<ProcessorSnapshot<PublicState>> {
    await this.#catchUpBeforeSnapshot?.();
    const { offset, state } = await this.#reads.snapshot();
    return { offset, state: this.#project(state) };
  }

  async getRuntimeState() {
    const runtimeState = await this.#reads.getRuntimeState();
    return {
      ...runtimeState,
      snapshot: {
        offset: runtimeState.snapshot.offset,
        state: this.#project(runtimeState.snapshot.state),
      },
    };
  }

  async waitUntilProcessed(input: { offset: number; timeoutMs?: number }) {
    // The runner waiter registers first, then starts its own serialized
    // self-pull. Its timeout therefore bounds the WHOLE read-your-writes
    // operation. Awaiting catchUpBeforeSnapshot here first made timeoutMs
    // dishonest: a stuck catch-up could hold this call forever before the
    // timed waiter even existed.
    await this.#reads.waitUntilEvent(input);
  }
}

// The examples catalogue is plain data (src/itx/examples.ts) shared with the
// REPL "Examples" panel and the e2e matrix. Exposing it as a built-in lets
// agents and scripts browse known-good snippets instead of guessing at the
// surface. Session-context entries are excluded: they run against the OS
// Session (what authenticate() returns), which an itx holder does not have.
// Project AND agent context: the docs door answers agents above all, and an
// agent itx is the project surface plus its own mounts. Session-only
// examples stay out — a project/agent scope cannot run them.
const PROJECT_CONTEXT_EXAMPLES = ITX_EXAMPLES.filter((example) => example.context !== "session");

/**
 * The docs door: search + fetch over everything callable from this scope —
 * the platform's example scripts (most are proven: the test suite runs them
 * unattended against a live project on every change; the rest are marked
 * interactive), the public type surface (the Itx Type Graph), and the
 * capabilities reachable from the caller's scope. One door for "how do I
 * X?": search first, fetch what the hits name, adapt working code.
 *
 * The search mechanism is deliberately dumb (word matching, no embeddings),
 * which is why every docstring here tells callers to pass MANY related words
 * — recall comes from the query, not the engine.
 */
class ItxDocsRpcTarget extends IterateRpcTarget<"Docs"> {
  readonly #capabilityHost: CapabilityHostRpcTarget;

  constructor(props: { capabilityHost: CapabilityHostRpcTarget }) {
    super();
    this.#capabilityHost = props.capabilityHost;
  }

  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        "Search + fetch over everything callable from this scope: working example scripts (proven ones run unattended against a live project in the platform's test suite — copy those first), the public type surface, and this scope's mounted capabilities. " +
        'search({ q }) with MANY related words — the matching is dumb word overlap, so q: "email gmail inbox unread messages" beats q: "email". ' +
        "get({ name }) fetches what a hit names: an example's full annotated code, a type declaration with its referenced types, or a mounted capability's instructions + types. " +
        "typecheck({ code }) compiles an `async (itx) => { … }` script against this scope's types without running it.",
      children: {
        get: "Fetch one entry by name: an example's full code, a type declaration closure, or a mount's types.",
        search:
          "Find examples, types, and mounted capabilities by keywords (pass many related words).",
        typecheck: "Compile a script against this scope's types without running it (advisory).",
      },
      parent: "a project itx (itx.docs)",
    });
  }

  /**
   * Find examples, types, and mounted capabilities. Pass MANY related words —
   * matching is dumb word overlap, so more synonyms means better recall:
   * `search({ q: "file upload attachment bytes store image" })`, not
   * `search({ q: "files" })`. API-name queries work too: "itx" is dropped as
   * noise and a word matching a row's NAME counts double, so `"itx.docs"`,
   * `"worker"`, or `"agents"` rank their subject first instead of every row
   * that mentions the word. Example hits are working scripts — prefer copying
   * them over writing calls from scratch. Each hit's `fetchCall` field holds
   * the ready-made docs.get call that fetches its full doc.
   */
  async search(input: { q: string }): Promise<DocsSearchHit[]> {
    const scored: Array<{ hit: DocsSearchHit; score: number; proven?: boolean }> = [];

    for (const example of PROJECT_CONTEXT_EXAMPLES) {
      // Prose only, no code: code tokens made incidental matches (a fake
      // capability demo containing "create"/"message" in its script) outrank
      // the example whose TITLE says what the searcher wants. Recall for
      // API-name queries still works — ids/titles/descriptions name their
      // subjects, and type declarations cover the rest. A word landing in
      // the row's NAME counts twice: `search({ q: "docs" })` must rank
      // docs-search-and-get above every row that merely mentions itx.docs.
      const score =
        searchScore(input.q, `${example.id} ${example.title} ${example.description}`) +
        searchScore(input.q, example.id);
      if (score === 0) continue;
      scored.push({
        score,
        // e2eProven?: false — ABSENT means proven (the matrix runs it);
        // explicit false means interactive-only.
        proven: example.e2eProven !== false,
        hit: {
          kind: "example",
          name: example.id,
          summary: `${example.title} — ${example.description}`,
          fetchCall: `await itx.docs.get({ name: ${JSON.stringify(example.id)} })`,
        },
      });
    }

    for (const declaration of ITX_API_DECLARATIONS) {
      const memberText = Object.entries(declaration.memberSummaries)
        .map(([member, summary]) => `${member} ${summary}`)
        .join(" ");
      // Hub declarations (Project, Docs, ...) carry every member's summary in
      // their haystack and would match almost any query wholesale, crowding
      // the examples out of the one screenful of hits. A word landing in the
      // declaration's own name/summary counts fully; a member-only match
      // counts half.
      const score =
        weightedDeclarationScore({
          query: input.q,
          ownText: `${declaration.name} ${declaration.summary}`,
          memberText,
        }) + searchScore(input.q, declaration.name);
      if (score === 0) continue;
      scored.push({
        score,
        hit: {
          kind: "type",
          name: declaration.name,
          summary: declaration.summary,
          fetchCall: `await itx.docs.get({ name: ${JSON.stringify(declaration.name)} })`,
        },
      });
    }

    // Capabilities mounted in this scope's chain (agent scope sees its own
    // mounts plus the project root's) — the part of the surface no static
    // corpus can know. The haystack includes the mount's Capability Type
    // Declaration, so its method names and member docs are searchable.
    const { capabilities } = await this.#capabilityHost.__describe();
    for (const capability of capabilities) {
      if (capability.type === "builtin") continue; // builtins are covered by their type declarations
      const dottedPath = capability.path.join(".");
      const instructions = capability.instructions ?? "";
      const score =
        searchScore(input.q, `${dottedPath} ${instructions} ${capability.types ?? ""}`) +
        searchScore(input.q, dottedPath);
      if (score === 0) continue;
      scored.push({
        score,
        hit: {
          kind: "capability",
          name: dottedPath,
          summary: oneLineSummary(instructions) || "(no instructions recorded)",
          fetchCall: `await itx.docs.get({ name: ${JSON.stringify(dottedPath)} })`,
        },
      });
    }

    // Equal-score tie-break mirrors the guidance: working examples first,
    // scope-specific mounts next, type reference last; 12 hits is about one
    // screenful for a model.
    const kindRank: Record<DocsSearchHit["kind"], number> = { example: 0, capability: 1, type: 2 };
    return scored
      .sort(
        (a, b) =>
          b.score - a.score ||
          kindRank[a.hit.kind] - kindRank[b.hit.kind] ||
          // Proven examples (run unattended against a live project on every
          // change) outrank interactive-only ones — alphabetical order was
          // deciding real ties before.
          Number(b.proven ?? false) - Number(a.proven ?? false) ||
          a.hit.name.localeCompare(b.hit.name),
      )
      .slice(0, 12)
      .map((entry) => entry.hit);
  }

  /**
   * Fetch one entry by the name a search hit gave you. An example name
   * returns its full script, annotated with its provenance (most examples
   * run unattended against a live project in the platform's test suite; the
   * rest are marked interactive); a type declaration name returns its
   * TypeScript source plus as much of its reference closure as fits
   * `maxTokens` (default 1500), ending with a comment naming anything left
   * out and how to fetch it; a mounted capability's dotted path (say
   * "tools.weather") returns its instructions and types plus the platform
   * declarations those types reference, same budget rules.
   */
  async get(input: { name: string; maxTokens?: number }): Promise<string> {
    const example = PROJECT_CONTEXT_EXAMPLES.find((candidate) => candidate.id === input.name);
    if (example) {
      // Paste-ready for the codemode contract: the annotation lives INSIDE
      // the function (a response block must START with `async` — leading
      // comments die silently), and `vars` is bound so the body's example
      // inputs (`vars.foo ?? fallback`) resolve to their fallbacks until the
      // caller substitutes real values.
      return [
        "async (itx) => {",
        `  // EXAMPLE ${JSON.stringify(example.id)}: ${example.title}`,
        example.e2eProven === false
          ? `  // From the example catalogue (interactive: depends on a connected account or external service).`
          : `  // Proven: this exact script runs unattended against a live project in the platform's test suite.`,
        `  // ${example.description}`,
        `  const vars = {}; // example inputs — replace \`vars.x ?? fallback\` with real values`,
        example.code,
        "}",
      ].join("\n");
    }
    // Clamp instead of reject: an out-of-range value from a model should
    // cost a degraded answer, not a wasted turn. The floor covers the
    // trailer reserve plus one small declaration.
    const maxTokens = Number.isFinite(input.maxTokens)
      ? Math.min(Math.max(input.maxTokens!, 300), 10_000)
      : 1500;
    // A mounted capability's dotted path: slice from a synthetic declaration
    // built from the mount's durable metadata, so the walk crosses from the
    // scope layer into the platform declarations its types reference. Mounts
    // resolve BEFORE platform declarations: a mount can never collide with a
    // BUILTIN member (rejectBuiltinCollision), but nothing stops one sharing
    // a platform TYPE name, and the caller's own mount is the likelier ask.
    const { capabilities } = await this.#capabilityHost.__describe();
    const mount = capabilities.find(
      (capability) => capability.type !== "builtin" && capability.path.join(".") === input.name,
    );
    if (mount) {
      const synthetic = mountDeclaration({
        declarations: ITX_API_DECLARATIONS_BY_NAME,
        dottedPath: input.name,
        instructions: mount.instructions,
        types: mount.types,
      });
      const declarations = new Map(ITX_API_DECLARATIONS_BY_NAME);
      declarations.set(synthetic.name, synthetic);
      return typeSlice({ declarations, rootName: synthetic.name, maxTokens }).sourceText;
    }
    if (ITX_API_DECLARATIONS_BY_NAME.has(input.name)) {
      return typeSlice({
        declarations: ITX_API_DECLARATIONS_BY_NAME,
        rootName: input.name,
        maxTokens,
      }).sourceText;
    }
    // A builtin's itx member name ("docs", "workspace") is the natural thing
    // to ask for after __describe(); resolve it to its declaration ("Docs")
    // instead of erroring with unrelated closest-matches.
    const caseInsensitive = [...ITX_API_DECLARATIONS_BY_NAME.keys()].find(
      (name) => name.toLowerCase() === input.name.toLowerCase(),
    );
    if (caseInsensitive !== undefined) {
      return typeSlice({
        declarations: ITX_API_DECLARATIONS_BY_NAME,
        rootName: caseInsensitive,
        maxTokens,
      }).sourceText;
    }
    const nearest = (await this.search({ q: input.name })).slice(0, 3);
    throw new Error(
      `unknown docs entry ${JSON.stringify(input.name)}` +
        (nearest.length > 0
          ? ` — closest matches: ${nearest.map((hit) => hit.name).join(", ")}`
          : "") +
        `. itx.docs.search({ q: "several related words" }) finds examples, types, and capabilities.`,
    );
  }

  /**
   * Typecheck an `async (itx) => { … }` script against this scope's surface —
   * the platform types plus every mounted capability's types (npm-backed
   * `import("pkg")` types resolve too) — WITHOUT running it. Advisory: a
   * clean result does not promise the script works, but a typo like
   * `itx.streams.gett(...)` comes back as a compiler error with a
   * did-you-mean instead of costing a failed run.
   */
  async typecheck(input: { code: string }): Promise<{ ok: boolean; problems: string[] }> {
    const { capabilities } = await this.#capabilityHost.__describe();
    const problems = await checkItxScript({
      capabilities,
      code: input.code,
      typechecker: env.TYPECHECKER,
    });
    return { ok: problems.length === 0, problems };
  }
}

/**
 * Narrow structural view of a processor-hosting Durable Object stub: every
 * host class (agent, capability-host, project, repo, scheduler, secret)
 * exposes the same `processor` facade property and the same host-level wake
 * handshake, so the relay works over one shape instead of six stub types.
 */
type ProcessorHostStub = {
  processor: PromiseLike<unknown>;
  wakeStreamSubscriber(request: StreamSubscriberWakeRequest): Promise<StreamSubscriberWakeResponse>;
};

/** The Project DO hosts three integration routers alongside its primary
 * Project processor. Their public handles must select the matching runner-
 * backed read facade; the default `processor` property intentionally remains
 * the Project processor. */
type ProjectRouterProcessorHostStub = ProcessorHostStub & {
  emailProcessor: PromiseLike<unknown>;
  slackProcessor: PromiseLike<unknown>;
  telegramProcessor: PromiseLike<unknown>;
};

const PROCESSOR_WAIT_REACQUIRE_MS = 10_000;

/**
 * Isolate-side relay for a Durable-Object-hosted processor facade.
 *
 * A DO stub's `.processor` is a Workers RPC PROPERTY read, and method calls
 * cannot be pipelined through property reads across the DO boundary: a capnweb
 * client evaluating `itx.processor.snapshot()` descends into the property's
 * thenable and fabricates exactly that pipeline, which workerd rejects with
 * `The RPC receiver does not implement the method "snapshot"`. (Awaiting the
 * property first, then calling, works — that's what this relay does.)
 *
 * So the isolate-side `processor` getters must not hand the raw stub property
 * across capnweb. This relay is a real RpcTarget at the property position:
 * each method awaits the resolved processor stub, then makes a plain method
 * call on it.
 *
 * It is also the host's WAKE DOOR (see {@link WakeableStreamProcessorRpc}):
 * `wakeStreamSubscriber` forwards to the host Durable Object's top-level
 * handshake, gated to trusted-internal because the handshake's sink drives
 * the host's durable checkpoint (the same hole `StreamProcessorRpcTarget`
 * exists to close for `ingest`).
 */
export class ProcessorRelayRpcTarget<State, Host extends ProcessorHostStub = ProcessorHostStub>
  extends IterateRpcRelay<"StreamProcessorRpc">
  implements WakeableStreamProcessorRpc<State>
{
  readonly #auth: ItxAuth;
  readonly #host: () => Host | PromiseLike<Host>;
  readonly #processorFacade: (host: Host) => PromiseLike<unknown>;

  constructor(args: {
    auth: ItxAuth;
    host: () => Host | PromiseLike<Host>;
    processorFacade?: (host: Host) => PromiseLike<unknown>;
  }) {
    super();
    this.#auth = args.auth;
    this.#host = args.host;
    this.#processorFacade = args.processorFacade ?? ((host) => host.processor);
  }

  async #processor(): Promise<StreamProcessorRpc<State>> {
    return (await this.#processorFacade(await this.#host())) as StreamProcessorRpc<State>;
  }

  #disposeProcessor(processor: StreamProcessorRpc<State>): void {
    // A Workers RPC property returning an RpcTarget materializes a remote
    // stub for every relay call. It is only needed for this one method and
    // must be released deterministically. In-process targets are real
    // RpcTargets and remain owned by their host.
    if (processor instanceof RpcTarget) return;
    try {
      (processor as StreamProcessorRpc<State> & Partial<Disposable>)[Symbol.dispose]?.();
    } catch (error) {
      // Disposal is cleanup, not the authoritative processor outcome. A
      // stale workerd RPC stub can reject disposal after its backing DO
      // resets; preserve the success/error/retry already chosen above,
      // while keeping the cleanup failure observable.
      console.warn("processor relay transient facade dispose failed", { error });
    }
  }

  async #callProcessorOutcome<Result>(
    call: (processor: StreamProcessorRpc<State>) => Promise<Result>,
    expiresAt?: number,
  ): Promise<DeadlineOutcome<Result>> {
    const settle = <Value>(promise: Promise<Value>): Promise<DeadlineOutcome<Value>> =>
      expiresAt === undefined
        ? promise.then<DeadlineOutcome<Value>, DeadlineOutcome<Value>>(
            (value) => ({ status: "fulfilled", value }),
            (error: unknown) => ({ status: "rejected", error }),
          )
        : settleByDeadline(promise, expiresAt, Date.now);

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let processor: StreamProcessorRpc<State> | undefined;
      const acquisition = this.#processor();
      const acquired = await settle(acquisition);
      if (acquired.status === "deadline") {
        // The acquisition may still materialize a remote facade after this
        // caller has moved on. Observe both outcomes and release a late stub.
        void acquisition.then(
          (lateProcessor) => this.#disposeProcessor(lateProcessor),
          () => undefined,
        );
        return acquired;
      }
      if (acquired.status === "rejected") {
        if (attempt === 1 && isDurableObjectLifecycleError(acquired.error)) {
          console.info("processor relay retrying after Durable Object lifecycle reset");
          continue;
        }
        return acquired;
      }

      processor = acquired.value;
      if (expiresAt !== undefined && Date.now() >= expiresAt) {
        // Acquisition won the promise race but consumed the complete slice.
        // Do not schedule a call on a facade that cleanup must now release.
        this.#disposeProcessor(processor);
        return { status: "deadline" };
      }
      let outcome: DeadlineOutcome<Result>;
      try {
        outcome = await settle(call(processor));
      } catch (error) {
        outcome = { status: "rejected", error };
      } finally {
        this.#disposeProcessor(processor);
      }
      if (
        outcome.status === "rejected" &&
        attempt === 1 &&
        isDurableObjectLifecycleError(outcome.error)
      ) {
        // Deploys and evictions may reset a processor-hosting DO while its
        // facade property or method call is in flight. A fresh host stub
        // reaches the replacement incarnation; retry exactly once. App errors
        // are never retried, and a second lifecycle failure propagates.
        console.info("processor relay retrying after Durable Object lifecycle reset");
        continue;
      }
      return outcome;
    }
    return {
      status: "rejected",
      error: new Error("processor relay exhausted its bounded lifecycle retry"),
    };
  }

  async #callProcessor<Result>(
    call: (processor: StreamProcessorRpc<State>) => Promise<Result>,
  ): Promise<Result> {
    const outcome = await this.#callProcessorOutcome(call);
    if (outcome.status === "fulfilled") return outcome.value;
    if (outcome.status === "rejected") throw outcome.error;
    throw new Error("processor relay reached an impossible unbounded deadline");
  }

  async snapshot() {
    return await this.#callProcessor((processor) => processor.snapshot());
  }

  async getRuntimeState() {
    return await this.#callProcessor((processor) => processor.getRuntimeState());
  }

  async waitUntilProcessed(input: { offset: number; timeoutMs?: number }) {
    if (input.timeoutMs === undefined) {
      return await this.#callProcessor((processor) => processor.waitUntilProcessed(input));
    }

    const deadline = Date.now() + input.timeoutMs;
    const timeoutError = () =>
      new Error(
        `waitUntilProcessed timed out after ${input.timeoutMs}ms waiting for offset ${input.offset}`,
      );
    while (Date.now() < deadline) {
      // A remote RpcTarget call can be orphaned when its hosting DO is
      // replaced without workerd rejecting the caller. Bound the LOCAL
      // acquisition + call as well as the remote runner's timer, then obtain a
      // fresh facade and re-check durable progress within the one public
      // deadline. Promise races retain rejection observers, and disposal
      // cancels/releases the superseded remote waiter.
      const attemptDeadline = Math.min(deadline, Date.now() + PROCESSOR_WAIT_REACQUIRE_MS);
      const outcome = await this.#callProcessorOutcome((processor) => {
        const timeoutMs = deadline - Date.now();
        return timeoutMs <= 0
          ? Promise.reject(timeoutError())
          : processor.waitUntilProcessed({ ...input, timeoutMs });
      }, attemptDeadline);
      if (outcome.status === "fulfilled") return outcome.value;
      if (outcome.status === "rejected") throw outcome.error;
      if (attemptDeadline >= deadline) break;
      console.info("processor relay re-acquiring after bounded wait slice", {
        offset: input.offset,
        remainingMs: deadline - Date.now(),
      });
    }
    throw timeoutError();
  }

  /** The host's wake-mode delivery handshake (see {@link WakeableStreamProcessorRpc}). */
  async wakeStreamSubscriber(
    request: StreamSubscriberWakeRequest,
  ): Promise<StreamSubscriberWakeResponse> {
    if (this.#auth.principal !== "trusted-internal") {
      throw new Error("wakeStreamSubscriber is dialed by stream delivery spines, not sessions");
    }
    return (await this.#host()).wakeStreamSubscriber(request);
  }
}

/** A Durable Object stub exposing a `.liveState` node — the one property the isolate relay dials. */
type LiveStateDurableObjectStub<State> = { liveState: PromiseLike<LiveStateRpc<State>> };

/**
 * Isolate-side relay for a DO-hosted `.liveState` node — awaits the DO stub's
 * `.liveState` property (a Workers RPC property read can't be pipelined through)
 * then forwards. Mirrors {@link ProcessorRelayRpcTarget}.
 */
class LiveStateRelayRpcTarget<State>
  extends IterateRpcRelay<"LiveStateRpc">
  implements LiveStateRpc<State>
{
  readonly #stub: () =>
    | LiveStateDurableObjectStub<State>
    | PromiseLike<LiveStateDurableObjectStub<State>>;

  constructor(
    stub: () => LiveStateDurableObjectStub<State> | PromiseLike<LiveStateDurableObjectStub<State>>,
  ) {
    super();
    this.#stub = stub;
  }

  async get(): Promise<State> {
    return await (await (await this.#stub()).liveState).get();
  }

  async subscribe(
    onUpdate: (update: LiveUpdate<State>) => unknown,
  ): Promise<LiveStateSubscriptionHandle> {
    return await (await (await this.#stub()).liveState).subscribe(onUpdate);
  }
}

/** How often the stateless demo ticker advances. */
const LIVE_DEMO_TICK_MS = 1000;

/**
 * Demo: the STATELESS live-state case. This RpcTarget runs in the request
 * isolate (no Durable Object); `subscribe` drives a per-connection LiveState
 * engine from a timer — exactly the shape of polling a third-party API and
 * pushing what changed. The timer lives precisely as long as the subscription.
 */
class LiveDemoTickerRpcTarget
  extends IterateRpcRelay<"LiveStateRpc">
  implements LiveStateRpc<{ tick: number; startedAt: number }>
{
  readonly #startedAt = Date.now();

  async get(): Promise<{ tick: number; startedAt: number }> {
    return { tick: 0, startedAt: this.#startedAt };
  }

  async subscribe(
    onUpdate: (update: LiveUpdate<{ tick: number; startedAt: number }>) => unknown,
  ): Promise<LiveStateSubscriptionHandle> {
    const engine = new LiveState<{ tick: number; startedAt: number }>({
      tick: 0,
      startedAt: this.#startedAt,
    });
    return await new LiveStateRpcTarget({
      getState: () => engine.getState(),
      subscribe: (sink) => {
        const inner = engine.subscribe(sink);
        // The engine drops a subscriber itself when a delivery rejects (dead
        // client), and it exposes no drop hook to the owner — so a driving
        // loop must check `ping()` or its timer would outlive the subscriber.
        const interval = setInterval(() => {
          if (!inner.ping()) {
            stop();
            return;
          }
          engine.assign({ tick: engine.getState().tick + 1 });
        }, LIVE_DEMO_TICK_MS);
        const stop = () => {
          clearInterval(interval);
          inner.unsubscribe();
        };
        return {
          ping: () => inner.ping(),
          unsubscribe: stop,
          [Symbol.dispose]: stop,
        };
      },
    }).subscribe(onUpdate);
  }
}

/**
 * Demo capability (`itx.liveDemo`) — a corner of the tree that exists only to
 * exercise both live-state cases: `ticker` (stateless, above) and `increment()`
 * (mutates the project DO's shared counter, which every watcher of `itx.liveState`
 * sees — the Durable-Object-backed case).
 */
class LiveDemoRpcTarget extends IterateRpcTarget<"LiveDemo"> {
  readonly #incrementCounter: () => Promise<void>;

  constructor(incrementCounter: () => Promise<void>) {
    super();
    this.#incrementCounter = incrementCounter;
  }

  /** Stateless live state: a poll-driven ticker, no Durable Object. */
  get ticker(): LiveStateRpc<{ tick: number; startedAt: number }> {
    return new LiveDemoTickerRpcTarget();
  }

  /** Stateful live state: bump the project DO's counter (visible on `itx.liveState`). */
  increment(): Promise<void> {
    return this.#incrementCounter();
  }
}

/**
 * `itx.kv` — a small durable project key-value store on Workers KV (the
 * deployment's PROJECT_DIRECTORY namespace, keys prefixed with the project
 * id). Stateless by design: no Durable Object in the path, so a config
 * worker can read a policy knob on every request for microseconds (the
 * canonical example: its reverse-proxy target, flipped between the deployed
 * app and a dev tunnel). KV is eventually consistent across the edge —
 * writes are visible immediately in the writing location and within ~60s
 * everywhere else — which is the right trade for knobs and exactly the
 * wrong one for data (streams), files (files), or credentials (secrets).
 * Values are JSON-serializable, ≤64KiB; keys ≤256 characters.
 */
class KvRpcTarget extends IterateRpcTarget<"Kv"> {
  readonly #projectId: string;

  constructor(projectId: string) {
    super();
    this.#projectId = projectId;
  }

  #key(key: string): string {
    // 256 chars leaves comfortable headroom under Workers KV's 512-BYTE
    // limit on the full stored key (prefix + project id included); the byte
    // check catches multibyte keys the char count alone would let through.
    if (typeof key !== "string" || key.length === 0 || key.length > 256) {
      throw new Error("kv keys are non-empty strings of at most 256 characters");
    }
    const stored = `projectkv:${this.#projectId}:${key}`;
    if (new TextEncoder().encode(stored).length > 512) {
      throw new Error("kv key too large once encoded (the full stored key must fit 512 bytes)");
    }
    return stored;
  }

  /** The stored value, or null when the key is absent. */
  get(key: string): Promise<unknown> {
    return env.PROJECT_DIRECTORY.get(this.#key(key), "json");
  }

  /** Store a JSON-serializable value (≤64KiB) under a key (≤512 chars). */
  async set(key: string, value: unknown): Promise<void> {
    if (value === undefined || value === null) {
      throw new Error("kv.set requires a value; use kv.delete to remove a key");
    }
    const serialized = JSON.stringify(value);
    // NaN/Infinity stringify to the literal "null", which would make get()
    // indistinguishable from an absent key while list() still shows it.
    if (serialized === undefined || serialized === "null") {
      throw new Error("kv values must be JSON-serializable (null, NaN, and Infinity are not)");
    }
    const serializedBytes = new TextEncoder().encode(serialized).length;
    if (serializedBytes > 64 * 1024) {
      throw new Error(`kv value too large (${serializedBytes} > 65536 JSON bytes)`);
    }
    await env.PROJECT_DIRECTORY.put(this.#key(key), serialized);
  }

  /** Remove a key; absent keys are a no-op. */
  async delete(key: string): Promise<void> {
    await env.PROJECT_DIRECTORY.delete(this.#key(key));
  }

  /** Keys only (values are one get away), optionally under a prefix. */
  async list(input?: { prefix?: string }): Promise<string[]> {
    const namespacePrefix = `projectkv:${this.#projectId}:`;
    const prefix = input?.prefix ? this.#key(input.prefix) : namespacePrefix;
    const names: string[] = [];
    let cursor: string | undefined;
    // Paginate to completion — this is a knob store, so the loop is one
    // iteration in practice, but a truncated list must never look complete.
    do {
      const listed = await env.PROJECT_DIRECTORY.list({ prefix, limit: 1000, cursor });
      for (const entry of listed.keys) names.push(entry.name.slice(namespacePrefix.length));
      cursor = listed.list_complete ? undefined : listed.cursor;
    } while (cursor !== undefined);
    return names;
  }
}

type LazyClientDescription = Pick<Partial<Description>, "instructions" | "parent" | "types">;

function lazyPromise<T>(load: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | undefined;
  return () => (promise ??= load());
}

type McpClientDeps = { description?: LazyClientDescription; egress: Fetcher };

/** The MCP collection needs the calling project + scope (so beginOAuth can mint
 * the callback URL, store the token, and notify the calling agent) on top of the
 * egress every client call uses. */
type McpClientCollectionDeps = { egress: Fetcher; projectId: string; scopePath: string };

// Exa's hosted MCP server works unauthenticated (rate-limited, and the shared
// free pool exhausts fast); pre-connecting it gives every project web search
// with zero setup. When the deployment has a first-party Exa key
// (config.integrations.exa), it rides as a bearer placeholder substituted at
// the egress door — raw key bytes never enter the MCP client.
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const EXA_PLATFORM_KEY_HEADER = {
  authorization: 'Bearer getSecret({ platform: "integrations.exa.apiKey" })',
};

/**
 * Ad-hoc MCP (Model Context Protocol) clients — `itx.mcp`. `connect({ url })`
 * returns a client whose dotted calls invoke the server's tools; `exa` is the
 * pre-connected Exa web-search server every project gets.
 */
class McpClientCollectionRpcTarget extends IterateRpcTarget<"McpClientCollection"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        "Ad-hoc MCP clients: connect({ url }) returns a client whose dotted calls are tool invocations; exa is the built-in Exa web-search server. For a server that needs OAuth, beginOAuth({ url }) returns a sign-in link that stores a token you then connect with.",
      children: {
        connect: "Connect to an MCP server by URL.",
        beginOAuth: "Start the OAuth sign-in for an OAuth-protected MCP server; returns a link.",
        exa: "The public Exa MCP server (web_search_exa, web_fetch_exa).",
      },
      parent: "a project itx (itx.mcp)",
    });
  }

  constructor(readonly props: McpClientCollectionDeps) {
    super();
  }

  /** Connect to an MCP server by URL; dotted calls on the client are tool invocations. */
  connect(input: McpClientConnectInput): Promise<McpClientRpc> {
    return McpClientRpcTarget.connect(input, this.props);
  }

  /**
   * Begin the OAuth sign-in for an OAuth-protected MCP server (one whose
   * unauthenticated request answers 401 with a `WWW-Authenticate` challenge —
   * e.g. Cloudflare's mcp.cloudflare.com). Discovers the server's OAuth
   * endpoints, registers a client, and returns a `{ authorizationUrl, path }`:
   * send `authorizationUrl` to the user ("click here to connect"). When they
   * sign in, the token is stored write-only at `path` and — if you are an agent
   * — you are messaged so you can continue. Then connect like any bearer MCP:
   * `itx.mcp.connect({ url, headers: { authorization: 'Bearer getSecret(
   * "<path>", { field: "accessToken" })' } })`. For a server that just wants a
   * bearer token you already hold, use `itx.secrets.collectFromUser` instead.
   */
  async beginOAuth(input: McpBeginOAuthInput): Promise<McpBeginOAuthResult> {
    const baseUrl = parseConfig(env).baseUrl;
    if (!baseUrl) {
      throw new Error(
        "This deployment cannot name its own base URL, so it cannot host the OAuth callback.",
      );
    }
    const path = normalizeSecretPath(input.path);
    const result = await beginMcpOAuth({
      mcpUrl: input.url,
      path,
      redirectUri: `${baseUrl.replace(/\/$/, "")}/api/mcp-oauth/callback`,
      ...(input.scope ? { scope: input.scope } : {}),
      // An agent scope gets messaged when the user finishes signing in.
      ...(this.props.scopePath.startsWith("/agents/") ? { notify: this.props.scopePath } : {}),
      projectId: this.props.projectId,
      encryptionKey: env.SECRET_ENCRYPTION_KEY,
      fetchFn: fetchLikeFromFetcher(this.props.egress),
    });
    return { authorizationUrl: result.authorizationUrl, path: result.path };
  }

  /**
   * The public Exa MCP server (https://mcp.exa.ai/mcp), pre-connected for every
   * project: web search and page reading as flat tool calls.
   * `itx.mcp.exa.web_search_exa({ query, numResults })` searches the web;
   * `itx.mcp.exa.web_fetch_exa({ urls, maxCharacters })` reads pages as markdown.
   */
  get exa(): McpClientRpc {
    const hasPlatformKey = parseConfig(env).integrations.exa !== undefined;
    return McpClientRpcTarget.createLazyClient(
      { url: EXA_MCP_URL, ...(hasPlatformKey ? { headers: EXA_PLATFORM_KEY_HEADER } : {}) },
      {
        description: {
          instructions:
            "Public Exa MCP server: web search and page reading. Tool names are discovered from the MCP server.",
          parent: "a project itx (itx.mcp.exa)",
        },
        egress: this.props.egress,
      },
    );
  }
}

class McpClientRpcTarget extends IterateRpcRelay<"McpClientRpc"> {
  static createLazyClient(input: McpClientConnectInput, deps: McpClientDeps) {
    return new McpClientRpcTarget({ config: input, ...deps });
  }

  static async connect(input: McpClientConnectInput, deps: McpClientDeps) {
    return McpClientRpcTarget.createLazyClient(input, deps);
  }

  constructor(
    readonly props: {
      config: McpClientConnectInput;
      description?: LazyClientDescription;
      egress: Fetcher;
    },
  ) {
    super();
  }

  async __describe(): Promise<Description> {
    const tools = await listMcpTools({
      config: this.props.config,
      egress: this.props.egress,
    });

    return describeNode({
      instructions:
        this.props.description?.instructions ??
        `An ad-hoc MCP client for ${this.props.config.url}: a flattened dispatcher; client.someTool(input) calls the tool "someTool".`,
      // Connect-time auto-typing: absent a hand-written declaration, the
      // server's own tool inputSchemas become the types. provideCapability
      // stamps this onto a durable mount, so docs and the typechecker see
      // third-party tools like builtins.
      types:
        this.props.description?.types ??
        mcpCapabilityTypeDeclaration(tools, `MCP server ${this.props.config.url}`),
      children: Object.fromEntries(
        tools.map((tool) => [tool.name, tool.description ?? "MCP tool"]),
      ),
      parent: this.props.description?.parent ?? "itx.mcp.connect(url)",
    });
  }

  async invokeCapability({
    args = [],
    path,
  }: {
    args?: unknown[];
    path: string[];
  }): Promise<unknown> {
    return await callMcpToolPath({
      args,
      config: this.props.config,
      egress: this.props.egress,
      path,
    });
  }
}

// First-party OpenAPI is just an RpcTarget hosted by Project. The only special
// power it receives is project egress, which is also the path a user-provided
// dynamic worker would use through env.ITX. That keeps the built-in and dynamic
// implementations aligned: fetch spec, derive operations, then dispatch calls.
type OpenApiDeps = { description?: LazyClientDescription; egress: FetchOnly };

type OpenApiReadyState = {
  operations: OpenApiOperation[];
  spec: Record<string, unknown>;
};

/**
 * Ad-hoc OpenAPI clients — `itx.openapi`. `connect({ specUrl })` fetches and
 * parses a spec and returns a client whose dotted calls are the spec's
 * operationIds, executed against its server through project egress.
 */
class OpenApiCollectionRpcTarget extends IterateRpcTarget<"OpenApiCollection"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        "Ad-hoc OpenAPI clients: connect(spec) fetches/parses a spec and returns a client whose dotted calls are operationIds.",
      children: { connect: "Connect to an OpenAPI deployment." },
      parent: "a project itx (itx.openapi)",
    });
  }

  constructor(readonly props: OpenApiDeps) {
    super();
  }

  /** Fetch and parse a spec; dotted calls on the returned client are operationIds. */
  connect(input: OpenApiConnectInput): Promise<OpenApiRpc> {
    return OpenApiRpcTarget.connect(input, this.props);
  }
}

class OpenApiRpcTarget extends IterateRpcRelay<"OpenApiRpc"> {
  readonly #ready: () => Promise<OpenApiReadyState>;

  static createLazyClient(input: OpenApiConnectInput, deps: OpenApiDeps) {
    return new OpenApiRpcTarget({ config: input, ...deps });
  }

  static async connect(input: OpenApiConnectInput, deps: OpenApiDeps) {
    return OpenApiRpcTarget.createLazyClient(input, deps);
  }

  constructor(
    readonly props: {
      config: OpenApiConnectInput;
      description?: LazyClientDescription;
      egress: FetchOnly;
    },
  ) {
    super();
    this.#ready = lazyPromise(async () => {
      const spec = await fetchSpec(props.config, props.egress);
      return { operations: listOpenApiOperations(spec), spec };
    });
  }

  async __describe(): Promise<Description> {
    const { operations, spec } = await this.#ready();

    return describeNode({
      instructions:
        this.props.description?.instructions ??
        "An ad-hoc OpenAPI client: a flat dispatcher; client.someOperationId(input) executes that operation against the spec's server.",
      // Connect-time auto-typing, reference-style: one line naming the spec
      // (the typechecker materializes the full declaration at check time —
      // schemas never enter the journal or an agent's context). Only a spec
      // that itself NEEDS auth headers journals inline — same predicate as
      // fetchSpec, so "we fetched it bare" and "the sidecar can fetch it
      // bare" cannot drift. A public spec with an auth'd API (the common
      // split) keeps the reference.
      types:
        this.props.description?.types ??
        (Object.keys(specFetchHeaders(this.props.config)).length > 0
          ? openApiCapabilityTypeInline(operations, spec, this.props.config.specUrl)
          : openApiCapabilityTypeReference(this.props.config.specUrl)),
      children: Object.fromEntries(
        operations.map((operation) => [
          operation.operationId,
          `${operation.method.toUpperCase()} ${operation.path}`,
        ]),
      ),
      parent: this.props.description?.parent ?? "itx.openapi.connect(spec)",
    });
  }

  async invokeCapability({
    args = [],
    path,
  }: {
    args?: unknown[];
    path: string[];
  }): Promise<unknown> {
    const { operations, spec } = await this.#ready();
    const operationId = path[0];
    if (!operationId) throw new Error("OpenAPI operation calls need an operationId path.");
    if (path.length > 1) {
      throw new Error(`OpenAPI operations are flat operationIds, got "${path.join(".")}".`);
    }
    const operation = operations.find((candidate) => candidate.operationId === operationId);
    if (!operation) {
      throw new Error(`Operation "${operationId}" is not in the OpenAPI spec.`);
    }
    return await executeOperation({
      egress: this.props.egress,
      input: args[0],
      operation,
      props: this.props.config,
      spec,
    });
  }
}

/**
 * The connection's headers apply to the SPEC fetch only when the spec lives
 * on the API's own host — the common split (public spec, auth'd API à la
 * Stripe) sends nothing to the spec. This predicate decides both how
 * `fetchSpec` fetches AND whether auto-typing must journal inline: a spec
 * fetched bare here is equally fetchable by the typechecker's bare fetch,
 * so it can journal the small `openapi:` reference.
 */
function specFetchHeaders(props: OpenApiConnectInput): Record<string, string> {
  const specHost = new URL(props.specUrl).host;
  const apiHost = props.baseUrl ? new URL(props.baseUrl).host : specHost;
  return specHost === apiHost ? (props.headers ?? {}) : {};
}

async function fetchSpec(
  props: OpenApiConnectInput,
  egress: FetchOnly,
): Promise<Record<string, unknown>> {
  // Headers can contain getSecret("/secrets/...") placeholders.
  // They must enter the project egress pipe, because that is the only place
  // secret material is substituted. Do not read or rewrite them here.
  const response = await egress.fetch(
    new Request(props.specUrl, { headers: specFetchHeaders(props) }),
  );
  if (!response.ok) {
    throw new Error(`Fetching the OpenAPI spec at ${props.specUrl} returned ${response.status}.`);
  }
  const spec = (await response.json()) as Record<string, unknown>;
  if (!spec || typeof spec !== "object" || typeof spec.openapi !== "string") {
    throw new Error(`Fetching the OpenAPI spec at ${props.specUrl} did not return OpenAPI JSON.`);
  }
  return spec;
}

async function executeOperation(args: {
  egress: FetchOnly;
  input: unknown;
  operation: OpenApiOperation;
  props: OpenApiConnectInput;
  spec: Record<string, unknown>;
}): Promise<unknown> {
  const { operation, props, spec } = args;
  const input =
    args.input != null && typeof args.input === "object" && !Array.isArray(args.input)
      ? { ...(args.input as Record<string, unknown>) }
      : {};

  let resolvedPath = operation.path;
  const query: Array<[string, string]> = [];
  for (const parameter of operation.parameters) {
    const value = input[parameter.name];
    if (parameter.in === "path") {
      if (value == null) {
        throw new Error(`Operation "${operation.operationId}" needs "${parameter.name}".`);
      }
      resolvedPath = resolvedPath.replaceAll(
        `{${parameter.name}}`,
        encodeURIComponent(String(value)),
      );
      delete input[parameter.name];
    } else if (parameter.in === "query") {
      if (value == null && parameter.required) {
        throw new Error(
          `Operation "${operation.operationId}" needs query parameter "${parameter.name}".`,
        );
      }
      if (value != null) query.push([parameter.name, String(value)]);
      delete input[parameter.name];
    }
  }

  if (!operation.requestBody) {
    const leftover = Object.keys(input);
    if (leftover.length > 0) {
      const valid = operation.parameters
        .filter((parameter) => parameter.in === "path" || parameter.in === "query")
        .map((parameter) => parameter.name);
      throw new Error(
        `Operation "${operation.operationId}" has no request body and got unknown input ` +
          `key${leftover.length > 1 ? "s" : ""} ${leftover.map((key) => JSON.stringify(key)).join(", ")} — ` +
          (valid.length > 0 ? `valid params: ${valid.join(", ")}.` : `it takes no parameters.`),
      );
    }
  }

  const url = new URL(resolvedPath.replace(/^\//, ""), requestBase(props, spec));
  for (const [name, value] of query) url.searchParams.set(name, value);

  let body: string | undefined;
  if (operation.requestBody && Object.keys(input).length > 0) {
    // One input object is split into path/query params first; leftovers are the
    // JSON body. Non-object request bodies use `{ body }` so the convention is
    // still representable as one TypeScript parameter.
    const single =
      Object.keys(input).length === 1 &&
      "body" in input &&
      !isObjectSchema(operationBodySchema(operation, spec));
    body = JSON.stringify(single ? input.body : input);
  }
  const headers = new Headers(props.headers ?? {});
  if (body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await args.egress.fetch(
    new Request(url, { body, headers, method: operation.method.toUpperCase() }),
  );
  if (!response.ok) {
    const snippet = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(
      `${operation.method.toUpperCase()} ${url.pathname} (${operation.operationId}) ` +
        `returned ${response.status}${snippet ? `: ${snippet}` : ""}`,
    );
  }
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("json") ? await response.json() : await response.text();
}

function requestBase(props: OpenApiConnectInput, spec: Record<string, unknown>): string {
  if (props.baseUrl) return ensureTrailingSlash(props.baseUrl);
  const servers = spec.servers as Array<{ url?: string }> | undefined;
  const serverUrl = servers?.[0]?.url;
  if (serverUrl) return ensureTrailingSlash(new URL(serverUrl, props.specUrl).toString());
  return new URL("/", props.specUrl).toString();
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

// =============================================================================
// Dynamic-capability fallbacks — the registry.
//
// Every surface listed here answers UNKNOWN dotted members by dispatching an
// `invokeCapability({ path, args })` against its scope's capability table
// (`itx.someTool(...)`, `host.foo.bar(x)`, `mcpClient.someToolName(args)`).
// The fallback lives on each class's PROTOTYPE CHAIN — one proxied hop
// between `Class.prototype` and its parent — NOT as a Proxy around instances:
// workerd RPC brand-checks a method call's RESULT when classifying it for
// promise pipelining, a Proxy never passes, and every pipelined call on it
// then fails with "The RPC receiver does not implement the method ..."
// (cloudflare/workerd#6873). With the hop, instances are genuine RpcTargets —
// `itx.capabilityHosts.get(p).runScript(s)`, `itx.workers.get(ref).ping()`,
// `itx.mcp.connect(url).someToolName(args)` all pipeline in one expression —
// while unknown-name lookups still walk the prototype chain into the hop.
// Mechanism details: installPrototypeInvokeCapabilityFallback (domains/itx/
// utils.ts).
// =============================================================================

// The root itx / `projects.get(id)`: unknown roots dispatch via the scope's
// capability host (mounted capabilities, `itx.someTool(...)`).
installPrototypeInvokeCapabilityFallback(ProjectRpcTarget, {
  invokerFor: (project) => project.capabilityHost,
});
// `capabilityHosts.get(path)` and every `capabilityHost` getter: the host IS
// the invoker — `host.foo.bar(x)` is `host.invokeCapability({ path: ["foo",
// "bar"], args: [x] })`.
installPrototypeInvokeCapabilityFallback(CapabilityHostRpcTarget);
// `itx.integrations`: userspace connections mount under provider slugs
// (`itx.integrations.ocado.get("family").search(...)`).
installPrototypeInvokeCapabilityFallback(ProjectIntegrationsRpcTarget);
// `itx.integrations.<slug>.get(connection?)`: a genuine connection RpcTarget
// whose unknown SDK members flatten into its selected integration dispatcher.
installPrototypeInvokeCapabilityFallback(IntegrationConnectionRpcTarget);
// `workers.get(ref)`: dotted paths flatten into one invokeCapability against
// the dynamic worker (the userspace `invokeCapability` walk).
installPrototypeInvokeCapabilityFallback(DynamicWorkerRpcTarget);
// `mcp.connect(url)`: tool names are only known at runtime (tools/list), so
// every tool call is a dynamic member by construction.
installPrototypeInvokeCapabilityFallback(McpClientRpcTarget);
// `openapi.connect(specUrl)`: operationIds are runtime-discovered, same shape
// as MCP tools.
installPrototypeInvokeCapabilityFallback(OpenApiRpcTarget);
// `sandboxes.get(path)`: the installed Cloudflare SDK surface is larger than
// our stable declaration, so unknown SDK members replay onto the claimed DO.
installPrototypeInvokeCapabilityFallback(SandboxRpcTarget);
// `agents.get(path)`: an agent scope's mounted tools directly on the handle —
// `itx.agents.get(path).someTool(args)` — dispatched via the agent's own
// capability host (the explicit `agent.capabilityHost.someTool(...)` spelling
// resolves identically). #1839 removed the instance Proxy to make handles
// pipelinable; the hop restores the sugar without giving that back.
installPrototypeInvokeCapabilityFallback(AgentRpcTarget, {
  invokerFor: (agent) => agent.capabilityHost,
});

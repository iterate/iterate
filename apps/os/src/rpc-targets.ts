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
import type { AppConfig } from "./config.ts";
import { parseConfig } from "./config.ts";
import {
  resolveItxAuth,
  resolveOrganizationSlugForCreate,
  trustedInternalAuthContext,
  userPrincipalOf,
  widenProjectAccess,
} from "./auth.ts";
import { itxEnv as env } from "./env.ts";
import {
  listProjectDirectory,
  primeProjectDirectory,
  readProjectById,
} from "./project-directory.ts";
import { deploymentStatusesFromProbes } from "./project-deployment-status.ts";
import { timedStep } from "./lib/step-timing.ts";
import { buildCollectSecretUrl } from "./lib/collect-secret-link.ts";
import { buildProjectStreamViewerUrl } from "./lib/stream-viewer-url.ts";
import { buildProjectWorkerUrl } from "./lib/project-host-routing.ts";
import type { Env } from "./env.ts";
import { DurableObjectNameCodec, normalizePath } from "./domains/durable-object-names.ts";
import { normalizeAgentPath, resolveAgentPath } from "./domains/agents/utils.ts";
import {
  describeNode,
  rejectBuiltinCollision,
  installPrototypeInvokeCapabilityFallback,
} from "./domains/itx/utils.ts";
import { projectStub } from "./domains/projects/egress.ts";
import { ProjectProcessorContract } from "./domains/projects/project-processor-contract.ts";
import type {
  StreamRecoveryExportPage,
  StreamRecoveryExportSink,
  StreamRecoveryExportSummary,
  StreamRecoveryRestoreInput,
} from "./domains/streams/recovery.ts";
import { projectEgressFetcher } from "./domains/projects/utils.ts";
import { RepoProcessorContract } from "./domains/repos/repo-processor-contract.ts";
import {
  CONFIG_REPO_PATH,
  defaultProjectWorkerRef,
  isRepoNotSeededError,
} from "./domains/repos/utils.ts";
import { isWorkerBuildInProgressError } from "./domains/workers/worker-loader.ts";
import type { SandboxDurableObject } from "./domains/sandboxes/cloudflare/cloudflare-sandbox-durable-object.ts";
import {
  DEFAULT_SANDBOX_INSTANCE_TYPE,
  SANDBOX_INSTANCE_TYPE_BINDINGS,
  SandboxInstanceType,
} from "./domains/sandboxes/instance-types.ts";
import {
  assertSandboxPath,
  assertValidSleepAfter,
  sandboxPathFor,
} from "./domains/sandboxes/utils.ts";
import { SandboxProcessorContract } from "./domains/sandboxes/sandbox-processor-contract.ts";
import { linkRepoToGithub, unlinkRepoFromGithub } from "./domains/repos/github-link.ts";
import { isRootWorkspacePath, normalizeWorkspacePath } from "./domains/workspaces/utils.ts";
import { canonicalRecurrence } from "./domains/scheduler/recurrence.ts";
import { normalizeSchedulerPath, SCHEDULER_PRIMARY_PATH } from "./domains/scheduler/utils.ts";
import { normalizeSecretPath } from "./domains/secrets/utils.ts";
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
  isBuiltinIntegrationSlug,
} from "./domains/integrations/utils.ts";
import {
  connectionOctokit,
  GITHUB_CALL_GRAMMAR,
  normalizeGithubError,
} from "./domains/integrations/github-api.ts";
import { replayPathCall } from "./itx/path-proxy.ts";
import { callGmailApi } from "./domains/integrations/gmail-api.ts";
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
  listProjectFiles,
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
} from "./domains/workers/schemas.ts";
import type { StreamEvent, StreamEventInput, StreamListItem } from "./domains/streams/schemas.ts";
import { retainProcessEventBatch } from "./domains/streams/subscriber-sinks.ts";
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
import type { ProcessorReads } from "./domains/streams/stream-processor.ts";
import type {
  CapabilityDescription,
  Description,
  ProjectDescription,
} from "./domains/itx/describe.ts";
import type { CfExecutionContext } from "./domains/itx/utils.ts";
import type { CloudflareSandbox, SandboxCreateInput } from "./domains/sandboxes/utils.ts";
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
  ensureProjectSearchInstance,
  indexDocument,
  indexPinnedStreamEvent,
  indexEntireStream,
  indexStreamEventBatch,
  mirrorFileToSearchIndex,
  triggerProjectSearchSync,
  triggerProjectSearchSyncDebounced,
} from "./domains/search/search-index.ts";
import {
  extractMatchSnippet,
  narrowStreamRefToChunk,
  normalizeSearchExcludeKinds,
  normalizeSearchSource,
  projectSearchInstanceId,
  searchFilters,
} from "./domains/search/search-corpus.ts";
import { ItxExpression } from "./itx/expression.ts";
import type {
  SearchAnswerResult,
  SearchQueryResult,
  SearchResultChunk,
} from "./domains/search/search-corpus.ts";
import type {
  AgentFileAttachment,
  AgentProcessorState,
} from "./domains/agents/agent-processor-contract.ts";
import { CapabilityHostProcessorContract } from "./domains/capability-host/capability-host-processor-contract.ts";
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
  GetProcessorRuntimeState,
  LiveStateRpc,
  LiveStateSubscriptionHandle,
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
} from "./domains/streams/rpc-types.ts";
import { StreamReceiverUnavailableError } from "./domains/streams/rpc-types.ts";
import type {
  ConnectionRuntimeState,
  SubscriptionRuntimeState,
} from "./domains/streams/stream-subscribers.ts";
import type { StreamThroughputMetrics } from "./domains/streams/stream-runtime-metrics.ts";
import type { StreamProcessorRegistry } from "./domains/streams/stream-processor-registry.ts";
import type { LiveUpdate } from "./lib/live-state/protocol.ts";
import { LiveState, type LiveStateSubscription } from "./lib/live-state/engine.ts";
import type { ProjectProcessorState } from "./domains/projects/project-processor-contract.ts";
import type { ProjectLiveState } from "./domains/projects/project-live-state.ts";
import type { TouchInput } from "./domains/projects/stream-database.ts";
import type { AgentStatusTouchInput } from "./domains/projects/agent-status-database.ts";
import type { RepoProcessorState } from "./domains/repos/repo-processor-contract.ts";
import {
  SchedulerProcessorContract,
  type SchedulerProcessorState,
} from "./domains/scheduler/scheduler-processor-contract.ts";
import type {
  EditWorkspaceFileInput,
  EditWorkspaceFileResult,
  WorkspaceChange,
  WorkspaceFileInfo,
  WorkspaceGitLogEntry,
  WorkspacePublishResult,
} from "./domains/workspaces/types.ts";
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
  EMAIL_RECEIVED_EVENT_TYPE,
  EMAIL_SENT_EVENT_TYPE,
  isOwnProjectMail,
  mintOutboundEmailThreadId,
  replySubject,
  type OutboundEmailAttachment,
  type SendEmailBinding,
} from "./domains/email/utils.ts";
import {
  EmailAgentBirthCertificate,
  EmailProcessorContract,
} from "./domains/email/email-processor-contract.ts";
import { EmailAgentProcessorContract } from "./domains/email/email-agent-processor-contract.ts";
import { agentCreationForPath, type AgentCreateInput } from "./domains/agents/agent-defaults.ts";

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
      instructions: `A durable event stream at path "${this.props.path}": append(events), readEvents(), getEvents(), waitForEvent(), subscribe(), crossPostTo(), kill(). Streams are the coordination primitive — processors and agents communicate by appending and reducing events. THE LOCALITY RULE: a processor on stream A can only react to events ON stream A; to react to another stream's events, cross-post them here (copies carry full source.crossPostedFrom provenance chains). append({ ..., ephemeral: true }) commits a TRANSIENT event: live subscribe() connections see it, but default reads and ALL durable delivery (processors, the project worker feed) never do, and the row may be evicted later — append the durable fact separately.`,
      children: {
        append: "Commit events; returns them with offsets.",
        at: "The stream at a sub-path.",
        crossPostTo:
          "Copy matching events onto another stream (optionally JSONata-transformed). Rides durable delivery, so ephemeral events are never cross-posted; a selector matching only ephemeral types delivers nothing.",
        getEvent: "One event by offset or idempotencyKey.",
        getEvents: "Read one bounded page of events.",
        kill: "Abort the current Durable Object incarnation; the next request boots it again.",
        readEvents: "Create a pager for bounded event pages.",
        removeCrossPost: "Remove a cross-post configured by crossPostTo.",
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
  /** Commit events; resolves with the same events carrying offsets and timestamps. */
  append(...events: StreamEventInput[]): Promise<StreamEvent[]> {
    return this.durableObjectStub.append(...events);
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
  getEvent(
    args: { offset: number; idempotencyKey?: never } | { idempotencyKey: string; offset?: never },
  ): Promise<StreamEvent | undefined> {
    return this.durableObjectStub.getEvent(args);
  }

  /**
   * Read one bounded page of committed events (default from the stream's
   * start; filter with `eventTypes`, page forward with `afterOffset`). A full
   * page (500 events) means MORE remain — page with
   * `afterOffset: events.at(-1).offset`; reading a long stream without paging
   * shows you the beginning, not the head.
   */
  getEvents(args?: StreamEventReadInput): Promise<StreamEvent[]> {
    return this.durableObjectStub.getEvents(args);
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
  waitForEvent(args: {
    afterOffset?: number;
    eventTypes?: readonly string[];
    predicate?: (event: StreamEvent) => boolean | Promise<boolean>;
    timeoutMs: number;
  }): Promise<StreamEvent> {
    return this.durableObjectStub.waitForEvent(args);
  }

  /** The reduced-state snapshot (plus runtime debug info) of one configured processor. */
  getProcessorRuntimeState(args: {
    subscriptionKey: string;
  }): Promise<ProcessorRuntimeState | null> {
    return this.durableObjectStub.getProcessorRuntimeState(args);
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
   * sampling), so a polling debug UI sees RTTs populate.
   */
  runtimeState(): Promise<{
    coreProcessorState: unknown;
    runtime: {
      connections: Record<string, ConnectionRuntimeState>;
      subscriptions: Record<string, SubscriptionRuntimeState>;
      metrics: StreamThroughputMetrics;
      /** SQLite database size in bytes (event log + spine rows + chunks). */
      storageSizeBytes: number;
    };
  }> {
    return this.durableObjectStub.runtimeState();
  }

  /** Abort the current Durable Object incarnation; the next request boots it again. */
  kill(): Promise<void> {
    return Promise.resolve(this.durableObjectStub.kill());
  }

  /**
   * Session-scoped live event delivery (the "ephemeral" subscription lane —
   * also the only lane that receives `ephemeral: true` events):
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

/** Admin-only catalog for exact-offset Stream Durable Object recovery. */
class StreamRecoveryCollectionRpcTarget extends IterateRpcTarget<"StreamRecoveryCollection"> {
  constructor(readonly props: { auth: ItxAuth }) {
    super();
    if (!props.auth.isAdmin()) throw new Error("stream recovery requires an admin principal");
  }

  get(input: { projectId: string | null; path: string }): StreamRecoveryRpcTarget {
    return new StreamRecoveryRpcTarget({
      projectId: input.projectId,
      path: normalizePath(input.path),
    });
  }
}

/** Admin-only exact-offset export and replacement of one Stream Durable Object. */
class StreamRecoveryRpcTarget extends IterateRpcTarget<"StreamRecovery"> {
  constructor(readonly props: { projectId: string | null; path: string }) {
    super();
  }

  get #stream() {
    return env.STREAM.getByName(
      DurableObjectNameCodec.stringify(this.props, { allowNullProjectId: true }),
    );
  }

  exportForRecovery(args?: {
    afterOffset?: number;
    limit?: number;
    throughOffset?: number;
  }): Promise<StreamRecoveryExportPage> {
    return this.#stream.exportForRecovery(args);
  }

  /** Stream part of a fixed export window to an acknowledged sink in bounded pages. */
  exportToRecovery(args: {
    sink: StreamRecoveryExportSink;
    afterOffset?: number;
    limit?: number;
    maxPages?: number;
    throughOffset?: number;
  }): Promise<StreamRecoveryExportSummary> {
    return this.#stream.exportToRecovery(args);
  }

  restoreFromRecovery(input: StreamRecoveryRestoreInput): Promise<{
    restoredEventCount: number;
    lastImportedOffset: number;
    currentMaxOffset: number;
  }> {
    return this.#stream.restoreFromRecovery(input);
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
  async create(): Promise<void> {
    const durableObjectName = DurableObjectNameCodec.stringify({
      path: this.props.path,
      projectId: this.props.projectId,
    });
    const committed = await this.#stream.append(
      {
        type: "events.iterate.com/scheduler/created",
        idempotencyKey: `scheduler-created:${this.props.projectId}:${this.props.path}`,
        payload: { config: {} },
      },
      buildDurableObjectProcessorSubscriptionConfiguredEvent({
        durableObjectName,
        idempotencyKey: `scheduler-subscription:${this.props.projectId}:${this.props.path}`,
        processor: ["schedulers", ["get", this.props.path], "processor"],
        processorSlug: SchedulerProcessorContract.slug,
      }),
    );
    const offset = committed.reduce((maximum, event) => Math.max(maximum, event.offset), 0);
    if (offset === 0) throw new Error("scheduler create committed no events");
    await this.processor.waitUntilProcessed({ offset });
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

function streamDurableObjectName(props: { projectId: string | null; path: string }) {
  return DurableObjectNameCodec.stringify(props, { allowNullProjectId: true });
}

async function requestRepoCreate(input: {
  auth: ItxAuth;
  path: string;
  projectId: string | null;
}): Promise<RepoRpcTarget> {
  const path = normalizePath(input.path);
  const stream = new StreamRpcTarget({
    auth: input.auth,
    path,
    projectId: input.projectId,
  });
  const timing = { projectId: input.projectId, path };
  const committed = await timedStep("create-timing", timing, "repo-append", () =>
    stream.append(
      {
        type: "events.iterate.com/repo/created",
        idempotencyKey: `repo-created:${input.projectId}:${path}`,
        payload: { config: {} },
      },
      buildDurableObjectProcessorSubscriptionConfiguredEvent({
        durableObjectName: streamDurableObjectName({ projectId: input.projectId, path }),
        processor: ["repos", ["get", path], "processor"],
        processorSlug: RepoProcessorContract.slug,
      }),
    ),
  );
  const createOffset = committed.reduce((maximum, event) => Math.max(maximum, event.offset), 0);
  if (createOffset === 0) throw new Error("repo create committed no events");
  const repo = new RepoRpcTarget({ auth: input.auth, path, projectId: input.projectId });
  await repo.processor.waitUntilProcessed({ offset: createOffset });

  await timedStep("create-timing", timing, "wait-repo-ready", () =>
    stream.waitForEvent({
      afterOffset: committed[0]!.offset - 1,
      eventTypes: ["events.iterate.com/repo/ready"],
      predicate: (event) =>
        event.payload?.projectId === input.projectId && event.payload?.path === path,
      // Tight on purpose: creates should be fast (see tasks/os-cold-create-latency.md
      // for the cold-slot outliers). Preview CI warms slots before the suites.
      timeoutMs: 60_000,
    }),
  );

  return repo;
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
        create: "Create the repo if it does not exist yet.",
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

  /** Create the repo if it does not exist yet; resolves once `repo/ready` lands. */
  create(): Promise<RepoRpcTarget> {
    return requestRepoCreate({
      auth: this.props.auth,
      path: this.props.path,
      projectId: this.props.projectId,
    });
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
      instructions: "Repo catalog: get(path) / create({ path }).",
      children: { create: "Create a repo at a path.", get: "The repo at a path." },
    });
  }

  constructor(readonly props: { auth: ItxAuth; projectId: string | null }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  /** Create the repo at a path; resolves once its backing artifact is `repo/ready`. */
  create(input: { path: string }): Promise<RepoRpcTarget> {
    return requestRepoCreate({
      auth: this.props.auth,
      path: input.path,
      projectId: this.props.projectId,
    });
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
        list: "Known agents (from project state).",
      },
      parent: "a project itx (itx.agents)",
    });
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

  /** Known agents, read from the project processor's reduced state. */
  list(): Promise<StreamListItem[]> {
    return projectProcessorState(this.props.projectId).then((state) => state.agents);
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
 * The `itx.sandboxes` built-in. Sandboxes are PETS:
 * `create({ name, instanceType })` is the only way one comes to exist
 * (nothing mints a sandbox implicitly — `get` refuses paths that were never
 * created), names are one path segment (`/sandboxes/<name>` — no intermediate
 * folders in the stream tree), and the sandbox itself carries the imperative
 * lifecycle (`start`/`sleep`/`destroy`).
 *
 * `get(path)` returns the sandbox Durable Object's own RPC stub —
 * deliberately NO RpcTarget wrapper, so the caller sees exactly what the
 * `@cloudflare/sandbox` SDK exposes and new SDK methods need no forwarding
 * code here. Confinement is by name: the stub is minted from this project's
 * id plus the validated path, after the same project-access assert every
 * collection performs.
 *
 * The instance type is CONFIGURATION, not identity — but Cloudflare fixes
 * instance type per container class (instance-types.ts), so each type is its
 * own Durable Object namespace and routing needs the type. The `/sandboxes`
 * catalogue stream is the directory: `create` journals `create-requested`
 * there (idempotency-keyed by path, so the stream's native dedup makes the
 * FIRST claim on a name authoritative — races settle atomically in one
 * append) BEFORE touching any container namespace, and `get` routes by the
 * claim's instance type. The catalogue and not the sandbox's own stream
 * because reads materialize streams (any wake appends `created`/`woken`):
 * routing a `get` through the sandbox's own stream would mint a junk stream
 * for every typo'd path, and addressing must never create.
 */
class SandboxCollectionRpcTarget extends IterateRpcTarget<"SandboxCollection"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        "The project's sandboxes — real Linux containers, explicitly created and kept like pets. create({ name, instanceType? }) makes one at /sandboxes/<name> (names are one path segment; instance types are Cloudflare's, fixed for life: lite, basic (default), standard-1..4 — https://developers.cloudflare.com/containers/platform-details/limits/); get(path) returns its bare Cloudflare Sandbox SDK stub (exec, files, processes, sessions, gitCheckout, code interpreter, tunnels — https://developers.cloudflare.com/sandbox/api/) plus start()/sleep()/destroy()/kill() and __describe() like every node. The first command boots the container; after sleepAfter idle it is snapshotted and torn down — /workspace survives via the snapshot, nothing else does. Nothing is preinstalled beyond the stock image (Ubuntu, Node, Bun, git).",
      children: {
        create: "Create a sandbox (strict: existing/destroyed names are errors). Returns { path }.",
        get: "The sandbox at a created path (boots the container on first use).",
        list: "Every sandbox stream path in the project (including destroyed sandboxes' streams — the stream is the history).",
      },
      parent: "a project itx (itx.sandboxes)",
    });
  }

  constructor(readonly props: { auth: ItxAuth; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  /** The instance type's own container namespace — see instance-types.ts for
   * why instance types are separate Durable Object classes. */
  #namespace(instanceType: SandboxInstanceType) {
    const binding = SANDBOX_INSTANCE_TYPE_BINDINGS[instanceType].binding as keyof typeof env;
    return env[binding] as DurableObjectNamespace<SandboxDurableObject>;
  }

  #stub(path: string, instanceType: SandboxInstanceType) {
    return this.#namespace(instanceType).getByName(
      DurableObjectNameCodec.stringify({ projectId: this.props.projectId, path }),
    );
  }

  /** The `/sandboxes` catalogue stream — the directory of every sandbox ever
   * requested in the project (one `create-requested` per name, idempotency-
   * keyed by path). One stream for the whole domain, so looking a name up
   * never materializes anything but the catalogue itself. */
  get #catalogue() {
    return env.STREAM.getByName(
      DurableObjectNameCodec.stringify({ projectId: this.props.projectId, path: "/sandboxes" }),
    );
  }

  static #claimKey(path: string) {
    return `sandbox-create-requested:${path}`;
  }

  /** The name claim journaled for a path (the catalogue's `create-requested`
   * event), or undefined if no create was ever requested there. Its instance
   * type is what routes the path to the right container namespace. */
  async #claim(path: string): Promise<{ instanceType: SandboxInstanceType } | undefined> {
    const event = await this.#catalogue.getEvent({
      idempotencyKey: SandboxCollectionRpcTarget.#claimKey(path),
    });
    if (event === undefined) return undefined;
    return {
      instanceType: SandboxInstanceType.parse(
        (event.payload as { instanceType: string }).instanceType,
      ),
    };
  }

  /** Create a sandbox. Strict: an existing or destroyed path is an error.
   * Returns the path to `get`. */
  async create(
    input: SandboxCreateInput,
  ): Promise<{ createdAt: string; instanceType: SandboxInstanceType; path: string }> {
    const instanceType = SandboxInstanceType.parse(
      input.instanceType ?? DEFAULT_SANDBOX_INSTANCE_TYPE,
    );
    const path = sandboxPathFor(input.name);
    // Validate everything the journal records BEFORE journaling it — a
    // rejected create must leave no trace.
    if (input.sleepAfter !== undefined) assertValidSleepAfter(input.sleepAfter);
    // Claim the name first: append the create-requested to the catalogue,
    // idempotency-keyed by path. The stream dedups by key atomically, so the
    // event that comes back IS the authoritative claim — ours if the name was
    // free, the original if it was ever claimed before (including by a racing
    // creator). Only a matching instance type may proceed to the container
    // namespace: the Durable Object there is the strict authority on whether
    // the sandbox is live, destroyed, or (after a create that died between
    // this append and its call) still to be born — the retry heals it.
    const [claim] = await this.#catalogue.append(
      SandboxProcessorContract.buildEvent({
        type: "events.iterate.com/sandbox/create-requested",
        idempotencyKey: SandboxCollectionRpcTarget.#claimKey(path),
        payload: {
          path,
          instanceType,
          sleepAfter: input.sleepAfter,
          keepAlive: input.keepAlive,
          env: input.env,
        },
      }),
    );
    if (claim === undefined) {
      throw new Error(`sandbox "${path}": the catalogue append returned no event`);
    }
    const claimedType = SandboxInstanceType.parse(
      (claim.payload as { instanceType: string }).instanceType,
    );
    if (claimedType !== instanceType) {
      throw new Error(
        `sandbox "${path}" was already requested as instance type "${claimedType}" — names are unique per project; pick a new name`,
      );
    }
    return await this.#stub(path, instanceType).create({
      env: input.env,
      instanceType,
      keepAlive: input.keepAlive,
      path,
      projectId: this.props.projectId,
      sleepAfter: input.sleepAfter,
    });
  }

  /** The sandbox at a path. Throws unless the path was created (and not destroyed). */
  async get(path: string): Promise<CloudflareSandbox> {
    const asserted = assertSandboxPath(path);
    const claim = await this.#claim(asserted);
    if (claim === undefined) {
      throw new Error(
        `sandbox "${asserted}" does not exist — sandboxes are created explicitly: itx.sandboxes.create({ name, instanceType })`,
      );
    }
    const stub = this.#stub(asserted, claim.instanceType);
    // Getting never creates: the sandbox proves it was created (and not
    // destroyed) before the stub reaches the caller. Container runtimes do
    // not reliably surface `ctx.id.name`, so this call also re-asserts the
    // identity create() recorded — see SandboxDurableObject.assertCreated.
    await stub.assertCreated({ path: asserted, projectId: this.props.projectId });
    return stub;
  }

  /** Every sandbox stream path in the project (`/sandboxes/...`), including
   * destroyed sandboxes' streams — the stream is the history. */
  list(): Promise<StreamListItem[]> {
    return projectProcessorState(this.props.projectId).then((state) =>
      state.streams.filter((stream) => stream.path.startsWith("/sandboxes/")),
    );
  }
}

/**
 * Catalog of durable workspaces within one project.
 *
 * `get("/")` is the project's ROOT workspace: a read-only, always-fresh
 * materialization of the config repo's main branch. Every other workspace is
 * addressed by its FULL path under `/workspaces/` — the same domain-prefix
 * convention as `/sandboxes/...` and `/repos/...`: an agent's workspace is
 * the agent path under the prefix (`/workspaces/agents/...`, exposed as
 * `itx.workspace` in that agent's scope), and standalone workspaces live
 * under `/workspaces/<anything>`. Non-root workspaces are OVERLAYS over the
 * root: writes stay local, missing reads fall through to latest main — no
 * clone, usable instantly.
 */
class WorkspaceCollectionRpcTarget extends IterateRpcTarget<"WorkspaceCollection"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        "Durable workspace filesystems (Durable-Object-hosted, no container, always warm). get(\"/\") is the project's read-only ROOT workspace — always the latest main of the config repo. Other paths live under /workspaces/ and are instant copy-on-write overlays over the root: an agent's own workspace is its agent path under the prefix (what itx.workspace resolves to); pick /workspaces/<name> for standalone ones.",
      children: {
        get: 'The workspace at a path — "/" for the read-only root (latest main), /workspaces/<name> for a private overlay.',
      },
      parent: "a project itx (itx.workspaces)",
    });
  }

  constructor(readonly props: { auth: ItxAuth; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  /** The workspace at a path — "/" is the read-only root (latest main); others are private overlays. */
  get(path: string): WorkspaceRpcTarget {
    return new WorkspaceRpcTarget({
      auth: this.props.auth,
      path: normalizeWorkspacePath(path),
      projectId: this.props.projectId,
    });
  }
}

/**
 * One durable workspace: a private virtual filesystem living in a Durable
 * Object (no container, always warm). The root workspace (`"/"`) is the
 * read-only, always-fresh materialization of the config repo's main branch.
 * Every other workspace is an OVERLAY over the root: reads see latest main
 * until a local write shadows a path, writes and deletes stay private, and
 * there is no clone — a new workspace is usable instantly. `git.commit`
 * commits the overlay's changes straight to the config repo's MAIN branch
 * (the same lane as `itx.repo.commitFiles`, so the project worker/website
 * redeploys automatically), then the overlay resets to mirror the new main.
 *
 * Constraints: the `.git` name is reserved (platform-managed). Large files
 * are fine (past ~1.5MB they are stored in R2 transparently).
 */
class WorkspaceRpcTarget extends IterateRpcTarget<"Workspace"> {
  async __describe(): Promise<Description> {
    const isRoot = isRootWorkspacePath(this.props.path);
    return describeNode({
      instructions: isRoot
        ? "The project's ROOT workspace (\"/\"): a read-only, always-fresh checkout of the config repo's main branch — reads always see the latest commit on main. Writes are rejected (write in your own workspace, or commit to main via itx.repo). Every other workspace overlays this one."
        : `A durable workspace at "${this.props.path}": an instant copy-on-write overlay over the config repo's latest main (no clone — reads fall through to main until a local write shadows a path; writes and deletes stay private until committed). Paths are absolute with "/" as the repo root. ` +
          "workspace.git.commit({ message }) commits your changes to the config repo's MAIN branch — the project worker/website redeploys automatically; no branches, no push, no extra steps.",
      children: {
        appendFile: "Append to a file (copies a fallen-through file up first).",
        cp: "Copy a file or directory ({ recursive } for trees).",
        deleteFile: "Delete one file (false when it did not exist).",
        edit: "Replace an exact string in one file; oldString must match once unless replaceAll is true. Private until committed via git.",
        exists: "Whether a path exists.",
        git: "Commit surface: status (changes vs main), commit (changes → the config repo's main), log (main's history).",
        glob: "Files matching a glob pattern.",
        kill: "Restart the workspace's server-side object; the next request boots it fresh.",
        listAllFiles: "Every file path in the merged view (sorted).",
        mkdir: "Create a directory ({ recursive } for parents).",
        mv: "Move/rename a file or directory.",
        readDir: "List a directory (defaults to the root).",
        readFile: "One file's contents ({ path }); null when missing.",
        readFileBytes: "One file's raw bytes; null when missing (use for binaries).",
        reset:
          "Wipe the local layer and deletions — back to a pristine view of main. Unpublished work is LOST.",
        revert: "Un-pin ONE path: drop the local copy/deletion so it follows latest main again.",
        rm: "Remove a path ({ recursive, force }).",
        stat: "Metadata for one path; null when missing.",
        whoami: "Workspace identity string (debug).",
        writeFile: "Write one file (creates parent directories).",
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
    return env.WORKSPACE.getByName(
      DurableObjectNameCodec.stringify({
        path: this.props.path,
        projectId: this.props.projectId,
      }),
    );
  }

  /** Workspace identity string (debug). */
  whoami(): Promise<string> {
    return this.durableObjectStub.whoami();
  }

  /** Restart the workspace's server-side object; the next request boots it fresh. */
  kill(): Promise<void> {
    return Promise.resolve(this.durableObjectStub.kill());
  }

  /** File contents, or null when the path does not exist. */
  readFile(path: string): Promise<string | null> {
    return this.durableObjectStub.readFile(path);
  }

  /** Raw file bytes (use for binaries — readFile text-decodes), or null when missing. */
  readFileBytes(path: string): Promise<Uint8Array | null> {
    return this.durableObjectStub.readFileBytes(path);
  }

  /**
   * Wipe the workspace back to pristine: the local layer and every deletion
   * vanish, leaving a clean view of latest main (on the root, the next read
   * re-materializes). Uncommitted work is LOST (committed changes live on
   * main).
   */
  reset(): Promise<void> {
    return this.durableObjectStub.reset();
  }

  /**
   * Un-pin one path: drop the local copy (file or subtree) and any deletion
   * of it, so the path follows latest main again — the surgical sibling of
   * reset(). Scoped at-or-below the path; a deleted ancestor directory still
   * masks it until that ancestor is reverted too.
   */
  revert(path: string): Promise<void> {
    return this.durableObjectStub.revert(path);
  }

  /** Every file path in the merged view (local layer over latest main), sorted. */
  listAllFiles(): Promise<string[]> {
    return this.durableObjectStub.listAllFiles();
  }

  writeFile(path: string, content: string): Promise<void> {
    return this.durableObjectStub.writeFile(path, content);
  }

  writeFileBytes(path: string, data: Uint8Array): Promise<void> {
    return this.durableObjectStub.writeFileBytes(path, data);
  }

  appendFile(path: string, content: string): Promise<void> {
    return this.durableObjectStub.appendFile(path, content);
  }

  /** Delete one file. Returns false when the path did not exist. */
  deleteFile(path: string): Promise<boolean> {
    return this.durableObjectStub.deleteFile(path);
  }

  /**
   * Safely replace text in one file (uncommitted — use `git` to publish).
   * The `oldString` must match exactly once unless `replaceAll` is true.
   */
  edit(input: EditWorkspaceFileInput): Promise<EditWorkspaceFileResult> {
    return this.durableObjectStub.edit(input);
  }

  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    return this.durableObjectStub.mkdir(path, opts);
  }

  readDir(dir?: string): Promise<WorkspaceFileInfo[]> {
    return this.durableObjectStub.readDir(dir);
  }

  glob(pattern: string): Promise<WorkspaceFileInfo[]> {
    return this.durableObjectStub.glob(pattern);
  }

  rm(path: string, opts?: { force?: boolean; recursive?: boolean }): Promise<void> {
    return this.durableObjectStub.rm(path, opts);
  }

  cp(src: string, dest: string, opts?: { recursive?: boolean }): Promise<void> {
    return this.durableObjectStub.cp(src, dest, opts);
  }

  mv(src: string, dest: string, opts?: { recursive?: boolean }): Promise<void> {
    return this.durableObjectStub.mv(src, dest, opts);
  }

  /** File metadata, or null when the path does not exist. */
  stat(path: string): Promise<WorkspaceFileInfo | null> {
    return this.durableObjectStub.stat(path);
  }

  exists(path: string): Promise<boolean> {
    return this.durableObjectStub.exists(path);
  }

  /** Git over this workspace's checkout. */
  get git(): WorkspaceGitRpcTarget {
    return new WorkspaceGitRpcTarget(this.props);
  }
}

/**
 * The commit surface of an overlay workspace. There is no staging area, no
 * branch, and no separate push: `commit({ message })` turns the workspace's
 * changes (local files minus `.gitignore`d paths, plus deletions) into ONE
 * ordinary commit on the config repo's MAIN branch — the same lane as
 * `itx.repo.commitFiles`, so the project worker/website redeploys
 * automatically. Credentials are internal; no token rides this surface.
 */
class WorkspaceGitRpcTarget extends IterateRpcTarget<"WorkspaceGit"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        `Commit surface of the workspace at "${this.props.path}". commit({ message }) commits this workspace's changes to the config repo's MAIN branch — changes go live immediately (the project worker/website rebuilds from main automatically). ` +
        "No add, no push, no branches: every local file not .gitignored is included, deletions apply, and afterwards the workspace mirrors the new main.",
      children: {
        commit: "Commit the workspace's changes to the config repo's main ({ message, author? }).",
        log: "The config repo's main-branch history, newest first ({ limit? }).",
        status: "Changes vs latest main: added / modified (shadowed) / deleted paths.",
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
    return env.WORKSPACE.getByName(
      DurableObjectNameCodec.stringify({
        path: this.props.path,
        projectId: this.props.projectId,
      }),
    );
  }

  /** Changes vs latest main: added / modified (shadowed, not content-diffed) / deleted. */
  status(): Promise<WorkspaceChange[]> {
    return this.durableObjectStub.gitStatus();
  }

  /** Commit the workspace's changes to the config repo's main branch (goes live immediately). */
  commit(input: {
    author?: { email: string; name: string };
    message: string;
  }): Promise<WorkspacePublishResult> {
    return this.durableObjectStub.gitCommit(input);
  }

  /** The config repo's main-branch history, newest first. */
  log(input?: { limit?: number }): Promise<WorkspaceGitLogEntry[]> {
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
        create: "Create this secret with its initial egress, material, and refresh config.",
        fetch:
          "Egress fetch with secret placeholders substituted server-side (HTTP headers/URL, including Upgrade handshake).",
        kill: "Restart the secret's server-side object; the next request boots it fresh.",
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

  /** Create this secret and wait until its processor has folded the birth certificate. */
  create(input: SecretCreateInput): Promise<StreamEvent> {
    return this.durableObjectStub.create(input);
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

/** Parse a stored ref metadata value; malformed JSON/shape yields undefined, never a throw. */
function parseStoredRef(serialized: string): ItxExpression | undefined {
  try {
    return ItxExpression.parse(JSON.parse(serialized));
  } catch {
    return undefined;
  }
}

/**
 * Snippet length per row and the default row count. Rows are deliberately
 * TINY (kind, date, context, ~2-sentence snippet, ref) so many matches fit
 * one glance — judge here, evaluate `ref` for the whole thing. 30 rows of
 * snippet+metadata ≈ 20k chars, safely inside the 30k inline script-result
 * cap; `limit` accepts up to the API's 50.
 */
const SNIPPET_CHARS = 200;
const DEFAULT_RESULT_ROWS = 30;

/**
 * One result row per MATCH LOCATION — full-text-search semantics. The corpus
 * stores stream events in 100-offset SEGMENT documents, so ten different
 * pirate mentions in one segment are ten different chunks of ONE document:
 * deduping by document would collapse ten real matches to one. The identity
 * that matches user intuition is the chunk-narrowed ref window (the exact
 * events a chunk covers): distinct windows stay distinct rows; the SAME
 * window (context-expansion echoes, re-scored duplicates) collapses to its
 * best score. Non-stream documents (files, repo files, custom docs) narrow
 * to the whole-object ref, so their chunks collapse per document — which is
 * right: every chunk of one file leads to the same domain object.
 */
function dedupeChunksByMatchLocation(
  chunks: AiSearchSearchResponse["chunks"],
): AiSearchSearchResponse["chunks"] {
  const best = new Map<string, AiSearchSearchResponse["chunks"][number]>();
  for (const chunk of chunks) {
    const metadata = chunk.item.metadata ?? {};
    const storedRef = typeof metadata.ref === "string" ? parseStoredRef(metadata.ref) : undefined;
    const narrowed =
      storedRef === undefined ? undefined : narrowStreamRefToChunk(storedRef, chunk.text);
    // narrowStreamRefToChunk returns the stored ref UNCHANGED when the chunk
    // text carries no offset headers (the continuation slice of one oversized
    // event) — identical for every such chunk in the segment, though they are
    // DISTINCT matches (possibly of different giant events). Give those their
    // own identity via the chunk text: over-keeping beats collapsing real
    // matches. Non-stream documents narrow to the whole-object ref by design
    // and keep whole-document identity — every chunk of one file leads to the
    // same domain object.
    const narrowedToWindow = narrowed !== undefined && narrowed !== storedRef;
    const isStreamDocument = metadata.kind === "streams";
    const identity = narrowedToWindow
      ? `${chunk.item.key}#${JSON.stringify(narrowed)}`
      : isStreamDocument
        ? `${chunk.item.key}#raw:${chunk.text.slice(0, 120)}`
        : chunk.item.key;
    const existing = best.get(identity);
    if (existing === undefined || chunk.score > existing.score) best.set(identity, chunk);
  }
  return [...best.values()];
}

/**
 * Search everything this project has accumulated — every conversation (web
 * chat, Slack threads, email, Telegram), inbound webhook (GitHub, Slack),
 * stream event, itx.files object, repo file, and custom document — with
 * semantic + keyword retrieval. Every hit carries a `ref` expression that
 * fetches the exact source back, so a result is never a dead end.
 *
 * Mechanics: one Cloudflare AI Search instance per project (born with the
 * project), indexing only that project's slice of the deployment's corpus
 * bucket — tenancy is structural, not a query filter.
 */
class SearchRpcTarget extends IterateRpcTarget<"Search"> {
  constructor(
    readonly props: { auth: ItxAuth; projectId: string; capabilityHost: CapabilityHostRpcTarget },
  ) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        "Search the project's PAST: every conversation (web chat, Slack, email, Telegram), " +
        "webhook (GitHub, Slack), stream event, file, and repo file is indexed — semantic + " +
        "keyword, so ask a plain question. Two searches, one rule: itx.docs.search finds HOW " +
        "(example code, types, capabilities); itx.search.query finds WHAT (this project's own " +
        "content and history — the top docs hits federate in automatically; docs is not a " +
        'source — use exclude: ["docs"] to drop them). query({ q }) returns ' +
        "scored chunks; hits carry a `ref` — an itx EXPRESSION ARRAY leading back to the domain " +
        'object: ["streams", ["get", path], ["getEvents", { afterOffset, beforeOffset }]] for ' +
        'stream events, ["files", ["get", path]], ["repos", ["get", repoPath], ["readFile", ' +
        '{ path }]], or ["docs", ["get", { name }]]. Evaluate a ref by walking it: let v = itx; ' +
        "for (const step of ref) v = typeof step === 'string' ? v[step] : await v[step[0]]" +
        "(...step.slice(1)); — plus `kind` and a human-readable `context` on every hit. " +
        "answer({ q }) generates a cited answer. Narrow with source " +
        '("streams" | "files" | "repos") or exclude kinds; options: limit (1–50), ' +
        "scoreThreshold, rewriteQuery. indexEvent({ stream, offset, note? }) pins one event by " +
        "coordinates; index({ kind, id, text, ref, title?, context? }) adds a standalone " +
        "document (ref REQUIRED — the itx expression back to the source); " +
        "indexStream/indexRepo/backfillFiles backfill one unit, reindex() sweeps the whole " +
        "project (all streams + repos + files). Everything indexes automatically except " +
        "ephemeral and stream-housekeeping events. Explicit index verbs are searchable in ~a " +
        "minute; automatic mirroring can lag up to the hourly sync. Noisy first page? REFINE, " +
        "don't abandon: drop filler words (slack/message/conversation match every webhook), " +
        'quote exact tokens ("superfart"), add source/exclude — one refined query beats a ' +
        "vendor-API detour.",
      children: {
        answer: "RAG answer over the project corpus + docs, with cited source chunks.",
        backfillFiles: "Re-mirror every existing itx.files object into the search corpus.",
        ensureIndex:
          "Ensure the search instance exists — you normally never need this (created at project " +
          "birth; query/index self-heal). To rebuild content, see reindex.",
        index:
          "Add/replace one standalone document ({ kind, id, text, ref, title?, context? }) — " +
          "ref (itx expression) is required.",
        indexEvent:
          "Pin/annotate: make ONE stream event a first-class search document " +
          "({ path, offset, note? }) — its hit's ref leads back to exactly it.",
        indexRepo:
          "Backfill/repair (rarely needed — indexing is automatic): snapshot one repo's HEAD now.",
        indexStream:
          "Backfill/repair (rarely needed — indexing is automatic): re-index one stream from offset 0.",
        reindex:
          "Backfill/repair the WHOLE project — every stream, repo, and file; idempotent, re-runnable.",
        query:
          "Retrieve scored, kind-tagged chunks matching a query (with source/exclude filters).",
      },
      parent: "a project itx (itx.search)",
    });
  }

  get #instance(): AiSearchInstance {
    return env.SEARCH_INSTANCES.get(projectSearchInstanceId(this.props.projectId));
  }

  #searchOptions(
    input: {
      limit?: number;
      rewriteQuery?: boolean;
      scoreThreshold?: number;
      source?: string;
      exclude?: readonly string[];
    },
    options?: { expandContext?: boolean },
  ): AiSearchOptions {
    return {
      retrieval: {
        filters: searchFilters({
          projectId: this.props.projectId,
          // Platform kinds pass through; custom kinds are re-normalized by
          // the same rules index() wrote them under; "docs" throws (it is
          // federated, never stored).
          source: input.source === undefined ? undefined : normalizeSearchSource(input.source),
          // "docs" is federated, never in the R2 corpus, so it can't be an R2
          // filter; drop it here and let #federatedDocs honour the exclusion.
          excludeKinds:
            input.exclude === undefined
              ? undefined
              : normalizeSearchExcludeKinds(input.exclude).filter((kind) => kind !== "docs"),
        }),
        // Tuned for GENEROUS INCLUSION (Jonas, 2026-07-13): recall over
        // precision — a downstream fast-LLM pass can always filter the result
        // set in conversation context, but a hit that never surfaces is gone.
        // Defaults beat the instance's (10 results, 0.4 threshold); explicit
        // caller values still win.
        max_num_results: input.limit ?? DEFAULT_RESULT_ROWS,
        match_threshold: input.scoreThreshold ?? 0.2,
        // OR-mode keyword matching: dogfooding showed the default AND-mode
        // misses exact-token queries whose terms don't co-occur in one chunk;
        // hybrid rrf fusion keeps precision.
        keyword_match_mode: "or",
        // Neighbor expansion triples every chunk's text. Worth it ONLY where
        // a model reads the chunks server-side (answer's RAG generation);
        // query() consumers judge relevance and follow `ref` for the full
        // source, so expansion just bloats the wire (live: it pushed a
        // default query to the spill edge).
        context_expansion: options?.expandContext ? 1 : 0,
      },
      query_rewrite: input.rewriteQuery === undefined ? undefined : { enabled: input.rewriteQuery },
    };
  }

  /** Map one AI Search chunk to a provenance-carrying result. */
  #toChunk(chunk: AiSearchSearchResponse["chunks"][number], query: string): SearchResultChunk {
    const metadata = chunk.item.metadata ?? {};
    const storedRef = typeof metadata.ref === "string" ? parseStoredRef(metadata.ref) : undefined;
    // Rows carry a short match snippet, never whole chunks (Jonas's design:
    // "kind, metadata, matching couple of sentences, date" — the ref gets
    // the whole thing). Chunk text stays server-side.
    return {
      filename: chunk.item.key,
      score: chunk.score,
      content: extractMatchSnippet(chunk.text, query, SNIPPET_CHARS),
      date:
        typeof chunk.item.timestamp === "number"
          ? new Date(chunk.item.timestamp * (chunk.item.timestamp < 1e12 ? 1000 : 1)).toISOString()
          : undefined,
      kind: typeof metadata.kind === "string" ? metadata.kind : undefined,
      context: typeof metadata.context === "string" ? metadata.context : undefined,
      // Every corpus writer stores `ref` — the serialized itx expression back
      // to the domain object. Parse defensively (a hit without one is still a
      // valid result), then narrow stream refs to the exact events the chunk
      // contains — the stored ref covers the whole storage segment.
      ref: storedRef === undefined ? undefined : narrowStreamRefToChunk(storedRef, chunk.text),
    };
  }

  /**
   * Federated `docs` results: itx.docs is a static in-worker keyword index
   * (examples + types + this scope's mounted capabilities), not part of the R2
   * corpus, so query() merges it in unless docs are excluded / a different
   * source is pinned. Docs scores are keyword-overlap counts, not comparable
   * to the corpus's relevance scores — a descending band from 0.5 keeps
   * strong corpus hits on top while docs still surface mid-list.
   */
  async #federatedDocs(input: {
    query: string;
    source?: string;
    exclude?: readonly string[];
    limit?: number;
  }): Promise<SearchResultChunk[]> {
    if (input.source !== undefined) return []; // a corpus source was pinned
    if (
      input.exclude !== undefined &&
      normalizeSearchExcludeKinds(input.exclude).includes("docs")
    ) {
      return [];
    }
    const docs = new ItxDocsRpcTarget({ capabilityHost: this.props.capabilityHost });
    const hits = await docs.search({ q: input.query });
    return hits.slice(0, Math.min(input.limit ?? 5, 5)).map((hit, index) => ({
      filename: hit.fetchCall,
      score: 0.5 - index * 0.02,
      content: hit.summary,
      kind: "docs",
      context: `${hit.kind}: ${hit.name} — fetch with ${hit.fetchCall}`,
      ref: ["docs", ["get", { name: hit.name }]] as ItxExpression,
    }));
  }

  /**
   * A missing instance is the expected first-touch state: create it (its
   * first sync then indexes the project's existing corpus slice) and tell the
   * caller the index is warming instead of failing.
   */
  async #ensureInstanceAfterMiss(error: unknown): Promise<string> {
    try {
      const { created } = await ensureProjectSearchInstance(this.props.projectId);
      return created
        ? "Search instance created for this project; the first index is in progress — retry shortly."
        : `AI Search request failed: ${String(error).slice(0, 200)}`;
    } catch (provisionError) {
      return `AI Search instance provisioning failed: ${String(provisionError).slice(0, 200)}`;
    }
  }

  /**
   * Ensure this project's search instance exists (idempotent). The project
   * CREATE SAGA calls this so search is warm from birth; the lazy
   * query/index paths remain as self-heal for projects that predate it.
   * Safe to call any time — an existing instance is a no-op.
   */
  async ensureIndex(): Promise<{ created: boolean }> {
    const { created } = await ensureProjectSearchInstance(this.props.projectId);
    return { created };
  }

  /**
   * Retrieve scored chunks matching a query, scoped to this project's own
   * search instance. Merges the corpus (streams/files/repos/custom kinds)
   * with federated itx.docs, each result tagged with its `kind` and `context`
   * so callers can contextualize a hit. ONE row per MATCH — distinct event
   * windows within one stream segment stay distinct rows (full-text-search
   * semantics); only same-location re-scores collapse. Rows are TINY: kind,
   * date, context, a ~2-sentence snippet around the match, and the ref that
   * fetches the whole thing — so the default 30 rows read at a glance and a
   * result set stays well inside one inline script return. Docs hits carry
   * synthetic 0.5-band
   * scores (not comparable to corpus relevance), ride on top of `limit`
   * corpus chunks (their own cap: min(limit, 5)), and ignore
   * `scoreThreshold`. On a
   * project whose instance doesn't exist yet, the instance is created and
   * docs results return with a `warning` — retry once its first index
   * completes (typically a minute or two). A warning-free empty result means
   * the index is live and simply has no match.
   */
  async query(input: {
    q: string;
    /** Max result rows (1–50, default 30 — rows are tiny snippets; go wide). */
    limit?: number;
    /** Rewrite the query for retrieval first (extra LLM call). */
    rewriteQuery?: boolean;
    /** Drop chunks scoring below this threshold (0–1, default 0.2 — generous; filter downstream). */
    scoreThreshold?: number;
    /** Restrict to ONE corpus kind — "streams" | "files" | "repos" or a custom index() kind (skips docs federation). */
    source?: string;
    /** Exclude kinds from results (platform or custom), e.g. `["streams"]` to skip the event log. */
    exclude?: readonly string[];
  }): Promise<SearchQueryResult> {
    const [corpus, docs] = await Promise.allSettled([
      this.#instance.search({ query: input.q, ai_search_options: this.#searchOptions(input) }),
      this.#federatedDocs({
        query: input.q,
        source: input.source,
        exclude: input.exclude,
        limit: input.limit,
      }),
    ]);
    // Docs are in-worker and must not be lost to a corpus outage; the reverse
    // (docs failing) is a real bug worth surfacing, so it still throws.
    if (docs.status === "rejected") throw docs.reason;
    if (corpus.status === "rejected") {
      const warning = await this.#ensureInstanceAfterMiss(corpus.reason);
      if (input.source !== undefined) return { searchQuery: input.q, results: [], warning };
      return { searchQuery: input.q, results: docs.value, warning };
    }
    const deduped = dedupeChunksByMatchLocation(corpus.value.chunks);
    const results = [...deduped.map((chunk) => this.#toChunk(chunk, input.q)), ...docs.value].sort(
      (a, b) => b.score - a.score,
    );
    return { searchQuery: corpus.value.search_query, results };
  }

  /**
   * Retrieve matching chunks AND generate an answer from them (RAG). Same
   * first-touch grammar as `query`: on a project whose instance doesn't
   * exist yet, the instance is created and an empty-response result returns
   * with a `warning` — retry shortly. `searchQuery` echoes the input
   * verbatim (never the rewritten query).
   */
  async answer(input: {
    q: string;
    limit?: number;
    rewriteQuery?: boolean;
    scoreThreshold?: number;
    source?: string;
    exclude?: readonly string[];
    /** Optional system prompt for the answer generation. */
    systemPrompt?: string;
  }): Promise<SearchAnswerResult> {
    // Validation (bad source/exclude) throws HERE, outside the degrade path:
    // an invalid request is the caller's bug, never a warning — mirroring
    // query(), whose #searchOptions also runs before any catch.
    const searchOptions = this.#searchOptions(input, { expandContext: true });
    let response: AiSearchChatCompletionsResponse;
    try {
      response = await this.#instance.chatCompletions({
        messages: [
          ...(input.systemPrompt === undefined
            ? []
            : [{ role: "system" as const, content: input.systemPrompt }]),
          { role: "user" as const, content: input.q },
        ],
        ai_search_options: searchOptions,
      });
    } catch (error) {
      // Degrade exactly like query(): one failure grammar for the whole door.
      const warning = await this.#ensureInstanceAfterMiss(error);
      return { response: "", searchQuery: input.q, results: [], warning };
    }
    return {
      response: response.choices[0]?.message.content ?? "",
      searchQuery: input.q,
      results: response.chunks.map((chunk) => this.#toChunk(chunk, input.q)),
    };
  }

  /**
   * Add (or replace) one document in the search corpus — the general
   * mechanism to make derived content (summaries, notes, digests) findable
   * via `query`. `ref` is REQUIRED: the itx expression leading back to the
   * domain object the text derives from (e.g. `["streams", ["get", path],
   * ["getEvents", { afterOffset, beforeOffset }]]`), returned on every hit so
   * a search result is never a dead end. `kind` is `[a-z0-9._-]+` and must
   * not be a reserved platform kind (streams/files/repos/docs); the
   * serialized ref caps at 500 chars. `id` is stable within
   * `(project, kind)`, so re-indexing the same id overwrites. `context` is
   * the one-line descriptor shown on every hit and to the answer model.
   */
  async index(input: {
    kind: string;
    id: string;
    text: string;
    /** The itx expression that leads back to the source domain object. */
    ref: ItxExpression;
    title?: string;
    context?: string;
  }): Promise<{ key: string }> {
    const result = await indexDocument({ ...input, projectId: this.props.projectId });
    // First index() bootstraps the project's instance; the sync trigger makes
    // the document searchable in seconds instead of the hourly schedule.
    await ensureProjectSearchInstance(this.props.projectId);
    await triggerProjectSearchSync(this.props.projectId);
    return result;
  }

  /**
   * Pin one stream event into the search corpus by its coordinates — the
   * domain-object way to make a specific moment findable. The event's content
   * is read from the stream (never trusted from the caller) and indexed as a
   * focused document together with the optional `note`; the search hit's
   * `ref` is the itx expression fetching exactly that event. Idempotent per
   * (stream, offset).
   */
  async indexEvent(
    input: (
      | {
          /** The stream path, e.g. "/agents/slack/T1/thr-9". */
          path: string;
          stream?: undefined;
        }
      | {
          /** Alias for `path` (the original name of this parameter). */
          stream: string;
          path?: undefined;
        }
    ) & {
      /** The event's offset on that stream. */
      offset: number;
      /** Optional annotation, indexed alongside the event ("decision made here"). */
      note?: string;
    },
  ): Promise<{ key: string }> {
    const streamPath = input.path ?? input.stream;
    if (streamPath === undefined) {
      // Unreachable for TS callers (the union requires one); itx callers are
      // dynamic, so keep the runtime guard with a pointed message.
      throw new Error("indexEvent needs the stream path: { path, offset }");
    }
    const path = normalizePath(streamPath);
    const streamStub = env.STREAM.getByName(
      DurableObjectNameCodec.stringify(
        { projectId: this.props.projectId, path },
        { allowNullProjectId: true },
      ),
    );
    const [event] = await streamStub.getEvents({
      afterOffset: input.offset - 1,
      beforeOffset: input.offset + 1,
      limit: 1,
    });
    if (event === undefined) {
      throw new Error(`no event at offset ${input.offset} on stream ${path}`);
    }
    const result = await indexPinnedStreamEvent({
      projectId: this.props.projectId,
      event,
      note: input.note,
    });
    await ensureProjectSearchInstance(this.props.projectId);
    await triggerProjectSearchSync(this.props.projectId);
    return result;
  }

  /**
   * Re-index one stream from the beginning — the repair verb for streams that
   * predate search indexing, or the rare tail gap a failed per-batch write can
   * leave (`path` is the stream path, e.g. "/agents/slack/T1/thr-9").
   */
  async indexStream(input: { path: string }): Promise<{ segments: number }> {
    const streamStub = env.STREAM.getByName(
      DurableObjectNameCodec.stringify(
        { projectId: this.props.projectId, path: normalizePath(input.path) },
        { allowNullProjectId: true },
      ),
    );
    const result = await indexEntireStream({
      projectId: this.props.projectId,
      path: normalizePath(input.path),
      readEvents: (args) => streamStub.getEvents(args),
    });
    await ensureProjectSearchInstance(this.props.projectId);
    await triggerProjectSearchSync(this.props.projectId);
    return result;
  }

  /**
   * Snapshot one repo's default-branch HEAD into the search corpus now — the
   * backfill verb for repos that predate search indexing (writes index
   * incrementally from here on). Runs on the repo Durable Object's own write
   * chain so its stale-key sweep can't race post-commit indexing. Returned
   * counts: `deleted` = stale keys swept, `skipped` = oversize/over-long-key
   * files, and a nonzero `failed` means re-run.
   */
  async indexRepo(input: { path: string }): Promise<{
    deleted: number;
    indexed: number;
    skipped: number;
    failed: number;
  }> {
    const result = await env.REPO.getByName(
      DurableObjectNameCodec.stringify({
        projectId: this.props.projectId,
        path: normalizePath(input.path),
      }),
    ).reindexSearch();
    await ensureProjectSearchInstance(this.props.projectId);
    await triggerProjectSearchSync(this.props.projectId);
    return result;
  }

  /**
   * Re-mirror every existing itx.files object into the search corpus — the
   * backfill verb for files that predate search indexing (puts mirror
   * incrementally from here on). Counts reflect the actual mirror outcome:
   * `failed` is a swallowed R2 error, so a nonzero `failed` means re-run.
   */
  async backfillFiles(): Promise<{ mirrored: number; skipped: number; failed: number }> {
    const counts = { mirrored: 0, skipped: 0, failed: 0 };
    for await (const file of listProjectFiles(this.props.projectId)) {
      const outcome = await mirrorFileToSearchIndex({
        ...file,
        projectId: this.props.projectId,
      });
      counts[outcome] += 1;
    }
    await ensureProjectSearchInstance(this.props.projectId);
    await triggerProjectSearchSync(this.props.projectId);
    return counts;
  }

  /**
   * Reindex the WHOLE project — every known stream, every repo's default
   * branch, every itx.files object — in one crude, idempotent sweep. This is
   * the backfill/repair verb for projects that predate search indexing (new
   * writes index automatically); every unit overwrites its own corpus keys,
   * so re-running (including after a timeout on a huge project) only fills
   * gaps. Streams run a few at a time; expect minutes on large projects. Per
   * unit failures are counted, never thrown — nonzero `failed` means re-run.
   */
  async reindex(): Promise<{
    streams: { indexed: number; segments: number; failed: number };
    repos: { indexed: number; failed: number };
    files: { mirrored: number; skipped: number; failed: number };
  }> {
    const state = await projectProcessorState(this.props.projectId);
    const streams = { indexed: 0, segments: 0, failed: 0 };
    const queue = [...state.streams];
    await Promise.all(
      Array.from({ length: 5 }, async () => {
        for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
          const path = normalizePath(item.path);
          try {
            const streamStub = env.STREAM.getByName(
              DurableObjectNameCodec.stringify(
                { projectId: this.props.projectId, path },
                { allowNullProjectId: true },
              ),
            );
            const { segments } = await indexEntireStream({
              projectId: this.props.projectId,
              path,
              readEvents: (args) => streamStub.getEvents(args),
            });
            streams.indexed += 1;
            streams.segments += segments;
          } catch (error) {
            console.warn(`search reindex: stream ${path} failed: ${String(error)}`);
            streams.failed += 1;
          }
        }
      }),
    );
    const repos = { indexed: 0, failed: 0 };
    for (const repo of state.repos) {
      try {
        await env.REPO.getByName(
          DurableObjectNameCodec.stringify({
            projectId: this.props.projectId,
            path: normalizePath(repo.path),
          }),
        ).reindexSearch();
        repos.indexed += 1;
      } catch (error) {
        console.warn(`search reindex: repo ${repo.path} failed: ${String(error)}`);
        repos.failed += 1;
      }
    }
    const files = await this.backfillFiles(); // also ensures the instance + triggers the sync
    return { streams, repos, files };
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
            ) as unknown as ProcessorHostStub,
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
      // No in-process token fetch — the Gmail call goes through the connection
      // secret's fetch with a placeholder Authorization header; the Secret DO
      // substitutes the access token and its oauth-refresh-token strategy
      // refreshes on 401.
      const connectionPath = googleConnectionSecretPath(connection);
      return await callGmailApi({
        authorization: `Bearer getSecret({ path: "${connectionPath}", field: "accessToken" })`,
        request: args[0] as GmailRequestInput,
        send: (request) =>
          env.SECRET.getByName(
            DurableObjectNameCodec.stringify({
              path: connectionPath,
              projectId: this.props.projectId,
            }),
          ).fetch(request),
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
        const relay = new ProcessorRelayRpcTarget({
          auth: this.props.auth,
          host: () =>
            env.PROJECT.getByName(
              DurableObjectNameCodec.stringify({
                path: `/integrations/telegram/${connection}`,
                projectId: this.props.projectId,
              }),
            ) as unknown as ProcessorHostStub,
        });
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
        ) as unknown as ProcessorHostStub,
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
    return EmailAgentBirthCertificate.parse(event.payload).config.threadId;
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
        type: EMAIL_SENT_EVENT_TYPE,
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
    const schema = EmailProcessorContract.events[EMAIL_RECEIVED_EVENT_TYPE].payloadSchema;
    const stream = integrationStreamStub(this.props.projectId, this.props.scopePath);
    let afterOffset = 0;
    let last: ReturnType<(typeof schema)["parse"]> | null = null;
    for (;;) {
      const page = await stream.getEvents({
        afterOffset,
        eventTypes: [EMAIL_RECEIVED_EVENT_TYPE],
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
    normalizeAgentPath(props.capabilityHost.path);
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
      host: () => this.durableObjectStub as unknown as ProcessorHostStub,
    });
  }

  /** The agent's own event stream. */
  get stream(): StreamRpcTarget {
    return new StreamRpcTarget({
      auth: this.#props.auth,
      projectId: this.#props.projectId,
      path: this.#path,
    });
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
   * Create the agent on this stream. The birth certificate contains only the
   * processor-owned config; this method also creates the universally paired
   * capability host, installs both subscriptions, appends any durable
   * `initialEvents` in the same batch, and returns only after both processors
   * have durably processed the complete batch.
   */
  async create(input: AgentCreateInput = {}): Promise<void> {
    const initialEvents: StreamEventInput[] = input.initialEvents ?? [];
    if (initialEvents.some((event) => event.idempotencyKey === undefined)) {
      throw new Error("agent create initialEvents must have idempotency keys");
    }
    if (initialEvents.some((event) => event.ephemeral === true)) {
      throw new Error("agent create initialEvents must be durable");
    }
    const creation = agentCreationForPath({
      agentPath: this.#path,
      projectId: this.#props.projectId,
      ...(await agentBootProjectFacts(this.#props.projectId)),
      overrides: { model: input.model, systemPrompt: input.systemPrompt },
    });
    const committed = await this.stream.append(...creation.events, ...initialEvents);
    // append() preserves INPUT order, including idempotency hits at their old
    // offsets. A paired capability host may already exist, so the last input
    // is not necessarily the newest event. The create boundary is the maximum
    // offset across the complete batch.
    const offset = committed.reduce((maximum, event) => Math.max(maximum, event.offset), 0);
    if (offset === 0) throw new Error("agent create committed no events");
    await Promise.all([
      this.processor.waitUntilProcessed({ offset }),
      this.capabilityHost.processor.waitUntilProcessed({ offset }),
    ]);
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
   * Update this agent's status record — the title, note, and shortStatus that
   * project surfaces (the agents list, the Slack thread status) show for it.
   * A MERGE: only the fields you pass change; the platform patches the
   * busy/idle flag (and what you are doing — waiting for a response vs running code)
   * into the same record on its own. `shortStatus` completes the sentence
   * "<agent> is …" (e.g. "comparing flight prices") and is shown verbatim
   * while the agent works — update it as your work moves through phases.
   * `note` is a one-or-two-sentence description of the agent or its current
   * focus; `title` names the agent/conversation; `blocked: true` marks a
   * turn that ended waiting on a human.
   */
  async setStatus(input: {
    title?: string;
    note?: string;
    shortStatus?: string;
    /** Set true when ending a turn to wait on a human (an answer, an
     * approval, a secret) — surfaces show the agent as blocked instead of
     * idle. The platform clears it when the next message wakes you. */
    blocked?: boolean;
    /** A builtin icon name ("slack" | "github" | "email" | "telegram" |
     * "web") or an https image URL, shown next to this agent on roster
     * surfaces. */
    icon?: string;
  }): Promise<StreamEvent> {
    await this.#assertCreated();
    // Whitespace-only values are dropped, not journaled: a patch of empty
    // strings would blank titles and notes on every surface.
    const field = (value: string | undefined) => {
      const trimmed = value?.trim();
      return trimmed === undefined || trimmed === "" ? undefined : trimmed;
    };
    const patch = {
      ...(field(input.title) === undefined ? {} : { title: field(input.title) }),
      ...(field(input.note) === undefined ? {} : { note: field(input.note) }),
      ...(field(input.shortStatus) === undefined ? {} : { shortStatus: field(input.shortStatus) }),
      ...(field(input.icon) === undefined ? {} : { icon: field(input.icon) }),
      ...(input.blocked === undefined ? {} : { blocked: input.blocked }),
    };
    if (Object.keys(patch).length === 0) {
      throw new Error(
        "agent.setStatus requires at least one non-empty field (title, note, shortStatus, icon, blocked).",
      );
    }
    const [event] = await this.stream.append({
      type: "events.iterate.com/agent/status-changed",
      payload: patch,
    });
    return event;
  }

  /** Name this agent/conversation — sugar for `setStatus({ title })`. */
  setTitle(title: string): Promise<StreamEvent> {
    return this.setStatus({ title });
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
        ask: "Send a message and wait for the agent's next chat reply.",
        capabilityHost:
          "This agent scope's durable capability table — also the dotted door to its dynamic capabilities (capabilityHost.<name>(args)).",
        chat: "The agent's web-chat door (sendMessage).",
        create: "Create this agent and wait for its processors to consume the birth batch.",
        setStatus:
          'Merge-update this agent\'s title / note / shortStatus (shortStatus completes "<agent> is …" on live surfaces).',
        setTitle: "Name this agent/conversation (sugar for setStatus({ title })).",
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
 * platform lifecycle surface (`invokeCapability`, `kill`, disposal); everything
 * else belongs to the loaded worker.
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
    const source =
      this.#ref.source.files.type === "inline"
        ? {
            ...this.#ref.source,
            files: {
              type: "inline" as const,
              files: Object.fromEntries(
                Object.entries(this.#ref.source.files.files).map(([name, text]) => [
                  name,
                  `${text.length} bytes`,
                ]),
              ),
            },
          }
        : this.#ref.source;
    return describeNode({
      instructions:
        `A ${this.#ref.type} dynamic worker (described from its ref — the worker was NOT loaded). ` +
        'Dotted calls load it through the Worker Loader and invoke the entrypoint: `worker.someMethod(x)` is `invokeCapability({ path: ["someMethod"], args: [x] })`. ' +
        "`children` cannot be listed — the worker's methods are whatever its entrypoint exports. " +
        'To ask the worker to describe ITSELF (boots it; only works if its code implements `__describe`), call `invokeCapability({ path: ["__describe"] })`.',
      children: {
        invokeCapability: "Explicit dispatch into the worker: { path, args, flattenNestedPath? }.",
        kill: "Restart the stateful worker's server-side object; stateless worker refs reject.",
      },
      parent: `itx.workers of this project (itx scope path "${this.#ref.path}")`,
      ref: {
        ...(this.#ref.type === "stateless"
          ? { entrypoint: this.#ref.entrypoint, propKeys: Object.keys(this.#ref.props ?? {}) }
          : { className: this.#ref.className, durableWorkerKey: this.#ref.durableWorkerKey }),
        path: this.#ref.path,
        source,
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
    if (this.#ref.type !== "stateful") {
      throw new Error("Dynamic worker kill() only applies to stateful worker refs.");
    }
    await this.#runner.kill(this.#ref);
  }
}

type ProjectListEntryBase = Omit<ProjectListEntry, "deploymentStatus">;

/** Catalog of projects reachable from a {@link Session}. */
export class ProjectCollectionRpcTarget extends IterateRpcTarget<"ProjectCollection"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        'Project catalog: get("prj_...") and create({ slug }) vend a project itx; list() enriches with deployment status.',
      children: {
        create: "Create a project; returns its itx.",
        get: "The itx for a project id.",
        list: "The session's projects with deployment status.",
      },
      parent: "session.projects",
    });
  }

  constructor(readonly props: { auth: ItxAuth; config?: AppConfig; ctx: CfExecutionContext }) {
    super();
  }

  /** The itx at the project root for a `prj_…` id. */
  async get(projectId: string): Promise<ProjectRpcTarget> {
    // Guard the id shape: itx state is namespaced by whatever string lands
    // here, so an unvalidated slug (e.g. `cli itx run --context <slug>`) would
    // silently manufacture a phantom project namespace instead of failing.
    if (!projectId.startsWith("prj_")) {
      throw new Error(
        `"${projectId}" is not a project id (expected "prj_..."). Resolve slugs to ids first.`,
      );
    }
    // Claims can lag right after a create; the auth context may consult the
    // project directory and widen itself before the synchronous constructor
    // assert runs. Cap'n Web pipelines through the returned promise.
    await this.props.auth.ensureCanAccessProject?.(projectId);
    return itxForScope({
      auth: this.props.auth,
      ctx: this.props.ctx,
      path: "/",
      projectId: projectId,
    });
  }

  /**
   * Register and bootstrap a project. By default this resolves once the
   * bootstrap saga has committed `project/ready` — convenient for scripts
   * and tests that use the project immediately. Pass
   * `waitUntilReady: false` to resolve once the `project/created` birth
   * certificate has been processed
   * (identity registered, directory primed, bootstrap events appended): the
   * saga then runs behind the returned handle, and its progress is ordinary
   * live state (`itx.liveState` — `state.reduced.ready` flips when bootstrap
   * lands). The dashboard uses the fast path to redirect into the project
   * instantly and play creation progress from pushes.
   */
  async create(args: {
    organizationSlug?: string;
    projectId?: string;
    slug: string;
    waitUntilReady?: boolean;
  }): Promise<ProjectRpcTarget> {
    const registered = await timedStep("create-timing", { slug: args.slug }, "auth-register", () =>
      this.#registerProject(args),
    );
    const timing = { projectId: registered.projectId };
    args.projectId = registered.projectId;
    // The auth worker may normalize the slug (slugify); adopt its canonical
    // form so stream events agree with the directory and ingress hostnames.
    args.slug = registered.slug;
    // The creating session can use the project immediately; a signed-in user's
    // claims catch up on the next token refresh (directory fallback covers the
    // gap for other connections).
    widenProjectAccess(this.props.auth, registered.projectId);
    // Prime the slug->id directory cache so the post-create navigation (and
    // the first project-host request) never miss into the auth worker.
    await timedStep("create-timing", timing, "prime-directory", () =>
      primeProjectDirectory(env.PROJECT_DIRECTORY, {
        id: registered.projectId,
        slug: registered.slug,
        organizationId: registered.organizationId,
        name: registered.slug,
      }),
    );

    const stream = rootStream({
      auth: this.props.auth,
      projectId: args.projectId,
    });

    const creatorEmail = userPrincipalOf(this.props.auth)?.email;
    const appendRootEvents = () =>
      stream.append(
        {
          type: "events.iterate.com/project/created",
          idempotencyKey: `project-created:${registered.projectId}`,
          payload: {
            config: {
              onboardingActive: true,
              slug: registered.slug,
              ...(creatorEmail === undefined ? {} : { creatorEmail }),
            },
          },
        },
        buildDurableObjectProcessorSubscriptionConfiguredEvent({
          durableObjectName: streamDurableObjectName({
            projectId: registered.projectId,
            path: "/",
          }),
          processor: ["processor"],
          processorSlug: ProjectProcessorContract.slug,
        }),
      );
    const [created, subscription] = await timedStep(
      "create-timing",
      timing,
      "root-append",
      appendRootEvents,
    );
    const project = itxForScope({
      auth: this.props.auth,
      ctx: this.props.ctx,
      path: "/",
      projectId: args.projectId,
    });
    await timedStep("create-timing", timing, "wait-project-birth", () =>
      project.processor.waitUntilProcessed({
        offset: Math.max(created.offset, subscription.offset),
      }),
    );
    // The project now EXISTS and its birth has been processed. Whether to
    // also wait for bootstrap readiness is the caller's choice.
    if (args.waitUntilReady !== false) {
      await timedStep("create-timing", timing, "wait-project-ready", () =>
        stream.waitForEvent({
          afterOffset: created.offset,
          eventTypes: ["events.iterate.com/project/ready"],
          // Tight on purpose: the saga should complete in seconds (see
          // tasks/os-cold-create-latency.md for the cold-slot outliers that must
          // be fixed, not waited out). Preview CI warms slots before the suites.
          timeoutMs: 60_000,
        }),
      );
    }

    return project;
  }

  /**
   * Register the project with the auth worker before any itx state exists.
   *
   * The auth worker is the project directory and the id authority. The user
   * lane creates the org-owned directory row (which is what later puts the
   * project into the user's claims); the admin lane only needs an id. Admin
   * callers may bring their own id (test fixtures); we never mint prj_ ids
   * locally when the directory is configured.
   */
  async #registerProject(args: {
    organizationSlug?: string;
    projectId?: string;
    slug: string;
  }): Promise<{ organizationId: string | null; projectId: string; slug: string }> {
    const userPrincipal = userPrincipalOf(this.props.auth);

    if (userPrincipal && !this.props.auth.isAdmin()) {
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
      const created = result.project;
      return { organizationId: created.organizationId, projectId: created.id, slug: created.slug };
    }

    if (!this.props.auth.isAdmin()) {
      throw new Error(`principal "${this.props.auth.principal}" cannot create projects`);
    }
    if (args.projectId !== undefined) {
      return { organizationId: null, projectId: args.projectId, slug: args.slug };
    }
    const minted = await env.AUTH.mintProjectId();
    return { organizationId: null, projectId: minted.id, slug: args.slug };
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
 * this scope; reads chain up through enclosing scopes inside the Durable
 * Object. `itx.capabilityHost` is the current scope's host;
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

  /** Create this capability host and return only after it has processed its birth batch. */
  async create(): Promise<void> {
    const durableObjectName = DurableObjectNameCodec.stringify({
      path: this.#props.path,
      projectId: this.#props.projectId,
    });
    const committed = await this.#stream.append(
      {
        type: "events.iterate.com/capability-host/created",
        idempotencyKey: `capability-host/created:${this.#props.projectId}:${this.#props.path}`,
        payload: { config: {} },
      },
      buildDurableObjectProcessorSubscriptionConfiguredEvent({
        durableObjectName,
        idempotencyKey: `stream/subscription-configured:${durableObjectName}#${CapabilityHostProcessorContract.slug}`,
        processor: ["capabilityHosts", ["get", this.#props.path], "processor"],
        processorSlug: CapabilityHostProcessorContract.slug,
      }),
    );
    const offset = committed.reduce((maximum, event) => Math.max(maximum, event.offset), 0);
    if (offset === 0) throw new Error("capability host create committed no events");
    await this.processor.waitUntilProcessed({ offset });
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
      instructions: `The capability host at scope "${this.#props.path}": the durable dynamic-capability table and script journal for this scope. Mounting is local; reads chain up through enclosing scopes, so \`capabilities\` includes inherited mounts tagged with their declaring scope.`,
      children: {
        create:
          "Create this capability host and wait until its processor has processed the birth batch.",
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
/**
 * THE one table of project built-ins: member name -> one-line blip. The
 * `children` map in `__describe()` derives from it, so adding a built-in is
 * one entry here plus the getter on ProjectRpcTarget.
 */
const PROJECT_BUILTIN_BLIPS: Record<string, string> = {
  agents: "Agent catalog: get(path), list().",
  ai: "Workers AI: run(model, body), models(), toMarkdown({ name, blob }).",
  browser: "Cloudflare Browser Run: quickAction(action, options), fetch().",
  capabilityHost:
    "This scope's own capability host: provideCapability({ path, ... }) mounts a dynamic capability here (itx.provideCapability is a shortcut), revokeCapability removes one, __describe() lists everything reachable, runScript runs a script in this scope.",
  capabilityHosts:
    'Capability hosts of OTHER scopes, addressed by path: itx.capabilityHosts.get("/") is the project root — providing there makes a capability visible to every scope in the project.',
  debug: "Returns formatted OS debug info for this itx scope, including a dashboard stream link.",
  egress: "Project-attributed outbound fetch (+ intercept).",
  email:
    "First-party email: send({ to, subject, text, html, attachments? }) from the project's own address (<slug>@<hostname base>); explicit `from` must match it. Attachments: project files by path or inline base64. Email thread agents (/agents/email/t<id>) reply with email.reply({ text, attachments? }).",
  docs: 'Find working code + types (HOW — for project content/history see itx.search): search({ q: "many related words" }) over the example-script catalogue, type declarations, and mounted capabilities; get({ name }) fetches one.',
  files:
    "Project file storage: files.get(path) → put({ data, contentType }), bytes(), url() (signed public link), delete(). Agent scopes: prefer itx.agent.addFiles to store AND attach in one call.",
  integrations:
    'Integration connection families: get() selects the first connected account and get("<connection>") selects an exact one; e.g. itx.integrations.slack.get().chat.postMessage(...), gmail.get().request(...), github.get().octokit.rest.repos.get(...). list() enumerates all connections; other slugs resolve through the project capability table. Cloudflare first-party bindings live at itx.integrations.cf.{ai,browser,images,videos}.',
  kill: "Restart the project's server-side object; the next request boots it fresh.",
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
    "The project's sandboxes (pets): create({ name, instanceType }), get(path), list(); start/sleep/destroy live on the sandbox.",
  search:
    "Search the project's PAST — every conversation (chat/Slack/email/Telegram), webhook (GitHub/Slack), stream event, file, and repo file is indexed: query({ q }) returns scored chunks, each with a ref expression back to the exact source; answer({ q }) gives a cited answer. Search before paging streams with getEvents.",
  scheduler:
    'The default project Scheduler (= schedulers.get("/scheduler/primary")): set({ key, recurrence, script }) runs an itx script on a schedule; cancel(key), list(), trigger(key).',
  schedulers: "Scheduler catalog: get(path) for extra /scheduler/** instances.",
  secrets: "Secret catalog by path.",
  streams: "Project stream catalog: get(path), list().",
  worker: "The default repo-backed project worker.",
  workers: "Dynamic worker refs: get(ref).",
  workspaces:
    'Durable workspace filesystems by path: get("/") is the read-only root (always latest main of the project repo); get("/workspaces/<name>") is an instant private overlay over it (read/write/edit + git publish). An agent\'s own workspace is itx.workspace.',
};

type ProjectRpcTargetProps = {
  auth: ItxAuth;
  // This scope's own capability host. Its `path` decides which scope this itx
  // IS — `"/"` for the project root, `/agents/bla` for an agent context. It is
  // exposed as `itx.capabilityHost` and doubles as the fallback for dynamic
  // dotted-path calls (`itx.foo.bar(...)` → `capabilityHost.invokeCapability`).
  capabilityHost: CapabilityHostRpcTarget;
  ctx: CfExecutionContext;
  projectId: string;
};

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
 * host's dynamic table (which itself chains up to enclosing scopes). So the
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
  incrementLiveDemo(): Promise<void>;
  touchStreamActivity(input: TouchInput): Promise<void>;
  touchAgentStatus(input: AgentStatusTouchInput): Promise<void>;
  rebuildAgentStatus(input: AgentStatusTouchInput): Promise<boolean>;
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
  readonly #props: ProjectRpcTargetProps;

  constructor(props: ProjectRpcTargetProps) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
    this.#props = props;
  }

  /** The project this itx is scoped into. */
  get projectId(): string {
    return this.#props.projectId;
  }

  /** @internal */
  get durableObjectStub() {
    return env.PROJECT.getByName(
      DurableObjectNameCodec.stringify({ path: "/", projectId: this.#props.projectId }),
    );
  }

  /**
   * Identity + full capability inventory: `projectId`/`name`, every reachable
   * capability (built-ins + dynamic mounts), the children map, and the
   * `Project` declaration in `types` (the full surface is one
   * `itx.docs.get({ name })` per declaration away).
   */
  async __describe(): Promise<ProjectDescription> {
    const scopePath = this.#props.capabilityHost.path;
    const [project, hostDescription] = await Promise.all([
      this.durableObjectStub.describe(),
      this.#props.capabilityHost.__describe(),
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
      readProjectById(env.PROJECT_DIRECTORY, this.#props.projectId).catch(() => null),
      Promise.resolve(parseConfig(env)),
    ]);
    const streamPath = this.#props.capabilityHost.path;
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
      `Project: \`${project?.slug ?? this.#props.projectId}\``,
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

  /** Workers AI: run(model, body), models(). */
  get ai(): AiRpcTarget {
    return new AiRpcTarget();
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
    const path = this.#props.capabilityHost.path;
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
    return this.#props.capabilityHost;
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
      projectId: this.#props.projectId,
    });
  }

  /** Shortcut for `capabilityHost.provideCapability` (mounts on THIS scope). */
  provideCapability(input: ProvideCapabilityInput): Promise<CapabilityProvisionRpcTarget> {
    return this.#props.capabilityHost.provideCapability(input);
  }

  /** Shortcut for `capabilityHost.revokeCapability`. */
  revokeCapability(input: RevokeCapabilityInput): Promise<void> {
    return this.#props.capabilityHost.revokeCapability(input);
  }

  /** Project stream catalog: get(path), list(). */
  get streams(): ProjectStreamCollectionRpcTarget {
    return new ProjectStreamCollectionRpcTarget({
      auth: this.#props.auth,
      projectId: this.#props.projectId,
    });
  }

  /** Agent catalog: get(path), list(). */
  get agents(): AgentCollectionRpcTarget {
    return new AgentCollectionRpcTarget({
      auth: this.#props.auth,
      ctx: this.#props.ctx,
      projectId: this.#props.projectId,
      // The "current actor": this itx's own scope path. Relative agent paths
      // resolve against it, and message() stamps it as the sender when the
      // scope is an agent — how delegated reports know who they are from.
      sourceScopePath: this.#props.capabilityHost.path,
    });
  }

  /** Project-attributed outbound fetch (+ intercept). */
  get egress(): ProjectEgressRpcTarget {
    return new ProjectEgressRpcTarget({ projectId: this.#props.projectId });
  }

  /** Project email: send(...) and the connection-scoped inbound address. */
  get email(): EmailCapabilityRpcTarget {
    return new EmailCapabilityRpcTarget({
      auth: this.#props.auth,
      projectId: this.#props.projectId,
      // The scope path makes email.reply thread-aware inside email agent
      // scopes; everywhere else reply throws with a pointer to send.
      scopePath: this.#props.capabilityHost.path,
    });
  }

  /** The docs door: `search({ q })` finds e2e-tested example scripts, type
   * declarations, and this scope's mounted capabilities; `get({ name })`
   * fetches one. Pass search MANY related words — matching is dumb word
   * overlap. For project CONTENT and history, see itx.search. */
  get docs(): ItxDocsRpcTarget {
    return new ItxDocsRpcTarget({ capabilityHost: this.#props.capabilityHost });
  }

  /** Project file storage (R2-backed): `files.get(path)` → put/bytes/url/delete. */
  get files(): FilesRpcTarget {
    return new FilesRpcTarget({
      auth: this.#props.auth,
      projectId: this.#props.projectId,
    });
  }

  /** The integrations collection: built-in connection families selected with
   * `.get()` (first connected) or `.get("slug")` (exact), provided
   * integrations through the capability table, management verbs, `list()`. */
  get integrations(): ProjectIntegrationsRpcTarget {
    return new ProjectIntegrationsRpcTarget({
      auth: this.#props.auth,
      ctx: this.#props.ctx,
      projectId: this.#props.projectId,
    });
  }

  /** Ad-hoc MCP clients: connect(url); `itx.mcp.exa` is the built-in Exa web search. */
  get mcp(): McpClientCollectionRpcTarget {
    return new McpClientCollectionRpcTarget({
      egress: projectEgressFetcher(this.#props.ctx.exports, this.#props.projectId),
      projectId: this.#props.projectId,
      // Makes beginOAuth links notify the calling agent when the flow completes.
      scopePath: this.#props.capabilityHost.path,
    });
  }

  /** Ad-hoc OpenAPI clients: connect(spec). */
  get openapi(): OpenApiCollectionRpcTarget {
    return new OpenApiCollectionRpcTarget({
      egress: projectEgressFetcher(this.#props.ctx.exports, this.#props.projectId),
    });
  }

  /** Parallel API, preconfigured with Iterate's platform API key. */
  get parallel(): OpenApiRpc {
    return parallelOpenApiTarget({
      egress: projectEgressFetcher(this.#props.ctx.exports, this.#props.projectId),
      parent: "a project itx (itx.parallel)",
    });
  }

  /** Repo catalog by path. */
  get repos(): ProjectRepoCollectionRpcTarget {
    return new ProjectRepoCollectionRpcTarget({
      auth: this.#props.auth,
      projectId: this.#props.projectId,
    });
  }

  /** The project's sandboxes — explicitly created, sized Linux containers
   * (`itx.sandboxes.create` / `get` / `list`) — see {@link SandboxCollection}. */
  get sandboxes(): SandboxCollectionRpcTarget {
    return new SandboxCollectionRpcTarget({
      auth: this.#props.auth,
      projectId: this.#props.projectId,
    });
  }

  /** Search over everything this project accumulates — streams, files, repos, docs (Cloudflare AI Search). */
  get search(): SearchRpcTarget {
    return new SearchRpcTarget({
      auth: this.#props.auth,
      projectId: this.#props.projectId,
      capabilityHost: this.#props.capabilityHost,
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
      projectId: this.#props.projectId,
    });
  }

  /** Secret catalog by path. */
  get secrets(): SecretCollectionRpcTarget {
    return new SecretCollectionRpcTarget({
      auth: this.#props.auth,
      projectId: this.#props.projectId,
      // The scope path makes collectFromUser's links notify the calling
      // agent when the user submits; non-agent scopes mint plain links.
      scopePath: this.#props.capabilityHost.path,
    });
  }

  /** The project's config repo at /repos/config — shorthand for `repos.get("/repos/config")`. */
  get repo(): RepoRpcTarget {
    return new RepoRpcTarget({
      auth: this.#props.auth,
      path: CONFIG_REPO_PATH,
      projectId: this.#props.projectId,
    });
  }

  /** Dynamic worker refs: get(ref). */
  get workers(): DynamicWorkerCollectionRpcTarget {
    return new DynamicWorkerCollectionRpcTarget({
      auth: this.#props.auth,
      ctx: this.#props.ctx,
      projectId: this.#props.projectId,
    });
  }

  /** Path-addressed durable workspaces (`itx.workspaces.get(path)`). */
  get workspaces(): WorkspaceCollectionRpcTarget {
    return new WorkspaceCollectionRpcTarget({
      auth: this.#props.auth,
      projectId: this.#props.projectId,
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
  // per-event work (the streams index via #indexStreamActivity; future
  // policy/metrics feeds) joins the same ordered, checkpointed delivery.
  // Rule for such steps: idempotent and never-throwing; only the worker
  // delegation may reject into the spine's retry/park machinery. Same trust
  // model as worker.processEventBatch itself: any project principal.
  async processEventBatch(batch: StreamPushEventBatch): Promise<void> {
    this.#indexStreamActivity(batch);
    this.#indexAgentStatus(batch);
    this.#indexStreamSearch(batch);
    try {
      return await this.worker.processEventBatch(batch);
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

  /**
   * Platform step: record the batch's stream in the project's streams index (a
   * peer slice of `itx.liveState` — see StreamDatabase). Idempotent (`touch`
   * only advances recency) and MUST NOT throw — a fire-and-forget dial into the
   * project DO whose failure the next batch self-heals. Only the worker
   * delegation above may reject into the spine's retry.
   */
  #indexStreamActivity(batch: StreamPushEventBatch): void {
    const last = batch.events.at(-1);
    if (last === undefined) return;
    void Promise.resolve(
      this.#projectDo.touchStreamActivity({
        path: batch.path,
        at: last.createdAt,
        type: last.type,
        // streamMaxOffset (not events.length) so a redelivered batch is idempotent.
        maxOffset: batch.streamMaxOffset,
      }),
    ).catch(() => {
      // Recency self-heals from the next batch; never surface into worker delivery.
    });
  }

  /**
   * Platform step: fold an agent batch's status-changed patches into the
   * project's agents roster (a peer slice of `itx.liveState` — see
   * AgentStatusDatabase). Same rules as {@link #indexStreamActivity}:
   * idempotent (event offsets guard redelivery), fire-and-forget, MUST NOT
   * throw. Unlike recency, a DROPPED patch does not heal on the next one —
   * these are merge patches, and a later busy patch carries no title with
   * which to reconstruct a lost rename — so a failed dial falls back to
   * rebuilding the row from the agent's journal (the authority).
   */
  #indexAgentStatus(batch: StreamPushEventBatch): void {
    if (!batch.path.startsWith("/agents/")) return;
    const events = batch.events
      .filter((event) => event.type === "events.iterate.com/agent/status-changed")
      .map((event) => ({
        payload: event.payload,
        offset: event.offset,
        createdAt: event.createdAt,
      }));
    if (events.length === 0) return;
    void Promise.resolve(this.#projectDo.touchAgentStatus({ path: batch.path, events })).catch(() =>
      this.#rebuildAgentStatus(batch.path),
    );
  }

  /**
   * Recovery lane for a failed roster dial: re-read the agent journal's FULL
   * status-changed history and hand it to the DO as a from-scratch rebuild.
   * The journal read is authoritative at read time; a touch for NEWER events
   * racing into the gap between read and replace makes the DO REFUSE the
   * stale snapshot, and the loop re-reads (the newer events are committed to
   * the journal before their touch could have succeeded, so the next read
   * has them). Retried with backoff; the terminal failure is logged and the
   * row stays stale until the agent's next rebuild-triggering drop.
   */
  async #rebuildAgentStatus(path: string): Promise<void> {
    for (const backoffMs of [0, 2_000, 10_000]) {
      if (backoffMs > 0) await new Promise((resolve) => setTimeout(resolve, backoffMs));
      try {
        const stream = new StreamRpcTarget({
          auth: this.#props.auth,
          path,
          projectId: this.projectId,
        });
        const events: { payload: unknown; offset: number; createdAt: string }[] = [];
        let afterOffset = 0;
        for (;;) {
          const page = await stream.getEvents({
            afterOffset,
            eventTypes: ["events.iterate.com/agent/status-changed"],
            limit: 500,
          });
          for (const event of page) {
            events.push({
              payload: event.payload,
              offset: event.offset,
              createdAt: event.createdAt,
            });
          }
          if (page.length < 500) break;
          afterOffset = page.at(-1)!.offset;
        }
        const applied = await this.#projectDo.rebuildAgentStatus({ path, events });
        if (applied) return;
        console.warn("[agents-roster] rebuild lost a race with a newer touch; re-reading", {
          path,
        });
      } catch (error) {
        console.warn("[agents-roster] rebuild attempt failed", { path, error });
      }
    }
    console.error("[agents-roster] roster row is stale after failed rebuild", { path });
  }

  /**
   * SPIKE platform step: mirror the batch's stream events into the itx.search
   * corpus (domains/search/search-index.ts) as fixed 100-offset segment
   * documents. Same rules as {@link #indexStreamActivity}: idempotent
   * (segment docs are deterministic rewrites), fire-and-forget, MUST NOT throw
   * — only the worker delegation may reject into the spine's retry. It rides
   * the same ordered, checkpointed delivery, re-reading each touched segment's
   * full range from the stream so a transient failure self-heals on the next
   * batch in that segment (see indexStreamEventBatch).
   */
  #indexStreamSearch(batch: StreamPushEventBatch): void {
    if (batch.projectId === null) return;
    const streamStub = env.STREAM.getByName(
      DurableObjectNameCodec.stringify(
        { projectId: batch.projectId, path: batch.path },
        { allowNullProjectId: true },
      ),
    );
    // waitUntil, not bare fire-and-forget: the segment re-read + R2 puts are a
    // multi-hop pipeline that outlives this RPC's resolve, and an unanchored
    // promise can be cancelled when the invocation's I/O context ends.
    const projectId = batch.projectId;
    this.#props.ctx.waitUntil(
      indexStreamEventBatch({
        batch,
        readEvents: (args) => streamStub.getEvents(args),
      })
        // Freshness: nudge the project's instance (if one exists) so passive
        // content is searchable in minutes, not on the hourly schedule.
        .then(() => triggerProjectSearchSyncDebounced(projectId))
        .catch((error: unknown) => {
          console.warn("search index stream batch failed", { path: batch.path, error });
        }),
    );
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
      projectId: this.#props.projectId,
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
 * stream's delivery dial evaluates expressions against (`ItxEntrypoint.get()`
 * with `projectId: null` props). Session-shaped on purpose — deployment-wide
 * repos/streams live on the session — so a global repo stream's wake
 * expression (`["repos", ["get", path], "processor", "wakeStreamSubscriber"]`)
 * walks the same shape a project stream's does.
 */
export function deploymentItxForTrustedInternal(props: { ctx: CfExecutionContext }) {
  return new SessionRpcTarget({ auth: trustedInternalAuthContext(), ctx: props.ctx });
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
        streamRecovery: "Admin-only exact-offset Stream Durable Object recovery.",
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

  /** Admin-only exact-offset Stream Durable Object recovery. */
  get streamRecovery(): StreamRecoveryCollectionRpcTarget {
    return new StreamRecoveryCollectionRpcTarget({ auth: this.props.auth });
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
    });
    return new SessionRpcTarget({ auth, config: this.props.config, ctx: this.props.ctx });
  }
}

// ---------------------------------------------------------------------------
// Every RpcTarget class lives in this module (design rule): ownership handles,
// built-in capability targets, and read-only facades included. Durable Object
// and entrypoint classes stay in their domain folders.
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
        "Project-attributed outbound fetch: fetch(request) egresses with the project's identity and secret substitution; intercept(handler) installs a live egress interceptor (last writer wins).",
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

  /** Outbound fetch with the project's identity and secret substitution. */
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
    await this.#catchUpBeforeSnapshot?.();
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
 * capabilities mounted in the caller's scope chain. One door for "how do I
 * X?": search first, fetch what the hits name, adapt working code.
 *
 * The search mechanism is deliberately dumb (word matching, no embeddings),
 * which is why every docstring here tells callers to pass MANY related words
 * — recall comes from the query, not the engine. (For semantic search over
 * the project's own content and history, see itx.search.)
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
        "Two searches, one rule: THIS door finds HOW (code, types, capabilities); itx.search.query finds WHAT (the project's own content and history). " +
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
   * the ready-made docs.get call that fetches its full doc. (For the
   * project's own content and history, see itx.search.)
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
class ProcessorRelayRpcTarget<State>
  extends IterateRpcRelay<"StreamProcessorRpc">
  implements WakeableStreamProcessorRpc<State>
{
  readonly #auth: ItxAuth;
  readonly #host: () => ProcessorHostStub;

  constructor(args: { auth: ItxAuth; host: () => ProcessorHostStub }) {
    super();
    this.#auth = args.auth;
    this.#host = args.host;
  }

  async #processor(): Promise<StreamProcessorRpc<State>> {
    return (await this.#host().processor) as StreamProcessorRpc<State>;
  }

  async snapshot() {
    return await (await this.#processor()).snapshot();
  }

  async getRuntimeState() {
    return await (await this.#processor()).getRuntimeState();
  }

  async waitUntilProcessed(input: { offset: number; timeoutMs?: number }) {
    return await (await this.#processor()).waitUntilProcessed(input);
  }

  /** The host's wake-mode delivery handshake (see {@link WakeableStreamProcessorRpc}). */
  wakeStreamSubscriber(
    request: StreamSubscriberWakeRequest,
  ): Promise<StreamSubscriberWakeResponse> {
    if (this.#auth.principal !== "trusted-internal") {
      throw new Error("wakeStreamSubscriber is dialed by stream delivery spines, not sessions");
    }
    return this.#host().wakeStreamSubscriber(request);
  }
}

/**
 * DO-side RpcTarget over a registry's live-state engine — the surface a
 * `.liveState` node exposes: `get()`/`subscribe()` — read-only over the wire
 * (see LiveStateRpc: the DO derives this state from its fold, so writes go
 * through the node's own verbs). `get`/`subscribe` first seed the engine from
 * committed state so the first paint is never stale after a DO restart.
 */
export class LiveStateRpcTarget<State extends object = Record<string, unknown>>
  extends IterateRpcRelay<"LiveStateRpc">
  implements LiveStateRpc<State>
{
  readonly #host: Pick<StreamProcessorRegistry<State>, "live" | "loadAndRefreshLive">;

  constructor(host: Pick<StreamProcessorRegistry<State>, "live" | "loadAndRefreshLive">) {
    super();
    this.#host = host;
  }

  async get(): Promise<State> {
    await this.#host.loadAndRefreshLive();
    return this.#host.live.getState();
  }

  async subscribe(
    onUpdate: (update: LiveUpdate<State>) => unknown,
  ): Promise<LiveStateSubscriptionHandle> {
    await this.#host.loadAndRefreshLive();
    const handle = this.#host.live.subscribe(onUpdate);
    return new LiveStateSubscriptionRpcTarget(handle);
  }
}

/** RPC ownership handle for one live-state subscription — the `.liveState` twin of {@link StreamSubscriptionRpcTarget}. */
class LiveStateSubscriptionRpcTarget extends IterateRpcRelay<"LiveStateSubscriptionHandle"> {
  readonly #handle: LiveStateSubscription;

  constructor(handle: LiveStateSubscription) {
    super();
    this.#handle = handle;
  }

  ping() {
    return this.#handle.ping();
  }

  unsubscribe() {
    this.#handle.unsubscribe();
  }

  [Symbol.dispose](): void {
    this.#handle.unsubscribe();
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
  readonly #stub: () => LiveStateDurableObjectStub<State>;

  constructor(stub: () => LiveStateDurableObjectStub<State>) {
    super();
    this.#stub = stub;
  }

  async get(): Promise<State> {
    return await (await this.#stub().liveState).get();
  }

  async subscribe(
    onUpdate: (update: LiveUpdate<State>) => unknown,
  ): Promise<LiveStateSubscriptionHandle> {
    return await (await this.#stub().liveState).subscribe(onUpdate);
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
    const inner = engine.subscribe(onUpdate);
    // The engine drops a subscriber itself when a delivery rejects (dead
    // client), and it exposes no drop hook to the owner — so a driving loop
    // like this one must check `ping()` and stop itself, or the timer outlives
    // the subscription. This IS the template for the poll-an-API pattern.
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
    return new LiveStateSubscriptionRpcTarget({
      ping: () => inner.ping(),
      unsubscribe: stop,
      [Symbol.dispose]: stop,
    });
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
   * `itx.mcp.connect({ url, headers: { authorization: 'Bearer getSecret({ path:
   * "<path>", field: "accessToken" })' } })`. For a server that just wants a
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
  // Headers can contain getSecret({ path: "/secrets/..." }) placeholders.
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
// `agents.get(path)`: an agent scope's mounted tools directly on the handle —
// `itx.agents.get(path).someTool(args)` — dispatched via the agent's own
// capability host (the explicit `agent.capabilityHost.someTool(...)` spelling
// resolves identically). #1839 removed the instance Proxy to make handles
// pipelinable; the hop restores the sugar without giving that back.
installPrototypeInvokeCapabilityFallback(AgentRpcTarget, {
  invokerFor: (agent) => agent.capabilityHost,
});

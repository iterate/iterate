/**
 * The public ITX capability surface.
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
 * - an ITX is a capability context scoped into one project at one path. It is
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
import { createAuthWorkerServiceClient } from "./auth/auth-worker-service.ts";
import { parseConfig } from "./config.ts";
import {
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
} from "./project-directory.ts";
import { deploymentStatusesFromProbes } from "./project-deployment-status.ts";
import { timedStep } from "./lib/step-timing.ts";
import { buildProjectStreamViewerUrl } from "./lib/stream-viewer-url.ts";
import type { Env } from "./env.ts";
import { DurableObjectNameCodec, normalizePath } from "./domains/durable-object-names.ts";
import { normalizeAgentPath } from "./domains/agents/utils.ts";
import {
  describeNode,
  rejectBuiltinCollision,
  withInvokeCapabilityFallback,
} from "./domains/itx/utils.ts";
import { ITX_TYPES_SOURCE } from "./types-source.generated.ts";
import { projectStub } from "./domains/projects/egress.ts";
import { ProjectProcessorContract } from "./domains/projects/project-processor-contract.ts";
import { projectEgressFetcher } from "./domains/projects/utils.ts";
import { RepoProcessorContract } from "./domains/repos/repo-processor-contract.ts";
import {
  PROJECT_REPO_PATH,
  PROJECT_WORKER_ENTRY_POINT,
  PROJECT_WORKER_SOURCE_EXCLUDE,
} from "./domains/repos/utils.ts";
import { linkRepoToGithub, unlinkRepoFromGithub } from "./domains/repos/github-link.ts";
import { normalizeSandboxPath } from "./domains/sandboxes/utils.ts";
import { normalizeWorkspacePath, workspaceBranchName } from "./domains/workspaces/utils.ts";
import { canonicalRecurrence } from "./domains/scheduler/recurrence.ts";
import { normalizeSchedulerPath, SCHEDULER_PRIMARY_PATH } from "./domains/scheduler/utils.ts";
import { normalizeSecretPath } from "./domains/secrets/utils.ts";
import {
  completeConnect,
  disconnectProvider,
  getConnectionStatus,
  listIntegrationConnections,
  startOAuthFlow,
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
import { DynamicWorkerRef as WorkerRefSchema } from "./domains/workers/schemas.ts";
import type {
  DynamicWorkerCapability,
  DynamicWorkerDispatchOptions,
  DynamicWorkerRef,
  ProjectWorker,
  StatelessDynamicWorkerRef,
} from "./domains/workers/schemas.ts";
import type { StreamEvent, StreamEventInput, StreamListItem } from "./domains/streams/schemas.ts";
import {
  isObjectSchema,
  listOpenApiOperations,
  operationBodySchema,
  type OpenApiOperation,
} from "./domains/itx/openapi-types.ts";
import { callMcpToolPath, listMcpTools } from "./domains/itx/mcp-client.ts";
import { ITX_EXAMPLES, type ItxExample } from "./itx/examples.ts";
import type { ProcessorState } from "./domains/streams/processor-contracts.ts";
import type {
  StreamProcessor,
  StreamProcessorContract,
  StreamProcessorStateSubscriptionHandle,
} from "./domains/streams/stream-processor.ts";
import type {
  CapabilityDescription,
  Description,
  ProjectDescription,
} from "./domains/itx/describe.ts";
import type { CfExecutionContext } from "./domains/itx/utils.ts";
import type { CloudflareSandbox } from "./domains/sandboxes/utils.ts";
import type {
  CommitRepoFilesInput,
  CommitRepoFilesResult,
  EditRepoFileInput,
  EditRepoFileResult,
  GithubSyncResult,
  LinkGithubResult,
} from "./domains/repos/types.ts";
import type {
  BuiltinIntegrationSlug,
  CompleteConnectResult,
  GmailRequestInput,
  IntegrationConnectionStatus,
  IntegrationConnectionListEntry,
} from "./domains/integrations/types.ts";
import type { EmailAttachmentInput } from "./domains/email/utils.ts";
import type { FileData } from "./domains/files/file-url-signing.ts";
import type { ProjectFileMetadata } from "./domains/files/project-files.ts";
import type { AgentFileAttachment } from "./domains/agents/agent-processor-contract.ts";
import type { ScheduleView, SetScheduleInput } from "./domains/scheduler/types.ts";
import type {
  CfBrowserQuickAction,
  CfBrowserQuickActionOptions,
  CfImageTransformInput,
  CfMarkdownConversionArgs,
  CfMarkdownConversionResult,
  CfMarkdownSupportedFormat,
  CfVideoTransformInput,
} from "./domains/itx/cf-capabilities.ts";
import type { ItxAuth, ItxAuthCredentials } from "./auth.ts";
import type { ItxExampleSummary, ItxExampleWithCode } from "./itx/examples.ts";
import type { McpClientConnectInput, McpClientRpc } from "./domains/itx/mcp-client.ts";
import type { OpenApiConnectInput, OpenApiRpc } from "./domains/itx/openapi-types.ts";
import type { ProjectListEntry } from "./project-deployment-status.ts";
import type {
  ProjectEgressIntercept,
  ProjectEgressInterceptor,
} from "./domains/projects/egress.ts";
import type {
  ProvideCapabilityInput,
  RevokeCapabilityInput,
} from "./domains/capability-host/types.ts";
import type { SecretDescription, SecretUpdateInput } from "./domains/secrets/types.ts";
import type {
  ProcessEventBatch,
  ProcessorRuntimeState,
  ProcessorSnapshot,
  StreamEventReadInput,
  StreamProcessorRpc,
  StreamSubscriptionHandle,
} from "./domains/streams/rpc-types.ts";
import type { AgentProcessorState } from "./domains/agents/agent-processor-contract.ts";
import type { ProjectProcessorState } from "./domains/projects/project-processor-contract.ts";
import type { RepoProcessorState } from "./domains/repos/repo-processor-contract.ts";
import type {
  EditWorkspaceFileInput,
  EditWorkspaceFileResult,
  WorkspaceFileInfo,
  WorkspaceGitLogEntry,
  WorkspaceGitStatusEntry,
} from "./domains/workspaces/types.ts";
import { DynamicWorkerRunner } from "./domains/workers/worker-runner.ts";
import { integrationStreamStub } from "./domains/integrations/integration-streams.ts";
import {
  buildProjectEmailMessage,
  decodeBase64Attachment,
  emailAddressForProject,
  emailCounterpart,
  emailDomainForDeployment,
  emailThreadIdFromAgentPath,
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
import { EmailProcessorContract } from "./domains/email/email-processor-contract.ts";
import { EmailAgentProcessorContract } from "./domains/email/email-agent-processor-contract.ts";

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
      instructions: `A durable event stream at path "${this.props.path}": append(events), readEvents(), getEvents(), waitForEvent(), subscribe(). Streams are the coordination primitive — processors and agents communicate by appending and reducing events.`,
      children: {
        append: "Commit events; returns them with offsets.",
        at: "The stream at a sub-path.",
        getEvent: "One event by offset or idempotencyKey.",
        getEvents: "Read one bounded page of events.",
        readEvents: "Create a pager for bounded event pages.",
        subscribe: "Live event delivery; returns an unsubscribe handle.",
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

  /** One event by offset or idempotencyKey; undefined when it does not exist. */
  getEvent(
    args: { offset: number; idempotencyKey?: never } | { idempotencyKey: string; offset?: never },
  ): Promise<StreamEvent | undefined> {
    return this.durableObjectStub.getEvent(args);
  }

  /** Read one bounded page of committed events (optionally filtered by type). */
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

  /** Live debug view of the stream Durable Object: core processor state and open connections. */
  runtimeState(): Promise<{
    coreProcessorState: unknown;
    runtime: {
      connections: Record<string, unknown>;
    };
  }> {
    return this.durableObjectStub.runtimeState();
  }

  /**
   * Live event delivery: `processEventBatch` is called for every committed
   * batch (optionally replayed from `replayAfterOffset`); returns an
   * unsubscribe handle. Set `configured: true` only from trusted-internal
   * auth — it opens the durable configured subscription registered under
   * `subscriptionKey` (the wake-handshake response) instead of an ephemeral one.
   */
  subscribe(args: {
    subscriptionKey?: string;
    configured?: boolean;
    processEventBatch: ProcessEventBatch;
    replayAfterOffset?: number;
    eventTypes?: readonly string[];
    events?: boolean;
    subscriber?: unknown;
  }): Promise<StreamSubscriptionHandle> {
    // `configured: true` opens the durable configured subscription for the
    // given key (the wake-handshake response) — only the platform's own
    // Durable Objects may do that; everyone else gets ephemeral subscriptions.
    if (args.configured === true && this.props.auth.principal !== "trusted-internal") {
      throw new Error("configured subscriptions require trusted internal auth");
    }
    return this.durableObjectStub.subscribe(args);
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
        list: "Every Schedule, reduced from the stream.",
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
  const [, createRequested] = await timedStep("create-timing", timing, "repo-append", () =>
    stream.append(
      buildDurableObjectProcessorSubscriptionConfiguredEvent({
        durableObjectName: streamDurableObjectName({ projectId: input.projectId, path }),
        processorSlug: RepoProcessorContract.slug,
        subscriberType: "repo",
      }),
      {
        type: "events.iterate.com/repo/create-requested",
        idempotencyKey: `repo-create-requested:${input.projectId}:${path}`,
        payload: { projectId: input.projectId, path },
      },
    ),
  );

  await timedStep("create-timing", timing, "wait-repo-created", () =>
    stream.waitForEvent({
      afterOffset: createRequested.offset - 1,
      eventTypes: ["events.iterate.com/repo/created"],
      predicate: (event) =>
        event.payload?.projectId === input.projectId && event.payload?.path === path,
      // Tight on purpose: creates should be fast (see tasks/os-cold-create-latency.md
      // for the cold-slot outliers). Preview CI warms slots before the suites.
      timeoutMs: 60_000,
    }),
  );

  return new RepoRpcTarget({ auth: input.auth, path, projectId: input.projectId });
}

/** Git-backed repo capability used by project workers and dynamic worker refs. */
class RepoRpcTarget extends IterateRpcTarget<"Repo"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions: `A git repo (over Cloudflare Artifacts) at path "${this.props.path}": readFile/listFiles/commitFiles/edit, plus create() for first use. For coding-agent file changes that do not need a sandbox, readFile then edit is the default targeted workflow; use commitFiles for new files or batch/full-file writes. Optionally GitHub-backed: linkGithub({ connection, owner, repo }) mirrors every commit to a real GitHub repository (created private if missing) and cross-posts GitHub webhooks about it onto this repo's stream; the repo processor state shows the link and last push outcome.`,
      children: {
        commitFiles: "Commit a batch of file changes ({ message, changes }).",
        create: "Create the repo if it does not exist yet.",
        edit: "Replace an exact string in one file and commit it; oldString must match once unless replaceAll is true.",
        linkGithub:
          "Back this repo with a GitHub repository via a named GitHub connection ({ connection, owner, repo }); commits mirror out, webhooks cross-post in.",
        listFiles: "List file paths.",
        pushToGithub:
          "Push the branch head to the linked GitHub repository now (repair verb; { force } to overwrite GitHub).",
        readFile: "Read one file ({ path }).",
        syncFromGithub:
          "Adopt GitHub's branch head (fast-forward only; { force } discards local-only commits).",
        unlinkGithub: "Remove the GitHub link and its webhook cross-post rule.",
        whoami: "Repo identity string (debug).",
      },
      parent: "repos.get(path); the project repo is itx.repo",
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

  /** Create the repo if it does not exist yet; resolves once `repo/created` lands. */
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

  /** Committed file contents at HEAD; null when the path does not exist. */
  readFile(input: { path: string }): Promise<{
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
   * the next commit), and every GitHub webhook about that repository is
   * cross-posted onto this repo's stream. If the GitHub repository does not
   * exist and the installation can create org repositories, it is created
   * private. Re-linking replaces the previous link.
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
   */
  syncFromGithub(input: { force?: boolean } = {}): Promise<GithubSyncResult> {
    return this.#durableObjectStub.syncFromGithub(input);
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
  get processor(): StreamProcessorRpc<RepoProcessorState> {
    return new ProcessorRelayRpcTarget<RepoProcessorState>(() => this.#durableObjectStub.processor);
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

  /** Create the repo at a path; resolves once `repo/created` lands. */
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
        'Agent catalog: get("/agents/<name>") returns the agent control surface; list() the known agent streams.',
      children: { get: "One agent by path.", list: "Known agents (from project state)." },
      parent: "a project itx (itx.agents)",
    });
  }

  constructor(readonly props: { auth: ItxAuth; ctx: CfExecutionContext; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  /** The agent control surface at a path (`"/agents/<name>"`). */
  get(path: string): AgentRpcTarget {
    return new AgentRpcTarget({
      auth: this.props.auth,
      capabilityHost: new CapabilityHostRpcTarget({
        auth: this.props.auth,
        ctx: this.props.ctx,
        path: normalizeAgentPath(path),
        projectId: this.props.projectId,
      }),
      ctx: this.props.ctx,
      projectId: this.props.projectId,
    });
  }

  /** Known agents, read from the project processor's reduced state. */
  list(): Promise<StreamListItem[]> {
    return projectProcessorState(this.props.projectId).then((state) => state.agents);
  }
}

/**
 * The `itx.sandboxes` built-in. `get(path)` returns the sandbox Durable
 * Object's own RPC stub — deliberately NO RpcTarget wrapper, so the caller
 * sees exactly what the `@cloudflare/sandbox` SDK exposes and new SDK methods
 * need no forwarding code here. Confinement is by name: the stub is minted
 * from this project's id plus the validated path, after the same
 * project-access assert every collection performs. Every sandbox lives under
 * `/sandboxes/` (the same domain-prefix convention as `/secrets/...` and
 * `/repos/...`): an agent's sandbox is its agent path under the prefix
 * (`itx.sandbox` on `/agents/bla` is `sandboxes.get("/sandboxes/cloudflare/agents/bla")`);
 * standalone sandboxes conventionally live under `/sandboxes/cloudflare/...`.
 */
class SandboxCollectionRpcTarget extends IterateRpcTarget<"SandboxCollection"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        "Path-addressed Cloudflare sandboxes: get(path) returns a container-backed sandbox stub (exec, git, files). Paths live under /sandboxes/ — an agent's sandbox is its agent path under the prefix (/sandboxes/cloudflare/agents/..., what itx.sandbox resolves to); pick /sandboxes/cloudflare/<name> for standalone ones.",
      children: { get: "The sandbox at a path (boots the container on first use)." },
      parent: "a project itx (itx.sandboxes)",
    });
  }

  constructor(readonly props: { auth: ItxAuth; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  /** The sandbox at a path. Cheap — the container boots on the first command, not here. */
  async get(path: string): Promise<CloudflareSandbox> {
    const normalized = normalizeSandboxPath(path);
    const stub = env.SANDBOX.getByName(
      DurableObjectNameCodec.stringify({
        projectId: this.props.projectId,
        path: normalized,
      }),
    );
    // Container runtimes do not reliably surface `ctx.id.name`, so the
    // sandbox learns who it is here, before the stub reaches the caller —
    // see CloudflareSandboxDurableObject.ensureIdentity.
    await stub.ensureIdentity({ path: normalized, projectId: this.props.projectId });
    return stub;
  }
}

/**
 * Catalog of durable workspaces within one project.
 *
 * A workspace is addressed by its FULL path, which always lives under
 * `/workspaces/` — the same domain-prefix convention as `/sandboxes/...` and
 * `/repos/...`: an agent's workspace is the agent path under the prefix
 * (`/workspaces/agents/...`, exposed as `itx.workspace` in that agent's
 * scope), and standalone workspaces live under `/workspaces/<anything>`.
 * Getting a workspace is cheap; the first call on it clones the project repo.
 */
class WorkspaceCollectionRpcTarget extends IterateRpcTarget<"WorkspaceCollection"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        "Durable workspace filesystems: get(path) returns a Durable-Object-hosted private checkout of the project repo (no container, always warm). Paths live under /workspaces/ — an agent's own workspace is its agent path under the prefix (what itx.workspace resolves to); pick /workspaces/<name> for standalone ones.",
      children: { get: "The workspace at a path (clones the project repo on first use)." },
      parent: "a project itx (itx.workspaces)",
    });
  }

  constructor(readonly props: { auth: ItxAuth; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  /** The workspace at a path (clones the project repo on first use). */
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
 * Object (no container, always warm), seeded on first use with a checkout of
 * the project repo at `/` — every call waits for that clone, so a read that
 * returns proves the checkout exists. Read, write, and edit files freely;
 * nothing is shared until pushed. `git` publishes commits to the workspace's
 * own branch in the project repo (`workspaces/<path>`), never to main.
 *
 * Constraints: individual files are capped at ~1.5MB (store large blobs with
 * `itx.files`), and the `.git` directory is platform-managed — read it if you
 * like, but writes there are rejected (use the `git` methods). Workspace
 * branches are for durability and handoff, not worker builds: point worker
 * refs at branches maintained through `itx.repo`, never at `workspaces/**`.
 */
class WorkspaceRpcTarget extends IterateRpcTarget<"Workspace"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        `A durable workspace at "${this.props.path}": a private checkout of the project repo in a Durable Object filesystem (cloned on first use; every call waits for that clone, so a successful read proves the checkout is ready). Paths are absolute with "/" as the repo root. Read/write/edit freely — nothing is shared until pushed; ` +
        `workspace.git publishes commits to the project repo branch "${workspaceBranchName(this.props.path)}", never to main.`,
      children: {
        appendFile: "Append to a file.",
        cp: "Copy a file or directory ({ recursive } for trees).",
        deleteFile: "Delete one file (false when it did not exist).",
        edit: "Replace an exact string in one file; oldString must match once unless replaceAll is true. Working-tree only — commit via git.",
        exists: "Whether a path exists.",
        git: "Git over this checkout: status/add/rm/commit/log/diff/push — push goes to this workspace's own branch.",
        glob: "Files matching a glob pattern.",
        mkdir: "Create a directory ({ recursive } for parents).",
        mv: "Move/rename a file or directory.",
        readDir: "List a directory (defaults to the root).",
        readFile: "One file's contents ({ path }); null when missing.",
        readFileBytes: "One file's raw bytes; null when missing (use for binaries).",
        reset: "Wipe the checkout; the next call re-clones. Unpushed work is LOST.",
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

  /** File contents, or null when the path does not exist. */
  readFile(path: string): Promise<string | null> {
    return this.durableObjectStub.readFile(path);
  }

  /** Raw file bytes (use for binaries — readFile text-decodes), or null when missing. */
  readFileBytes(path: string): Promise<Uint8Array | null> {
    return this.durableObjectStub.readFileBytes(path);
  }

  /**
   * Wipe the checkout and re-clone the project repo on the next call — the
   * escape hatch for a wedged workspace. Unpushed work is LOST (pushed
   * commits survive on the workspace branch).
   */
  reset(): Promise<void> {
    return this.durableObjectStub.reset();
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
 * Git operations over a workspace's checkout, mirroring `@cloudflare/shell`'s
 * git command names so upstream docs apply. The workflow is ordinary git:
 * `add({ filepath: "." })` stages everything, `commit({ message })` commits,
 * `push()` publishes to the workspace's own branch in the project repo.
 * Push credentials are injected inside the workspace Durable Object (from the
 * project repo's `gitAccess()`), so no token ever rides this surface.
 */
class WorkspaceGitRpcTarget extends IterateRpcTarget<"WorkspaceGit"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        `Git over the workspace checkout at "${this.props.path}". Ordinary flow: add({ filepath: "." }) → commit({ message }) → push(). ` +
        `push() publishes to the project repo branch "${workspaceBranchName(this.props.path)}" (this workspace's own branch — never main); credentials are automatic.`,
      children: {
        add: 'Stage a file ("." for everything).',
        commit: "Commit staged changes ({ message, author? }).",
        diff: "Changed files relative to HEAD.",
        log: "Commit history ({ depth? }).",
        push: "Push the workspace branch to the project repo ({ force? }).",
        rm: "Stage a file deletion.",
        status: "Staging state of every changed file.",
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

  /** Staging state of every changed file. */
  status(): Promise<WorkspaceGitStatusEntry[]> {
    return this.durableObjectStub.gitStatus();
  }

  /** Stage a file (`filepath: "."` stages everything). */
  add(input: { filepath: string }): Promise<{ added: string }> {
    return this.durableObjectStub.gitAdd(input);
  }

  /** Stage a file deletion. */
  rm(input: { filepath: string }): Promise<{ removed: string }> {
    return this.durableObjectStub.gitRm(input);
  }

  commit(input: {
    author?: { email: string; name: string };
    message: string;
  }): Promise<{ message: string; oid: string }> {
    return this.durableObjectStub.gitCommit(input);
  }

  log(input?: { depth?: number }): Promise<WorkspaceGitLogEntry[]> {
    return this.durableObjectStub.gitLog(input);
  }

  /** Changed files in the working tree relative to HEAD. */
  diff(): Promise<{ filepath: string; status: string }[]> {
    return this.durableObjectStub.gitDiff();
  }

  /** Push the workspace branch to the project repo. */
  push(input?: { force?: boolean }): Promise<{ branch: string; ok: true }> {
    return this.durableObjectStub.gitPush(input);
  }
}

/** Secret catalog within one project. */
class SecretCollectionRpcTarget extends IterateRpcTarget<"SecretCollection"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        "Secret catalog: get(path) / list(). Secret VALUES never transit this surface — they substitute into egress requests server-side.",
      children: { get: "The secret at a path.", list: "Known secrets (from project state)." },
      parent: "a project itx (itx.secrets)",
    });
  }

  constructor(readonly props: { auth: ItxAuth; projectId: string }) {
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
        fetch: "Egress fetch with secret placeholders substituted server-side.",
        update: "Set the value, egress URLs, and/or refresh strategy.",
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

  /** Set the secret material and/or its egress allowlist. */
  update(input: SecretUpdateInput): Promise<StreamEvent> {
    return this.durableObjectStub.update(input);
  }

  /** The secret stream processor; its public state IS the SecretDescription. */
  get processor(): StreamProcessorRpc<SecretDescription> {
    return new ProcessorRelayRpcTarget<SecretDescription>(() => this.durableObjectStub.processor);
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

/** Workers AI binding exposed through ITX as a project/agent capability. */
class AiRpcTarget extends IterateRpcTarget<"Ai"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        "Cloudflare Workers AI: run(model, body) executes a model, models() lists the catalog, toMarkdown({ name, blob }) converts documents to Markdown. First-party docs: Workers AI binding https://developers.cloudflare.com/workers-ai/configuration/bindings/ ; Markdown Conversion https://developers.cloudflare.com/workers-ai/features/markdown-conversion/ ; conversion options https://developers.cloudflare.com/workers-ai/features/markdown-conversion/conversion-options/ ; image model example https://developers.cloudflare.com/ai/models/%40cf/black-forest-labs/flux-2-klein-9b/ ; speech model example https://developers.cloudflare.com/ai/models/xai/grok-tts/ ; transcription example https://developers.cloudflare.com/ai/models/xai/grok-stt/ ; video model example https://developers.cloudflare.com/ai/models/xai/grok-imagine-video/ .",
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

  /** Run one model invocation (`run("@cf/meta/llama-3.1-8b-instruct", { prompt })`). */
  run(model: string, body: unknown): Promise<unknown> {
    const options: AiRunOptions | undefined =
      this.props.gateway === undefined ? undefined : { gateway: this.props.gateway };
    return env.AI.run(model, body as Record<string, unknown>, options);
  }

  /** Convert documents (`{ name, blob }`) to Markdown; call with no args for the supported-format list. */
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

/** Cloudflare Browser Run binding exposed through ITX. */
class CfBrowserCapabilityRpcTarget extends IterateRpcTarget<"CfBrowserCapability"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        'Cloudflare Browser Run binding. Use quickAction(action, options) for simple browser tasks: content, screenshot, pdf, markdown, snapshot, scrape, json, links, crawl. Example: const resp = await itx.browser.quickAction("markdown", { url }); return await resp.json(). Raw fetch(input, init) exposes the binding for CDP/library integrations. First-party docs: Browser Run https://developers.cloudflare.com/browser-run/ ; Quick Actions https://developers.cloudflare.com/browser-run/quick-actions/ ; Workers binding quickAction https://developers.cloudflare.com/changelog/post/2026-05-28-use-browser-run-quick-actions-directly-from-workers/ .',
      children: {
        fetch: "Raw Browser Run binding fetch for CDP/library use.",
        quickAction:
          'Run a Browser Run quick action: quickAction("markdown", { url }) or quickAction("screenshot", { url, screenshotOptions }).',
      },
      parent: "a project itx (itx.browser / itx.integrations.cf.browser)",
    });
  }

  /** Raw Browser Run fetch, primarily for libraries that connect over CDP. */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return env.BROWSER.fetch(input, init);
  }

  /** Browser Run Quick Actions: content, screenshot, pdf, markdown, snapshot, scrape, json, links, crawl. */
  quickAction(
    action: CfBrowserQuickAction,
    options: CfBrowserQuickActionOptions,
  ): Promise<Response> {
    return (
      env.BROWSER as BrowserRun & {
        quickAction(action: string, options: Record<string, unknown>): Promise<Response>;
      }
    ).quickAction(action, options);
  }
}

/** Cloudflare Images binding exposed through ITX as one-call helpers. */
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

/** Cloudflare Media Transformations binding exposed through ITX as one-call helpers. */
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
        "Cloudflare first-party platform bindings grouped for agents: ai, browser, images, videos. These wrap env.AI, env.BROWSER, env.IMAGES, and env.MEDIA with project-scoped ITX discovery. Each child __describe() links to the relevant Cloudflare docs.",
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
 * (`itx.integrations.<slug>["<connection>"]`). The SDK proxies replay dotted
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
}) {
  return describeNode({
    instructions: [
      `itx.integrations.${input.slug}[${JSON.stringify(input.connection)}] is ${input.sdk}.`,
      `Example: ${input.example}`,
      input.grammar,
    ].join("\n"),
    parent: `the integrations collection (itx.integrations.${input.slug})`,
  });
}

/**
 * The `itx.integrations` collection.
 *
 * Connection-yielding dotted calls are `{slug}.{connection}.{...method}`.
 * Built-in slugs (`slack`, `google`, `github`) dispatch to deployment code —
 * `itx.integrations.slack["main-slack"].chat.postMessage({...})` reaches any
 * Slack Web API method (a real WebClient), `itx.integrations.google["jonas"].gmail.request({...})`
 * the Gmail REST proxy, and `itx.integrations.github["jonas"]` is a real
 * Octokit — `.rest.apps.listReposAccessibleToInstallation()`, the
 * `.request("GET /repos/{owner}/{repo}")` escape hatch, `.graphql(...)`;
 * there is NO generic `.api.request({ method, path })` shape, and the
 * connection acts as a GitHub App INSTALLATION, so user-scoped
 * `...ForAuthenticatedUser` endpoints answer 403 — and every other slug
 * resolves through the ITX capability table under the `integrations` prefix.
 * The exception is `itx.integrations.parallel`: a first-party API-key RPC
 * target, not a connection and not returned by `list()`. There is no implicit
 * connection: a built-in call without a connection name is an error.
 *
 * Built-in integrations are plain imperative dispatch branches, not classes,
 * because their only callers are untyped dotted scripts; a project extends
 * the collection with ordinary `provideCapability({ path: ["integrations", ...] })`
 * — data, not deployment. `completeConnect` is called by the app worker's
 * OAuth callback routes (/api/integrations/<provider>/callback); its
 * authority is the HMAC-signed OAuth state minted by startOAuthFlow,
 * verified itx-side.
 */
class ProjectIntegrationsRpcTarget extends IterateRpcTarget<"ProjectIntegrations"> {
  constructor(readonly props: { auth: ItxAuth; ctx: CfExecutionContext; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
    return withInvokeCapabilityFallback(this);
  }

  // The project-root capability table: unknown slugs resolve there, and
  // list() reads its mounts.
  get #capabilityHost() {
    return env.CAPABILITY_HOST.getByName(
      DurableObjectNameCodec.stringify({ path: "/", projectId: this.props.projectId }),
    );
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

  /** The dotted-call surface: built-in slugs dispatch here; unknown slugs
   * resolve through the project capability table (the provided lane). Slack
   * methods are unary — one body object:
   * `itx.integrations.slack["<connection>"].chat.postMessage({ ... })`. */
  async invokeCapability(call: { args?: unknown[]; path: string[] }): Promise<unknown> {
    const { args = [], path } = call;
    const [slug, connection, ...method] = path;

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
          example: `await itx.integrations.slack[${JSON.stringify(connection)}].chat.postMessage({ channel, text })`,
          grammar: SLACK_CALL_GRAMMAR,
          sdk: "a real Slack WebClient (@slack/web-api): any Web API method as a dotted path, always ONE body object argument",
          slug: "slack",
        });
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

    if (slug === "google") {
      if (connection && method.length === 1 && method[0] === "__describe") {
        return describeConnectionSdk({
          connection,
          example: `await itx.integrations.google[${JSON.stringify(connection)}].gmail.request({ path: "/users/me/messages", query: { maxResults: 10, q: "in:inbox" } })`,
          grammar:
            "itx.integrations.google expected `<connection>.gmail.request({...})`; paths are relative to https://gmail.googleapis.com/gmail/v1.",
          sdk: "the Gmail REST API behind gmail.request({ path, query, method, headers, body })",
          slug: "google",
        });
      }
      // gmail.request is two segments; fewer after the connection means the
      // caller skipped the connection (the pre-connections itx.gmail shape).
      if (!connection || method.length < 2) {
        throw new Error(
          'itx.integrations.google expected `<connection>.gmail.request({...})` (e.g. itx.integrations.google["jonas"].gmail.request({ path: "/users/me/messages" })); use itx.integrations.list() to see connections.',
        );
      }
      if (method[0] !== "gmail" || method[1] !== "request" || method.length !== 2) {
        throw new Error(
          `itx.integrations.google["${connection}"] exposes gmail.request(...); got "${method.join(".")}".`,
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
          example: `await itx.integrations.github[${JSON.stringify(connection)}].rest.apps.listReposAccessibleToInstallation({ per_page: 5 })`,
          grammar: GITHUB_CALL_GRAMMAR,
          sdk: 'a real Octokit (@octokit/rest): rest.<namespace>.<method>(params), the request("GET /repos/{owner}/{repo}", params) escape hatch, graphql(query, variables), and paginate(route, params). There is NO generic api.request({ method, path }) shape. The connection acts as a GitHub App INSTALLATION: enumerate repos with rest.apps.listReposAccessibleToInstallation() (data.repositories); user-scoped ...ForAuthenticatedUser endpoints answer 403',
          slug: "github",
        });
      }
      // The connection's wrapped Octokit: replay the caller's dotted path onto
      // it (rest.*, request(...), graphql(...)) — a real Octokit whose transport
      // rides the connection secret's substituting egress (github-api.ts).
      const octokit = connectionOctokit({ connection, projectId: this.props.projectId });
      try {
        return await replayPathCall(octokit, { args, path: method });
      } catch (error) {
        throw normalizeGithubError(error, connection);
      }
    }

    if (slug === "parallel") {
      const [, ...operationPath] = path;
      return await (
        this.parallel as unknown as {
          invokeCapability(input: { args?: unknown[]; path: string[] }): Promise<unknown>;
        }
      ).invokeCapability({ args, path: operationPath });
    }

    if (BUILTIN_INTEGRATION_SLUGS.has(slug)) {
      throw new Error(
        `builtin integration "${slug}" has no dispatch branch — add one in ProjectIntegrationsRpcTarget.invokeCapability`,
      );
    }
    return await this.#capabilityHost.invokeCapability({ args, path: ["integrations", ...path] });
  }

  /** Every connection the project holds: `/integrations/<slug>/<connection>`
   * journals plus provided mounts from the capability table (deduped by path;
   * a mount over its own webhook journal is one entry). */
  async list(): Promise<IntegrationConnectionListEntry[]> {
    const [journalConnections, mounted] = await Promise.all([
      listIntegrationConnections(this.props.projectId),
      this.#capabilityHost.describeCapabilities(),
    ]);
    const entries: IntegrationConnectionListEntry[] = [
      ...journalConnections.map((entry): IntegrationConnectionListEntry => {
        const { integration } = entry;
        return isBuiltinIntegrationSlug(integration)
          ? { ...entry, integration, source: "builtin" }
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
        'Slack: await itx.integrations.slack["<connection>"].chat.postMessage({ channel, thread_ts, text }) — any Slack Web API method as a dotted path, always one body object.',
        'Gmail: await itx.integrations.google["<connection>"].gmail.request({ path: "/users/me/messages", query: { maxResults, q: "in:inbox" } }) — paths relative to https://gmail.googleapis.com/gmail/v1.',
        'GitHub: itx.integrations.github["<connection>"] is a wrapped Octokit acting as a GitHub App installation — await itx.integrations.github["<connection>"].rest.apps.listReposAccessibleToInstallation() (data.repositories), .rest.issues.create({ owner, repo, title }), or the escape hatch .request("GET /repos/{owner}/{repo}", { owner, repo }). User-scoped ...ForAuthenticatedUser endpoints answer 403.',
        "Parallel: await itx.integrations.parallel.__describe() loads Parallel's OpenAPI spec and lists flat operationId methods. It is not a connection and is not returned by list().",
        'Other names resolve through the PROJECT capability table: mount at the project root — await itx.capabilityHosts.get("/").provideCapability({ path: ["integrations", "<slug>"], ... }) — to add a project-owned integration with the same address shape. itx.provideCapability mounts on YOUR OWN scope, which itx.integrations.* dispatch does not consult (an agent-scope mount is unreachable here). Copy the known-good recipe from itx.examples.get({ id: "github-mcp-connect" }).',
      ].join("\n"),
      types: [
        "type GmailRequestInput = {",
        "  body?: unknown;",
        "  headers?: Record<string, string>;",
        "  method?: string;",
        "  path: string;",
        "  query?: Record<string, boolean | number | string | null | undefined>;",
        "};",
        '// itx.integrations.google["<connection>"] exposes:',
        "interface GoogleConnection {",
        "  gmail: { request(input: GmailRequestInput): Promise<{ data: unknown; headers: Record<string, string>; status: number; statusText: string }> };",
        "}",
        '// itx.integrations.github["<connection>"] IS a wrapped Octokit (@octokit/rest):',
        "// its whole surface works — rest.<namespace>.<method>(params), the",
        "// request(route, params) escape hatch, and graphql(query, variables).",
        "// The connection acts as a GitHub App INSTALLATION: enumerate repos with",
        "// rest.apps.listReposAccessibleToInstallation() (data.repositories);",
        "// user-scoped ...ForAuthenticatedUser endpoints answer 403.",
        "interface GithubConnection {",
        "  rest: RestEndpointMethods; // e.g. rest.repos.get({ owner, repo }) -> { data, status, headers, url }",
        "  request(route: string, params?: Record<string, unknown>): Promise<{ data: unknown; headers: Record<string, string>; status: number; url: string }>;",
        "  graphql(query: string, variables?: Record<string, unknown>): Promise<unknown>;",
        "  // paginate(route, params) returns ALL pages as one array. Use it, not",
        "  // paginate.iterator() (an async generator can't cross the itx RPC boundary).",
        "  paginate(route: string, params?: Record<string, unknown>): Promise<unknown[]>;",
        "}",
        '// itx.integrations.slack["<connection>"] IS a wrapped Slack WebClient',
        "// (@slack/web-api): any Web API method as a dotted path, ONE body arg.",
        "interface SlackConnection {",
        "  chat: { postMessage(body: Record<string, unknown>): Promise<Record<string, unknown>> };",
        "  // ...every other Web API method, same dotted shape",
        "}",
        "// itx.integrations.parallel exposes a flat OpenAPI RPC target:",
        "type Parallel = OpenApiRpc;",
      ].join("\n"),
      children: {
        cf: "Cloudflare first-party platform bindings: ai, browser, images, videos.",
        completeConnect:
          "OAuth callback completion; authority is the HMAC-signed state minted by startOAuthFlow.",
        disconnect: "Disconnect one connection: { provider, connection }.",
        getConnection: "Connection status for { provider, connection }.",
        github:
          'Per-connection wrapped Octokit (a GitHub App installation): github["<connection>"].rest.apps.listReposAccessibleToInstallation(), .request("GET /..."), .graphql(...).',
        google:
          'Per-connection Gmail: google["<connection>"].gmail.request({ path: "/users/me/messages", query }).',
        list: "Every connection the project holds (built-in journals plus provided mounts).",
        parallel: "Parallel API RPC target using Iterate's platform API key.",
        slack:
          'Per-connection wrapped Slack WebClient: slack["<connection>"].chat.postMessage({ channel, text }) — any Web API method, one body object.',
        startOAuthFlow: "Begin the OAuth connect flow; returns the authorization URL.",
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

  /** Begin the OAuth connect flow; returns the authorization URL. */
  startOAuthFlow(input: {
    callbackUrl?: string;
    provider: BuiltinIntegrationSlug;
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
    /** OAuth authorization code (slack/google). */
    code?: string;
    /** GitHub App installation id — github's callback carries this, not a code. */
    installationId?: string;
    provider: BuiltinIntegrationSlug;
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
        send: "Send one email from the project's address; agent scopes get replies routed back to them. Returns { from, messageId }.",
        reply:
          "Reply within this agent's email conversation (email thread agents, or any agent that has sent/received project email); returns { from, to, messageId }.",
      },
      parent: "the project itx root",
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
    const threadId =
      emailThreadIdFromAgentPath(this.props.scopePath) ?? (await this.#threadIdFromOwnRoute());
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
   * 1. `thread-route-configured` on `/integrations/email` — the router
   *    forwards replies (token or header match) to this agent's stream.
   * 2. The same route event on the agent's own stream — thread context for
   *    the email-agent processor and `reply`'s thread lookup.
   * 3. The email-agent processor subscription on the agent's stream — a
   *    non-email agent (Slack, web chat, …) gains the transcriber that turns
   *    forwarded replies into its input. Email thread agents had it at birth;
   *    the identical idempotency key dedupes.
   * Project-scoped sends return null and stay plain one-way mail.
   */
  async #bindOutboundThreadToAgent(input: {
    identity: { slug: string; domain: string };
    request: { to: string | string[]; subject: string };
  }) {
    const scopePath = this.props.scopePath;
    if (!scopePath.startsWith("/agents/")) return null;
    const threadId =
      emailThreadIdFromAgentPath(scopePath) ??
      (await this.#threadIdFromOwnRoute()) ??
      mintOutboundEmailThreadId();
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
        routeEvent,
        buildDurableObjectProcessorSubscriptionConfiguredEvent({
          durableObjectName,
          idempotencyKey: `stream/subscription-configured:${durableObjectName}#${EmailAgentProcessorContract.slug}`,
          processorSlug: EmailAgentProcessorContract.slug,
          subscriberType: "agent",
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
   * The thread already bound to this agent scope, if any: the latest
   * `thread-route-configured` on the agent's own stream that names this
   * stream. Lets repeated sends reuse one conversation and lets `reply` work
   * from non-email agent scopes.
   */
  async #threadIdFromOwnRoute(): Promise<string | null> {
    if (!this.props.scopePath.startsWith("/agents/")) return null;
    const stream = integrationStreamStub(this.props.projectId, this.props.scopePath);
    let afterOffset = 0;
    let threadId: string | null = null;
    for (;;) {
      const page = await stream.getEvents({
        afterOffset,
        eventTypes: ["events.iterate.com/email/thread-route-configured"],
        limit: 500,
      });
      for (const event of page) {
        const payload = event.payload as { streamPath?: string; threadId?: string };
        if (payload.streamPath === this.props.scopePath && typeof payload.threadId === "string") {
          threadId = payload.threadId;
        }
      }
      if (page.length < 500) return threadId;
      afterOffset = page[page.length - 1]!.offset;
    }
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
  // the agent path. Exposed as `agent.capabilityHost` and used as the
  // fallback for dynamic dotted-path calls (`agent.someTool(...)`).
  capabilityHost: CapabilityHostRpcTarget;
  ctx: CfExecutionContext;
  projectId: string;
};

/** Agent capability surface for message loops and agent-local dynamic tools. */
class AgentRpcTarget extends IterateRpcTarget<"Agent"> {
  // Private for the same reason as the other capability surfaces: public
  // member names are capability namespace (see ITX_SURFACE_MEMBER_NAMES).
  readonly #props: AgentRpcTargetProps;

  constructor(props: AgentRpcTargetProps) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
    normalizeAgentPath(props.capabilityHost.path);
    this.#props = props;
    return withInvokeCapabilityFallback(this, { invoker: props.capabilityHost });
  }

  get #path() {
    return this.#props.capabilityHost.path;
  }

  /** The agent scope's own capability host (provide/revoke/runScript/__describe). */
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
  get processor(): StreamProcessorRpc<AgentProcessorState> {
    return new ProcessorRelayRpcTarget<AgentProcessorState>(() => this.durableObjectStub.processor);
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

  /** Append a user message to the agent stream (triggers the agent's loop). */
  async sendMessage(message: string): Promise<StreamEvent> {
    const [event] = await this.stream.append({
      type: "events.iterate.com/agents/user-message-received",
      payload: { content: message, origin: "web" },
    });
    return event;
  }

  /**
   * Send-and-wait convenience: appends a user message and resolves with the
   * agent's next chat reply on this stream. Replies are matched by order, not
   * correlated per request — concurrent asks on one agent stream interleave
   * exactly like two people typing into the same chat.
   */
  async ask(input: {
    message: string;
    /** Where the message came from. Defaults to "web". */
    origin?: "web" | "mcp";
    /** How long to wait for the reply. Defaults to 45s. */
    timeoutMs?: number;
  }): Promise<StreamEvent> {
    const [sent] = await this.stream.append({
      type: "events.iterate.com/agents/user-message-received",
      payload: { content: input.message, origin: input.origin ?? "web" },
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
   * attachments (each with a signed public `url`) is appended to the agent
   * stream — so the files show up as a single conversation message, and
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
    if (input.files.length === 0) throw new Error("agent.addFiles requires at least one file.");
    const files = await storeAgentFileAttachments({
      agentPath: this.#path,
      config: parseConfig(env),
      files: input.files,
      projectId: this.#props.projectId,
    });
    const [event] = await this.stream.append({
      type: "events.iterate.com/agent/input-added",
      payload: {
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
        "One agent: the narrow control surface for the agent stream at this path. Dotted calls on unknown members resolve against the agent scope's capability host.",
      children: {
        addFiles:
          "Store files in project storage AND attach them to this conversation (one call, one message).",
        ask: "Send a message and wait for the agent's next chat reply.",
        capabilityHost: "This agent scope's durable capability table.",
        chat: "The agent's web-chat door (sendMessage).",
        processor: "The agent stream processor (snapshot/state).",
        provideCapability: "Shortcut: mount a capability on THIS agent's scope.",
        revokeCapability: "Shortcut: remove a mount from THIS agent's scope.",
        sendMessage: "Append a user message to the agent stream.",
        stream: "The agent's own event stream.",
      },
      parent: `project ${this.#props.projectId}, via agents.get("${this.#path}")`,
      agentPath: this.#path,
      projectId: this.#props.projectId,
      whoami: `agent ${this.#props.projectId}:${this.#path}`,
    });
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
 * and eventually call `invokeCapability`. Dynamic workers do not share a fixed
 * method surface, so this wrapper deliberately exposes no method names beyond
 * the flattened capability dispatcher.
 */
class DynamicWorkerRpcTarget extends IterateRpcRelay<"DynamicWorkerCapability"> {
  readonly #buildBudgetMs: number | undefined;
  readonly #flattenNestedPaths: boolean;
  readonly #props: { ctx: CfExecutionContext; projectId: string };
  readonly #ref: DynamicWorkerRef;
  #lazyRunner: DynamicWorkerRunner | undefined;

  constructor(props: {
    buildBudgetMs?: number;
    ctx: CfExecutionContext;
    flattenNestedPaths?: boolean;
    projectId: string;
    ref: DynamicWorkerRef;
  }) {
    super();
    this.#buildBudgetMs = props.buildBudgetMs;
    this.#flattenNestedPaths = props.flattenNestedPaths === true;
    this.#props = { ctx: props.ctx, projectId: props.projectId };
    this.#ref = props.ref;
    return withInvokeCapabilityFallback(this);
  }

  // Lazy: __describe answers from the ref alone and must not mint loopback
  // stubs; only an actual invocation needs a runner. A worker reached through
  // the public collection runs in the itx scope of its own path — the ITX
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
    // capabilities, and project.worker all share its loader/egress/ITX
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
    });
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
   * bootstrap saga has committed `project/created` — convenient for scripts
   * and tests that use the project immediately. Pass
   * `waitUntilCreated: false` to resolve as soon as the project EXISTS
   * (identity registered, directory primed, bootstrap events appended): the
   * saga then runs behind the returned handle, and its progress is ordinary
   * live processor state (`itx.processor.onStateChange` — `state.created`
   * flips when bootstrap lands). The dashboard uses the fast path to redirect
   * into the project instantly and play creation progress from pushes.
   */
  async create(args: {
    organizationSlug?: string;
    projectId?: string;
    slug: string;
    waitUntilCreated?: boolean;
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

    const appendRootEvents = () =>
      stream.append(
        buildDurableObjectProcessorSubscriptionConfiguredEvent({
          durableObjectName: streamDurableObjectName({
            projectId: registered.projectId,
            path: "/",
          }),
          processorSlug: ProjectProcessorContract.slug,
          subscriberType: "project",
        }),
        buildDurableObjectProcessorSubscriptionConfiguredEvent({
          durableObjectName: streamDurableObjectName({
            projectId: registered.projectId,
            path: PROJECT_REPO_PATH,
          }),
          processorSlug: RepoProcessorContract.slug,
          subscriberType: "repo",
        }),
        {
          type: "events.iterate.com/project/create-requested",
          idempotencyKey: `project-create-requested:${registered.projectId}`,
          payload: {
            onboardingActive: true,
            projectId: registered.projectId,
            slug: registered.slug,
            // The creating user's email seeds owner-scoped project state (the
            // inbound email sender allowlist). Admin/CLI creates have no user
            // email; nothing is seeded and the deployment allowlist governs.
            ...(userPrincipalOf(this.props.auth)?.email === undefined
              ? {}
              : { creatorEmail: userPrincipalOf(this.props.auth)!.email }),
          },
        },
      );
    // The email sender-allowlist seed ALSO lands synchronously here, not only
    // in the project processor's create-requested lane: the dashboard uses
    // waitUntilCreated: false, so mail from the owner can arrive before that
    // lane runs — this append guarantees the allowlist is live before create()
    // returns. Identical idempotency keys to the lane's appends, so whichever
    // runs second dedupes cleanly.
    const creatorEmail = userPrincipalOf(this.props.auth)?.email;
    const seedEmailAllowlist = () =>
      creatorEmail === undefined
        ? Promise.resolve()
        : integrationStreamStub(registered.projectId, EMAIL_INTEGRATION_STREAM_PATH)
            .append(
              buildDurableObjectProcessorSubscriptionConfiguredEvent({
                durableObjectName: streamDurableObjectName({
                  projectId: registered.projectId,
                  path: EMAIL_INTEGRATION_STREAM_PATH,
                }),
                idempotencyKey: `email-router-subscription:${registered.projectId}`,
                processorSlug: EmailProcessorContract.slug,
                subscriberType: "project",
              }),
              {
                type: "events.iterate.com/email/sender-allowed",
                idempotencyKey: `email-sender-allowed:${registered.projectId}:${creatorEmail.toLowerCase()}`,
                payload: { pattern: creatorEmail, reason: "project-owner" },
              },
            )
            .then(() => undefined);
    const [[, , createRequested]] = await timedStep("create-timing", timing, "root-append", () =>
      Promise.all([appendRootEvents(), seedEmailAllowlist()]),
    );
    // The project now EXISTS (identity, directory, bootstrap events); whether
    // to also wait for the saga to finish is the caller's choice — the
    // dashboard skips it and watches `state.created` via processor pushes.
    if (args.waitUntilCreated !== false) {
      await timedStep("create-timing", timing, "wait-project-created", () =>
        stream.waitForEvent({
          afterOffset: createRequested.offset - 1,
          eventTypes: ["events.iterate.com/project/created"],
          predicate: (event) => event.payload?.projectId === args.projectId,
          // Tight on purpose: the saga should complete in seconds (see
          // tasks/os-cold-create-latency.md for the cold-slot outliers that must
          // be fixed, not waited out). Preview CI warms slots before the suites.
          timeoutMs: 60_000,
        }),
      );
    }

    return itxForScope({
      auth: this.props.auth,
      ctx: this.props.ctx,
      path: "/",
      projectId: args.projectId,
    });
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
      const config = this.props.config;
      if (!config?.iterateAuth?.serviceToken) {
        throw new Error("project creation requires the auth worker directory to be configured");
      }
      const organizationSlug = resolveOrganizationSlugForCreate(
        userPrincipal,
        args.organizationSlug,
      );
      const created = await createAuthWorkerServiceClient(
        { config },
        { asUserId: userPrincipal.userId },
      ).internal.project.createForOrganization({
        organizationSlug,
        name: args.slug,
        slug: args.slug,
        ...(args.projectId === undefined ? {} : { id: args.projectId }),
      });
      return { organizationId: created.organizationId, projectId: created.id, slug: created.slug };
    }

    if (!this.props.auth.isAdmin()) {
      throw new Error(`principal "${this.props.auth.principal}" cannot create projects`);
    }
    if (args.projectId !== undefined) {
      return { organizationId: null, projectId: args.projectId, slug: args.slug };
    }
    const serviceToken = this.props.config?.iterateAuth?.serviceToken;
    if (this.props.config && serviceToken) {
      const minted = await createAuthWorkerServiceClient({
        config: this.props.config,
      }).internal.project.mintProjectId();
      return { organizationId: null, projectId: minted.id, slug: args.slug };
    }
    return { organizationId: null, projectId: "prj_" + crypto.randomUUID(), slug: args.slug };
  }

  /**
   * The session's projects, enriched: identity (id/slug/org) from the auth
   * claims or the project directory, deployment status from a concurrent
   * engine probe (`state.created` on each project's processor snapshot). A
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
        return { status: "fulfilled", value: outcome.value.created === true };
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
    // The host itself gets the dotted-path fallback too: host.foo.bar(x) is
    // host.invokeCapability({ path: ["foo", "bar"], args: [x] }).
    return withInvokeCapabilityFallback(this);
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
        invokeCapability:
          "Explicit dynamic dispatch ({ path, args }); dotted calls compile to this.",
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
 * THE one table of project built-ins: member name -> one-line blip. Everything
 * else derives from it — the capability inventory rows in `__describe()`
 * (via PROJECT_BUILTIN_CAPABILITY_DESCRIPTIONS) and the `children` map — so
 * adding a built-in is one entry here plus the getter on ProjectRpcTarget.
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
  examples: "Catalogue of known-good itx script snippets: list(), get({ id }).",
  files:
    "Project file storage: files.get(path) → put({ data, contentType }), bytes(), url() (signed public link), delete(). Agent scopes: prefer itx.agent.addFiles to store AND attach in one call.",
  integrations:
    'Integration connections, each at /integrations/<slug>/<connection>: list() enumerates them; itx.integrations.slack["<connection>"].chat.postMessage({ channel, text }), itx.integrations.google["<connection>"].gmail.request({ path, query }), itx.integrations.github["<connection>"].rest.repos.get({ owner, repo }) (a wrapped Octokit); other slugs resolve through the project capability table. Cloudflare first-party bindings live at itx.integrations.cf.{ai,browser,images,videos}.',
  mcp: "Ad-hoc MCP clients: connect(url); itx.mcp.exa is the built-in Exa web search.",
  openapi: "Ad-hoc OpenAPI clients: connect(spec).",
  parallel: "Parallel API: preconfigured OpenAPI client using Iterate's platform API key.",
  processor: "The project stream processor (snapshot/state).",
  provideCapability:
    "Shortcut: mount a capability on THIS scope (capabilityHost.provideCapability).",
  repo: "The project repo at /repos/project.",
  repos: "Repo catalog by path.",
  revokeCapability: "Shortcut: remove a mount from THIS scope.",
  sandboxes: "Path-addressed Cloudflare sandboxes.",
  scheduler:
    'The default project Scheduler (= schedulers.get("/scheduler/primary")): set({ key, recurrence, script }) runs an itx script on a schedule; cancel(key), list(), trigger(key).',
  schedulers: "Scheduler catalog: get(path) for extra /scheduler/** instances.",
  secrets: "Secret catalog by path.",
  streams: "Project stream catalog: get(path), list().",
  worker: "The default repo-backed project worker.",
  workers: "Dynamic worker refs: get(ref).",
  workspaces:
    "Durable workspace filesystems by path: get(path) is a private always-warm checkout of the project repo in a Durable Object (read/write/edit + git). An agent's own workspace is itx.workspace.",
};

// The shortcut methods are children (callable members) but not capability
// PATHS — they alias capabilityHost, which already has an inventory row.
const PROJECT_BUILTIN_NON_PATHS = new Set(["provideCapability", "revokeCapability"]);

const PROJECT_BUILTIN_CAPABILITY_DESCRIPTIONS: readonly CapabilityDescription[] = Object.entries(
  PROJECT_BUILTIN_BLIPS,
)
  .filter(([name]) => !PROJECT_BUILTIN_NON_PATHS.has(name))
  .map(([name, instructions]) => ({ instructions, path: [name], type: "builtin" as const }));

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
 * in the isolate; only unknown roots fall through `withInvokeCapabilityFallback`
 * to the capability host's dynamic table (which itself chains up to enclosing
 * scopes). So the common `itx.streams.get(...)` path never makes a round trip
 * just to check whether `streams` was shadowed. The deliberate cost: a dynamic
 * capability can never shadow a built-in name — the built-in always wins
 * (`rejectBuiltinCollision` enforces this at provide time). If we end up needing
 * shadowable built-ins a lot, we'd move resolution behind the DO and pay the
 * round trip; today we don't.
 */
export class ProjectRpcTarget extends IterateRpcTarget<"Project"> {
  // Private for the same reason as the other capability surfaces: public
  // member names are capability namespace (see ITX_SURFACE_MEMBER_NAMES).
  readonly #props: ProjectRpcTargetProps;

  constructor(props: ProjectRpcTargetProps) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
    this.#props = props;
    return withInvokeCapabilityFallback(this, { invoker: props.capabilityHost });
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
   * capability (built-ins + dynamic mounts), the children map, and the full
   * public type surface in `types`.
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
        "Built-ins are project-global and identical at every scope; `capabilities` is the full inventory (built-ins + dynamic mounts). " +
        "Unknown dotted members dispatch dynamically against this scope's capability host, chaining up to the project root. " +
        "Deep discovery: call __describe() on any child.",
      types: ITX_TYPES_SOURCE,
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
      capabilities: [...PROJECT_BUILTIN_CAPABILITY_DESCRIPTIONS, ...mountedCapabilities],
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

  /** The project stream processor (snapshot/state; `state.created` flips when bootstrap lands). */
  get processor(): StreamProcessorRpc<ProjectProcessorState> {
    return new ProcessorRelayRpcTarget<ProjectProcessorState>(
      () => this.durableObjectStub.processor,
    );
  }

  /** Workers AI: run(model, body), models(). */
  get ai(): AiRpcTarget {
    return new AiRpcTarget();
  }

  /** Cloudflare Browser Run: quickAction() and raw fetch(). */
  get browser(): CfBrowserCapabilityRpcTarget {
    return new CfBrowserCapabilityRpcTarget();
  }

  // `agent` and `chat` exist only when this itx is scoped under `/agents/` — i.e.
  // when it IS an agent context. They are derived from the scope path rather than
  // mounted as capabilities: being an agent is a property of where the itx sits,
  // not something a caller provided, so a getter keeps zero durable state, needs
  // no bootstrap step, and means `env.ITX.get()` can return this one class at any
  // path with no per-scope branching. On a project-root itx both are undefined.
  /** THIS agent's control surface — present only on an agent-scoped itx (path under `/agents/`). */
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

  /** Read-only catalogue of known-good itx script snippets (`list()`, `get({ id })`). */
  get examples(): ItxExampleCatalogRpcTarget {
    return new ItxExampleCatalogRpcTarget();
  }

  /** Project file storage (R2-backed): `files.get(path)` → put/bytes/url/delete. */
  get files(): FilesRpcTarget {
    return new FilesRpcTarget({
      auth: this.#props.auth,
      projectId: this.#props.projectId,
    });
  }

  /** The integrations collection: built-in integrations as dispatch branches
   * on the dotted-call surface (`itx.integrations.slack["main-slack"].chat
   * .postMessage(...)`), provided integrations through the capability table,
   * management verbs, `list()`. */
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

  /** Path-addressed sandboxes (`itx.sandboxes.get("/sandboxes/cloudflare/whatever")`). */
  get sandboxes(): SandboxCollectionRpcTarget {
    return new SandboxCollectionRpcTarget({
      auth: this.#props.auth,
      projectId: this.#props.projectId,
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
    });
  }

  /** The project repo at /repos/project. */
  get repo(): RepoRpcTarget {
    return new RepoRpcTarget({
      auth: this.#props.auth,
      path: PROJECT_REPO_PATH,
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
   * The default repo-backed project worker — a convenience alias; the general
   * API is `workers.get(ref)`. Flattened: the seeded worker implements
   * invokeCapability in userspace, so `itx.worker.slack.chat.postMessage(...)`
   * is one RPC end to end.
   */
  get worker(): DynamicWorkerCapability<ProjectWorker> {
    return this.workers.get<ProjectWorker>(defaultProjectWorkerRef(), {
      flattenNestedPaths: true,
    });
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

export function defaultProjectWorkerRef(): StatelessDynamicWorkerRef {
  return {
    path: "/",
    source: {
      files: {
        exclude: PROJECT_WORKER_SOURCE_EXCLUDE,
        repoPath: PROJECT_REPO_PATH,
        type: "repo",
      },
      options: { entryPoint: PROJECT_WORKER_ENTRY_POINT },
    },
    type: "stateless",
  };
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
  fetch(request: Request): Promise<Response> {
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
 * The read-only capability a host hands out for one of its processors.
 *
 * A `StreamProcessor` is itself an `RpcTarget`, so returning the instance
 * directly over RPC would expose its host-only plumbing — most dangerously
 * `ingest`, which drives the durable checkpoint. A caller could then call
 * `ingest` with a fabricated high-offset event and fast-forward the checkpoint
 * past every real event, permanently silencing the processor (and run its side
 * effects for events that were never committed). This facade forwards only the
 * four inspection methods of the public `StreamProcessorRpc` contract, so the
 * dangerous surface never crosses the RPC boundary.
 */
export class StreamProcessorRpcTarget<
  Contract extends StreamProcessorContract,
  PublicState = ProcessorState<Contract>,
>
  extends IterateRpcRelay<"StreamProcessorRpc">
  implements StreamProcessorRpc<PublicState>
{
  readonly #processor: StreamProcessor<Contract, object>;
  readonly #catchUpBeforeSnapshot: (() => Promise<void>) | undefined;
  readonly #publicState: ((state: ProcessorState<Contract>) => PublicState) | undefined;

  constructor(
    processor: StreamProcessor<Contract, object>,
    options: {
      /**
       * Host-provided pull-through (`StreamProcessorHost.catchUp`): snapshots
       * served over this target reflect events the push delivery has not
       * brought yet, giving remote readers read-your-writes.
       */
      catchUpBeforeSnapshot?: () => Promise<void>;
      /**
       * Projection applied to EVERY state that leaves this facade — snapshots,
       * runtime state, and `onStateChange` pushes. This is where a domain
       * redacts internals from its public live state (secrets project away the
       * ciphertext, exposing `hasMaterial` instead). Omitted = identity.
       */
      publicState?: (state: ProcessorState<Contract>) => PublicState;
    } = {},
  ) {
    super();
    this.#processor = processor;
    this.#catchUpBeforeSnapshot = options.catchUpBeforeSnapshot;
    this.#publicState = options.publicState;
  }

  #project(state: ProcessorState<Contract>): PublicState {
    return this.#publicState === undefined
      ? (state as unknown as PublicState)
      : this.#publicState(state);
  }

  async snapshot(): Promise<ProcessorSnapshot<PublicState>> {
    await this.#catchUpBeforeSnapshot?.();
    const { offset, state } = await this.#processor.snapshot();
    return { offset, state: this.#project(state) };
  }

  async getRuntimeState() {
    const runtimeState = await this.#processor.getRuntimeState();
    return {
      ...runtimeState,
      snapshot: {
        offset: runtimeState.snapshot.offset,
        state: this.#project(runtimeState.snapshot.state),
      },
    };
  }

  async onStateChange(cb: (snapshot: ProcessorSnapshot<PublicState>) => unknown) {
    // Without a projection the remote callback goes straight to the processor,
    // keeping full stub retention. With one, deliveries pass through a
    // projecting wrapper that forwards the WHOLE retention surface — dup (so
    // the processor's retain duplicates the underlying remote stub, not the
    // wrapper), disposal, and onRpcBroken — so a projected subscription lives
    // exactly as long as an unprojected one.
    const publicState = this.#publicState;
    const target =
      publicState === undefined
        ? (cb as (snapshot: ProcessorSnapshot<ProcessorState<Contract>>) => unknown)
        : projectStateChangeCallback(cb, publicState);
    return new ProcessorStateSubscriptionRpcTarget(await this.#processor.onStateChange(target));
  }

  waitUntilEvent(input: { offset: number; timeoutMs?: number }) {
    return this.#processor.waitUntilEvent(input);
  }
}

// The examples catalogue is plain data (src/itx/examples.ts) shared with the
// REPL "Examples" panel and the e2e matrix. Exposing it as a built-in lets
// agents and scripts browse known-good snippets instead of guessing at the
// surface; list() omits the code bodies so it stays cheap to skim.
// Session-context entries are excluded: they run against the OS Session
// (what authenticate() returns), which an itx holder does not have.
const PROJECT_CONTEXT_EXAMPLES = ITX_EXAMPLES.filter((example) => example.context === "project");

class ItxExampleCatalogRpcTarget extends IterateRpcTarget<"ItxExampleCatalog"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        "Read-only catalogue of known-good itx script snippets: list() summaries, get({ id }) one example with full code. Copy working patterns instead of inventing them.",
      children: { get: "One example with code.", list: "All example summaries." },
      parent: "a project itx (itx.examples)",
    });
  }

  /** Every example summary, without code bodies (cheap to skim). */
  async list(): Promise<ItxExampleSummary[]> {
    return PROJECT_CONTEXT_EXAMPLES.map(exampleSummary);
  }

  /** One example with its full script body. */
  async get(input: { id: string }): Promise<ItxExampleWithCode> {
    const example = PROJECT_CONTEXT_EXAMPLES.find((candidate) => candidate.id === input.id);
    if (!example) {
      throw new Error(`unknown example "${input.id}" — itx.examples.list() has every id`);
    }
    return { ...exampleSummary(example), code: example.code };
  }
}

function exampleSummary(example: ItxExample): ItxExampleSummary {
  return {
    description: example.description,
    id: example.id,
    title: example.title,
  };
}

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
 */
class ProcessorRelayRpcTarget<State>
  extends IterateRpcRelay<"StreamProcessorRpc">
  implements StreamProcessorRpc<State>
{
  readonly #resolveProcessor: () => PromiseLike<unknown>;

  constructor(resolveProcessor: () => PromiseLike<unknown>) {
    super();
    this.#resolveProcessor = resolveProcessor;
  }

  async #processor(): Promise<StreamProcessorRpc<State>> {
    return (await this.#resolveProcessor()) as StreamProcessorRpc<State>;
  }

  async snapshot() {
    return await (await this.#processor()).snapshot();
  }

  async getRuntimeState() {
    return await (await this.#processor()).getRuntimeState();
  }

  async onStateChange(cb: (snapshot: ProcessorSnapshot<State>) => unknown) {
    return await (await this.#processor()).onStateChange(cb);
  }

  async waitUntilEvent(input: { offset: number; timeoutMs?: number }) {
    return await (await this.#processor()).waitUntilEvent(input);
  }
}

/**
 * Wrap a state-change callback so every delivery is projected through
 * `publicState`, WITHOUT losing the callback's RPC retention surface: `dup()`
 * duplicates the underlying remote stub (re-wrapped, so the duplicate projects
 * too), disposal releases it, and `onRpcBroken` forwards. This is what lets
 * `StreamProcessor.onStateChange`'s retain machinery treat a projected remote
 * callback exactly like a bare one.
 */
function projectStateChangeCallback<InternalState, PublicState>(
  cb: (snapshot: ProcessorSnapshot<PublicState>) => unknown,
  publicState: (state: InternalState) => PublicState,
): (snapshot: ProcessorSnapshot<InternalState>) => unknown {
  const retainable = cb as typeof cb &
    Partial<Disposable> & {
      dup?(): typeof cb;
      onRpcBroken?(handler: (error: unknown) => void): void;
    };
  return Object.assign(
    (snapshot: ProcessorSnapshot<InternalState>) =>
      cb({ offset: snapshot.offset, state: publicState(snapshot.state) }),
    {
      ...(typeof retainable.dup === "function"
        ? { dup: () => projectStateChangeCallback(retainable.dup!.call(retainable), publicState) }
        : {}),
      ...(typeof retainable.onRpcBroken === "function"
        ? {
            onRpcBroken: (handler: (error: unknown) => void) =>
              retainable.onRpcBroken!.call(retainable, handler),
          }
        : {}),
      [Symbol.dispose]: () => {
        retainable[Symbol.dispose]?.();
      },
    },
  );
}

/**
 * RPC ownership handle for one `onStateChange` subscription — the processor
 * counterpart of {@link StreamSubscriptionRpcTarget}. `unsubscribe()` is the
 * explicit domain operation, disposal is the scoped cleanup path, and `ping()`
 * reports whether the subscription is still registered on the live processor
 * (a dead Durable Object incarnation makes the call itself reject — both
 * signals tell the client to re-subscribe).
 */
class ProcessorStateSubscriptionRpcTarget extends IterateRpcRelay<"ProcessorStateSubscriptionHandle"> {
  readonly #handle: StreamProcessorStateSubscriptionHandle;

  constructor(handle: StreamProcessorStateSubscriptionHandle) {
    super();
    this.#handle = handle;
  }

  ping() {
    return this.#handle.isLive();
  }

  unsubscribe() {
    this.#handle.unsubscribe();
  }

  [Symbol.dispose](): void {
    this.#handle.unsubscribe();
  }
}

type LazyClientDescription = Pick<Partial<Description>, "instructions" | "parent" | "types">;

function lazyPromise<T>(load: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | undefined;
  return () => (promise ??= load());
}

type McpClientDeps = { description?: LazyClientDescription; egress: Fetcher };

// Exa's hosted MCP server works unauthenticated (rate-limited); pre-connecting
// it gives every project web search with zero setup.
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";

class McpClientCollectionRpcTarget extends IterateRpcTarget<"McpClientCollection"> {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        "Ad-hoc MCP clients: connect({ url }) returns a client whose dotted calls are tool invocations; exa is the built-in Exa web-search server.",
      children: {
        connect: "Connect to an MCP server by URL.",
        exa: "The public Exa MCP server (web_search_exa, web_fetch_exa).",
      },
      parent: "a project itx (itx.mcp)",
    });
  }

  constructor(readonly props: McpClientDeps) {
    super();
  }

  /** Connect to an MCP server by URL; dotted calls on the client are tool invocations. */
  connect(input: McpClientConnectInput): Promise<McpClientRpc> {
    return McpClientRpcTarget.connect(input, this.props);
  }

  /**
   * The public Exa MCP server (https://mcp.exa.ai/mcp), pre-connected for every
   * project: web search and page reading as flat tool calls.
   * `itx.mcp.exa.web_search_exa({ query, numResults })` searches the web;
   * `itx.mcp.exa.web_fetch_exa({ urls, maxCharacters })` reads pages as markdown.
   */
  get exa(): McpClientRpc {
    return McpClientRpcTarget.createLazyClient(
      { url: EXA_MCP_URL },
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
    return withInvokeCapabilityFallback(this);
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
      types: this.props.description?.types,
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
    return withInvokeCapabilityFallback(this);
  }

  async __describe(): Promise<Description> {
    const { operations } = await this.#ready();

    return describeNode({
      instructions:
        this.props.description?.instructions ??
        "An ad-hoc OpenAPI client: a flat dispatcher; client.someOperationId(input) executes that operation against the spec's server.",
      types: this.props.description?.types,
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

async function fetchSpec(
  props: OpenApiConnectInput,
  egress: FetchOnly,
): Promise<Record<string, unknown>> {
  const specHost = new URL(props.specUrl).host;
  const apiHost = props.baseUrl ? new URL(props.baseUrl).host : specHost;
  // Headers can contain getSecret({ path: "/secrets/..." }) placeholders.
  // They must enter the project egress pipe, because that is the only place
  // secret material is substituted. Do not read or rewrite them here.
  const response = await egress.fetch(
    new Request(props.specUrl, { headers: specHost === apiHost ? (props.headers ?? {}) : {} }),
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

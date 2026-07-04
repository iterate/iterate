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
  itxEntrypointProps,
  itxEntrypointBinding,
  itxEntrypointScopeCacheKey,
  rejectBuiltinCollision,
  withInvokeCapabilityFallback,
} from "./domains/itx/utils.ts";
import { ITX_TYPES_SOURCE } from "./types-source.generated.ts";
import { projectStub } from "./domains/projects/egress.ts";
import { ProjectProcessorContract } from "./domains/projects/project-processor-contract.ts";
import { projectEgressFetcher } from "./domains/projects/utils.ts";
import { RepoProcessorContract } from "./domains/repos/repo-processor-contract.ts";
import { PROJECT_REPO_PATH, PROJECT_WORKER_SOURCE_PATH } from "./domains/repos/utils.ts";
import { normalizeCloudflareSandboxPath } from "./domains/sandboxes/cloudflare/utils.ts";
import { normalizeSecretPath } from "./domains/secrets/utils.ts";
import {
  completeGoogleConnect,
  completeSlackConnect,
  disconnectProvider,
  getConnectionStatus,
  startOAuthFlow,
} from "./domains/integrations/connect-flows.ts";
import { callGmailApi } from "./domains/integrations/gmail-api.ts";
import { getFreshGoogleAccessToken } from "./domains/integrations/google-tokens.ts";
import { callProjectSlackWebApi } from "./domains/integrations/slack-api.ts";
import {
  buildDurableObjectProcessorSubscriptionConfiguredEvent,
  resolveStreamPath,
} from "./domains/streams/utils.ts";
import { DynamicWorkerRef as WorkerRefSchema } from "./domains/workers/schemas.ts";
import type { StreamEvent, StreamEventInput } from "./domains/streams/schemas.ts";
import { DynamicWorkerRunner } from "./domains/workers/worker-runner.ts";
import {
  isObjectSchema,
  listOpenApiOperations,
  operationBodySchema,
  type OpenApiOperation,
} from "./domains/itx/openapi-types.ts";
import { callMcpToolPath } from "./domains/itx/mcp-client.ts";
import { ITX_EXAMPLES, type ItxExample } from "./itx/examples.ts";
import type { ProcessorState } from "./domains/streams/processor-contracts.ts";
import type {
  StreamProcessor,
  StreamProcessorContract,
  StreamProcessorStateSubscriptionHandle,
} from "./domains/streams/stream-processor.ts";
import type {
  Agent,
  AgentChat,
  CapabilityHost,
  CapabilityHostCollection,
  CapabilityProvision,
  CapabilityDescription,
  AgentCollection,
  Ai,
  CfExecutionContext,
  CloudflareSandbox,
  CommitRepoFilesInput,
  CommitRepoFilesResult,
  CompleteConnectResult,
  Description,
  EditRepoFileInput,
  EditRepoFileResult,
  GmailRequestInput,
  IntegrationConnectionStatus,
  IntegrationProvider,
  ItxAuth,
  ItxAuthCredentials,
  ProjectRpcTarget as ProjectRpcTargetContract,
  ItxExampleCatalog,
  ItxExampleSummary,
  ItxExampleWithCode,
  Session,
  McpClientCollection,
  McpClientConnectInput,
  McpClientRpc,
  OpenApiCollection,
  OpenApiConnectInput,
  OpenApiRpc,
  ProcessEventBatch,
  ProcessorRuntimeState,
  ProjectCollection,
  ProjectDescription,
  ProjectListEntry,
  ProjectRepoCollection,
  ProjectStreamCollection,
  ProjectEgress,
  ProjectEgressIntercept,
  ProjectEgressInterceptor,
  ProjectWorker,
  ProvideCapabilityInput,
  RevokeCapabilityInput,
  Repo,
  RepoCollection,
  SandboxCollection,
  Secret,
  SecretCollection,
  SecretDescription,
  SecretUpdateInput,
  StatelessDynamicWorkerRef,
  Stream,
  StreamCollection,
  StreamListItem,
  AgentProcessorState,
  ProcessorSnapshot,
  ProcessorStateSubscriptionHandle,
  ProjectProcessorState,
  RepoProcessorState,
  StreamProcessorRpc,
  StreamSubscriptionHandle,
  UnauthenticatedOs,
  DynamicWorkerCapability,
  DynamicWorkerCollection,
  DynamicWorkerRef,
  GmailCapability,
  ProjectIntegrations,
  SlackCapability,
} from "./types.ts";

/**
 * Durable event stream capability.
 *
 * Streams are the public coordination primitive, not an internal queue hidden
 * behind domain methods. Domain helpers can construct common event shapes, but
 * callers and processors still work with explicit events.
 */
export class StreamRpcTarget extends RpcTarget implements Stream {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions: `A durable event stream at path "${this.props.path}": append(events), getEvents(), waitForEvent(), subscribe(). Streams are the coordination primitive — processors and agents communicate by appending and reducing events.`,
      children: {
        append: "Commit events; returns them with offsets.",
        at: "The stream at a sub-path.",
        getEvent: "One event by offset or idempotencyKey.",
        getEvents: "Read a range of events.",
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
  at(path: string): Stream {
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

  /** Read a range of committed events. */
  getEvents(args?: {
    afterOffset?: number;
    beforeOffset?: number | null;
    limit?: number;
  }): Promise<StreamEvent[]> {
    return this.durableObjectStub.getEvents(args);
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
class StreamCollectionRpcTarget extends RpcTarget implements StreamCollection {
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
  get(path: string): Stream {
    return new StreamRpcTarget({
      auth: this.props.auth,
      projectId: this.props.projectId,
      path,
    });
  }
}

/** Project-scoped stream catalog with reduced-state listing. */
class ProjectStreamCollectionRpcTarget
  extends StreamCollectionRpcTarget
  implements ProjectStreamCollection
{
  constructor(readonly projectProps: { auth: ItxAuth; projectId: string }) {
    super(projectProps);
  }

  /** Known streams, read from the project processor's reduced state. */
  list(): Promise<StreamListItem[]> {
    return projectProcessorState(this.projectProps.projectId).then((state) => state.streams);
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
class RepoRpcTarget extends RpcTarget implements Repo {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions: `A git repo (over Cloudflare Artifacts) at path "${this.props.path}": readFile/listFiles/commitFiles/edit, plus create() for first use. For coding-agent file changes that do not need a sandbox, readFile then edit is the default targeted workflow; use commitFiles for new files or batch/full-file writes.`,
      children: {
        commitFiles: "Commit a batch of file changes ({ message, changes }).",
        create: "Create the repo if it does not exist yet.",
        edit: "Replace an exact string in one file and commit it; oldString must match once unless replaceAll is true.",
        listFiles: "List file paths.",
        readFile: "Read one file ({ path }).",
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
  create(): Promise<Repo> {
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

  /** The repo stream processor (snapshot/state). */
  get processor(): StreamProcessorRpc<RepoProcessorState> {
    return new ProcessorRelayRpcTarget<RepoProcessorState>(() => this.#durableObjectStub.processor);
  }
}

/** Repo catalog for either a project or the deployment-wide global scope. */
class RepoCollectionRpcTarget extends RpcTarget implements RepoCollection {
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
  create(input: { path: string }): Promise<Repo> {
    return requestRepoCreate({
      auth: this.props.auth,
      path: input.path,
      projectId: this.props.projectId,
    });
  }

  /** The repo at a path. */
  get(path: string): Repo {
    return new RepoRpcTarget({
      auth: this.props.auth,
      path: normalizePath(path),
      projectId: this.props.projectId,
    });
  }
}

/** Project-scoped repo catalog with reduced-state listing. */
class ProjectRepoCollectionRpcTarget
  extends RepoCollectionRpcTarget
  implements ProjectRepoCollection
{
  constructor(readonly projectProps: { auth: ItxAuth; projectId: string }) {
    super(projectProps);
  }

  /** Known repos, read from the project processor's reduced state. */
  list(): Promise<StreamListItem[]> {
    return projectProcessorState(this.projectProps.projectId).then((state) => state.repos);
  }
}

/** Agent catalog within one project. */
class AgentCollectionRpcTarget extends RpcTarget implements AgentCollection {
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
  get(path: string): Agent {
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
 * from this project's id plus the validated `/sandboxes/cloudflare/...`
 * path, after the same project-access assert every collection performs.
 */
class SandboxCollectionRpcTarget extends RpcTarget implements SandboxCollection {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        'Path-addressed Cloudflare sandboxes: get("/sandboxes/cloudflare/<name>") returns a container-backed sandbox stub (exec, git, files).',
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
    const normalized = normalizeCloudflareSandboxPath(path);
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

/** Secret catalog within one project. */
class SecretCollectionRpcTarget extends RpcTarget implements SecretCollection {
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
  get(path: string): Secret {
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

/** Path-addressed secret capability. Secret material has no public read API. */
class SecretRpcTarget extends RpcTarget implements Secret {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions: `The secret at "${this.props.path}": describe() for metadata, update() to set, fetch() to use it in an egress request via placeholder substitution. The raw value is never returned.`,
      children: {
        describe: "Metadata (exists, updatedAt) — never the value.",
        fetch: "Egress fetch with secret placeholders substituted server-side.",
        update: "Set the value.",
      },
      parent: "itx.secrets.get(path)",
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

  /** Metadata (exists, egress allowlist, audit trail) — never the value. */
  describe(): Promise<SecretDescription> {
    return this.durableObjectStub.describe();
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

/** Workers AI binding exposed through ITX as a project/agent capability. */
class AiRpcTarget extends RpcTarget implements Ai {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions: "Workers AI: run(model, body) executes a model, models() lists the catalog.",
      children: { models: "List available models.", run: "Run one model invocation." },
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
}

/**
 * The `itx.integrations.slack` built-in: a Slack Web API proxy for the project's connected
 * workspace. Dotted Web API method paths (`itx.integrations.slack.chat.postMessage({...})`)
 * resolve through the dynamic path-call fallback onto `invokeCapability`;
 * authorization uses the project's stored bot token through the secret
 * substitution egress pipeline (domains/integrations/slack-api.ts).
 */
class SlackRpcTarget extends RpcTarget implements SlackCapability {
  constructor(readonly props: { auth: ItxAuth; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
    return withInvokeCapabilityFallback(this);
  }

  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        'Slack Web API proxy for the project\'s connected workspace — a flattened dispatcher, not an object graph: any dotted method path compiles to one request (`slack.chat.postMessage({ channel, text })` calls the "chat.postMessage" Web API method). `request({ method, body })` is the explicit form. Sub-paths are Slack\'s method catalogue, not enumerable members. Check itx.integrations.getConnection({ provider: "slack" }) first.',
      children: {
        request: "Explicit form: request({ method, body }) for any Slack Web API method.",
      },
      parent: "itx.integrations (connection-scoped; authorized by the project's stored bot token)",
    });
  }

  /** itx path-call surface: itx.integrations.slack.<Slack Web API method path>(body). */
  async invokeCapability(call: { args?: unknown[]; path: string[] }): Promise<unknown> {
    const { args = [], path } = call;
    const method = path.join(".");
    if (!method) {
      throw new Error("integrations.slack expected a Slack Web API method path.");
    }
    if (args.length > 1) {
      throw new Error(`Slack calls are unary; ${method} received ${args.length} args.`);
    }
    return await this.request({
      body: args[0] as Record<string, unknown> | undefined,
      method,
    });
  }

  /** One Slack Web API call, authorized by the project's stored bot token. */
  async request(input: {
    body?: Record<string, unknown>;
    method: string;
  }): Promise<Record<string, unknown>> {
    return await callProjectSlackWebApi({
      body: input.body ?? {},
      method: input.method,
      projectId: this.props.projectId,
    });
  }
}

/** The `itx.integrations.gmail` built-in: Gmail REST proxy for the project's Google account. */
class GmailRpcTarget extends RpcTarget implements GmailCapability {
  constructor(readonly props: { auth: ItxAuth; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        'Gmail REST proxy for the project\'s connected Google account: request({ path, query, method, body }) against paths relative to https://gmail.googleapis.com/gmail/v1 (e.g. { path: "/users/me/messages", query: { maxResults: 10, q: "in:inbox" } }). Check itx.integrations.getConnection({ provider: "google" }) first.',
      children: {
        request: "One Gmail REST call; returns { data, status, statusText, headers }.",
      },
      parent: "itx.integrations (connection-scoped; authorized by the project's Google tokens)",
    });
  }

  /** One Gmail REST call, authorized by the project's stored Google tokens. */
  async request(request: GmailRequestInput): Promise<{
    data: unknown;
    headers: Record<string, string>;
    status: number;
    statusText: string;
  }> {
    const token = await getFreshGoogleAccessToken({
      config: parseConfig(env),
      projectId: this.props.projectId,
    });
    return await callGmailApi({ request, token });
  }
}

/**
 * The `itx.integrations` built-in: connection status, OAuth start/complete,
 * and disconnect for slack/google, PLUS the connection-scoped API proxies
 * (`integrations.gmail`, `integrations.slack`) — they live here because they
 * only work through the project's connected accounts. The complete* methods
 * are called by the app worker's OAuth callback routes
 * (/api/integrations/<provider>/callback); their authority is the HMAC-signed
 * OAuth state minted by startOAuthFlow, verified itx-side.
 */
class IntegrationsRpcTarget extends RpcTarget implements ProjectIntegrations {
  constructor(readonly props: { auth: ItxAuth; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        "Project integrations: Slack + Google connection lifecycle, and the connection-scoped API proxies. Check getConnection({ provider }) before using a proxy.",
      children: {
        disconnect: "Disconnect a provider.",
        getConnection: 'Connection status for { provider: "slack" | "google" }.',
        gmail:
          'Gmail REST proxy for the connected Google account: gmail.request({ path: "/users/me/messages", query }).',
        slack:
          "Slack Web API proxy for the connected workspace: slack.chat.postMessage({ channel, text }).",
        startOAuthFlow: "Begin the OAuth connect flow; returns the authorization URL.",
      },
      parent: "a project itx (itx.integrations)",
    });
  }

  get gmail(): GmailCapability {
    return new GmailRpcTarget({
      auth: this.props.auth,
      projectId: this.props.projectId,
    });
  }

  get slack(): SlackCapability {
    return new SlackRpcTarget({
      auth: this.props.auth,
      projectId: this.props.projectId,
    });
  }

  /** Connection status for a provider. */
  getConnection(input: { provider: IntegrationProvider }): Promise<IntegrationConnectionStatus> {
    return getConnectionStatus({ projectId: this.props.projectId, provider: input.provider });
  }

  /** Begin the OAuth connect flow; returns the authorization URL to send the user to. */
  startOAuthFlow(input: {
    callbackUrl?: string;
    provider: IntegrationProvider;
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

  /** OAuth callback leg for Slack; authority is the HMAC-signed state from startOAuthFlow. */
  completeSlackConnect(input: {
    code: string;
    state: string;
    userId: string | null;
  }): Promise<CompleteConnectResult> {
    return completeSlackConnect({
      code: input.code,
      config: parseConfig(env),
      projectId: this.props.projectId,
      state: input.state,
      userId: input.userId,
    });
  }

  /** OAuth callback leg for Google; authority is the HMAC-signed state from startOAuthFlow. */
  completeGoogleConnect(input: {
    code: string;
    state: string;
    userId: string | null;
  }): Promise<CompleteConnectResult> {
    return completeGoogleConnect({
      code: input.code,
      config: parseConfig(env),
      projectId: this.props.projectId,
      state: input.state,
      userId: input.userId,
    });
  }

  /** Disconnect a provider and forget its tokens. */
  disconnect(input: { provider: IntegrationProvider }): Promise<{ success: true }> {
    return disconnectProvider({
      config: parseConfig(env),
      projectId: this.props.projectId,
      provider: input.provider,
    });
  }
}

/** Agent-local web chat response tool exposed inside agent script execution. */
class AgentChatRpcTarget extends RpcTarget implements AgentChat {
  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        "An agent's web-chat door: sendMessage({ message }) appends the agent's reply to its stream (what the user sees).",
      children: { sendMessage: "Say something to the user." },
      parent: "agent.chat / itx.chat (agent scopes only)",
    });
  }

  constructor(readonly props: { auth: ItxAuth; path: string; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  /** The agent's own event stream (the chat rides on it). */
  get stream(): Stream {
    return new StreamRpcTarget({
      auth: this.props.auth,
      projectId: this.props.projectId,
      path: this.props.path,
    });
  }

  /** Say something to the user: appends the agent's reply to its stream. */
  async sendMessage(input: { message: string }): Promise<StreamEvent> {
    const message = input.message.trim();
    if (message === "") throw new Error("itx.chat.sendMessage requires a non-empty message.");
    const [event] = await this.stream.append({
      type: "events.iterate.com/agents/web-message-sent",
      payload: { message },
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
class AgentRpcTarget extends RpcTarget implements Agent {
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
  get capabilityHost(): CapabilityHost {
    return this.#props.capabilityHost;
  }

  /** Shortcut for `capabilityHost.provideCapability` (mounts on THIS agent's scope). */
  provideCapability(input: ProvideCapabilityInput): Promise<CapabilityProvision> {
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
  get stream(): Stream {
    return new StreamRpcTarget({
      auth: this.#props.auth,
      projectId: this.#props.projectId,
      path: this.#path,
    });
  }

  /** The agent's web-chat door (what the user sees). */
  get chat(): AgentChat {
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

  /** Includes `whoami` (`"agent <projectId>:<agentPath>"`), `projectId`, `agentPath`. */
  async __describe(): Promise<
    Description & { agentPath: string; projectId: string; whoami: string }
  > {
    return describeNode({
      instructions:
        "One agent: the narrow control surface for the agent stream at this path. Dotted calls on unknown members resolve against the agent scope's capability host.",
      children: {
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
class DynamicWorkerCollectionRpcTarget extends RpcTarget implements DynamicWorkerCollection {
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
      loader: Env["LOADER"];
      projectId: string;
    },
  ) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  /** The live dispatch target for a declarative worker ref (validated by schema). */
  get<T extends object = Record<string, unknown>>(
    ref: DynamicWorkerRef,
  ): DynamicWorkerCapability<T> {
    const parsed = WorkerRefSchema.parse(ref);
    return new DynamicWorkerRpcTarget({
      ctx: this.props.ctx,
      loader: this.props.loader,
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
class DynamicWorkerRpcTarget extends RpcTarget {
  readonly #runner: DynamicWorkerRunner;
  readonly #ref: DynamicWorkerRef;

  constructor(props: {
    ctx: CfExecutionContext;
    loader: Env["LOADER"];
    projectId: string;
    ref: DynamicWorkerRef;
  }) {
    super();
    this.#ref = props.ref;
    const itxScope = itxEntrypointProps({
      path: normalizePath(props.ref.path),
      projectId: props.projectId,
    });
    this.#runner = new DynamicWorkerRunner({
      bindings: {
        // The dynamic worker's ITX binding is supplied by the host context, not
        // by the worker ref. Props remain worker-supplied, but auth/scope stay
        // under the project/agent/ITX object that is doing the hosting.
        ITX: itxEntrypointBinding(props.ctx.exports, itxScope),
      },
      globalOutbound: projectEgressFetcher(props.ctx.exports, props.projectId),
      loader: props.loader,
      projectId: props.projectId,
      workerScopeKey: itxEntrypointScopeCacheKey(itxScope),
    });
    return withInvokeCapabilityFallback(this);
  }

  // Answered from the REF alone — describing a worker must not boot it (no
  // loader isolate, no module top-level code, no DO wake). The worker's own
  // live self-report is a separate, explicit act:
  // `invokeCapability({ path: ["__describe"] })` loads the worker and calls a
  // `__describe` the user code may export.
  async __describe() {
    const source =
      this.#ref.source.type === "inline"
        ? {
            type: "inline" as const,
            mainModule: this.#ref.source.mainModule,
            modules: Object.fromEntries(
              Object.entries(this.#ref.source.modules).map(([name, text]) => [
                name,
                `${text.length} bytes`,
              ]),
            ),
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
    flattenNestedPath = false,
    path,
  }: {
    args?: unknown[];
    flattenNestedPath?: boolean;
    path: string[];
  }) {
    // Keep every dynamic worker invocation behind DynamicWorkerRunner. Stateless
    // entrypoints, stateful DO facets, provided worker capabilities, and
    // project.worker all then share the same loader/egress/ITX binding rules.
    // Return values pass through untouched on purpose: an RpcTarget returned by
    // the dynamic worker must remain a live object-capability so Cap'n Web can
    // serialize it as a chained/pipelined stub for the outer caller.
    return await this.#runner.invokeCapability({
      args,
      flattenNestedPath,
      path,
      ref: this.#ref,
    });
  }
}

/** Catalog of projects reachable from a {@link Session}. */
export class ProjectCollectionRpcTarget extends RpcTarget implements ProjectCollection {
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
          payload: { projectId: registered.projectId, slug: registered.slug },
        },
      );
    const [, , createRequested] = await timedStep(
      "create-timing",
      timing,
      "root-append",
      appendRootEvents,
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
    const outcomes = await Promise.allSettled(
      bases.map(async (base) => {
        const state = await projectProcessorState(base.id);
        return state.created === true;
      }),
    );
    const statuses = deploymentStatusesFromProbes(
      bases.map((base) => base.id),
      outcomes,
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
  async #listEntryBases(
    requestedScope?: "mine" | "deployment",
  ): Promise<Omit<ProjectListEntry, "deploymentStatus">[]> {
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
      }));
    }

    if (userPrincipal) {
      const organizationNames = new Map(
        userPrincipal.organizations.map((organization) => [
          organization.id,
          organization.name ?? null,
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
              organizationName: organizationNames.get(claim.organizationId) ?? null,
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

  async #directoryEntryBase(
    projectId: string,
  ): Promise<Omit<ProjectListEntry, "deploymentStatus">> {
    const record = await readProjectById(env.PROJECT_DIRECTORY, projectId);
    return {
      id: projectId,
      // A scope the directory has never seen (impersonated test principals)
      // still lists — the id doubles as the slug.
      slug: record?.slug ?? projectId,
      organizationId: record?.organizationId ?? null,
      organizationName: null,
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
class CapabilityHostRpcTarget extends RpcTarget implements CapabilityHost {
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
  async provideCapability(input: ProvideCapabilityInput): Promise<CapabilityProvision> {
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
class CapabilityHostCollectionRpcTarget extends RpcTarget implements CapabilityHostCollection {
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
  get(path: string): CapabilityHost {
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
  ai: "Workers AI: run(model, body), models().",
  capabilityHost:
    "This scope's own capability host: provideCapability({ path, ... }) mounts a dynamic capability here (itx.provideCapability is a shortcut), revokeCapability removes one, __describe() lists everything reachable, runScript runs a script in this scope.",
  capabilityHosts:
    'Capability hosts of OTHER scopes, addressed by path: itx.capabilityHosts.get("/") is the project root — providing there makes a capability visible to every scope in the project.',
  debug: "Returns formatted OS debug info for this itx scope, including a dashboard stream link.",
  egress: "Project-attributed outbound fetch (+ intercept).",
  examples: "Catalogue of known-good itx script snippets: list(), get({ id }).",
  integrations:
    "Slack/Google connections plus connection-scoped API proxies: itx.integrations.gmail.request({ path, query }) and itx.integrations.slack.chat.postMessage({ channel, text }). Check itx.integrations.getConnection({ provider }) first.",
  mcp: "Ad-hoc MCP clients: connect(url); itx.mcp.exa is the built-in Exa web search.",
  openapi: "Ad-hoc OpenAPI clients: connect(spec).",
  processor: "The project stream processor (snapshot/state).",
  provideCapability:
    "Shortcut: mount a capability on THIS scope (capabilityHost.provideCapability).",
  repo: "The project repo at /repos/project.",
  repos: "Repo catalog by path.",
  revokeCapability: "Shortcut: remove a mount from THIS scope.",
  sandboxes: "Path-addressed Cloudflare sandboxes.",
  secrets: "Secret catalog by path.",
  streams: "Project stream catalog: get(path), list().",
  worker: "The default repo-backed project worker.",
  workers: "Dynamic worker refs: get(ref).",
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
export class ProjectRpcTarget extends RpcTarget implements ProjectRpcTargetContract {
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
  get ai(): Ai {
    return new AiRpcTarget();
  }

  // `agent` and `chat` exist only when this itx is scoped under `/agents/` — i.e.
  // when it IS an agent context. They are derived from the scope path rather than
  // mounted as capabilities: being an agent is a property of where the itx sits,
  // not something a caller provided, so a getter keeps zero durable state, needs
  // no bootstrap step, and means `env.ITX.get()` can return this one class at any
  // path with no per-scope branching. On a project-root itx both are undefined.
  /** THIS agent's control surface — present only on an agent-scoped itx (path under `/agents/`). */
  get agent(): Agent | undefined {
    const path = this.#props.capabilityHost.path;
    return path.startsWith("/agents/") ? this.agents.get(path) : undefined;
  }

  /** THIS agent's web-chat door — present only on an agent-scoped itx. */
  get chat(): AgentChat | undefined {
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
  get capabilityHost(): CapabilityHost {
    return this.#props.capabilityHost;
  }

  /**
   * Capability hosts of OTHER scopes, by path. `capabilityHosts.get("/")` is
   * the project root — providing there makes a capability visible to every
   * scope in the project (child scopes inherit ancestors' mounts).
   */
  get capabilityHosts(): CapabilityHostCollection {
    return new CapabilityHostCollectionRpcTarget({
      auth: this.#props.auth,
      ctx: this.#props.ctx,
      projectId: this.#props.projectId,
    });
  }

  /** Shortcut for `capabilityHost.provideCapability` (mounts on THIS scope). */
  provideCapability(input: ProvideCapabilityInput): Promise<CapabilityProvision> {
    return this.#props.capabilityHost.provideCapability(input);
  }

  /** Shortcut for `capabilityHost.revokeCapability`. */
  revokeCapability(input: RevokeCapabilityInput): Promise<void> {
    return this.#props.capabilityHost.revokeCapability(input);
  }

  /** Project stream catalog: get(path), list(). */
  get streams(): ProjectStreamCollection {
    return new ProjectStreamCollectionRpcTarget({
      auth: this.#props.auth,
      projectId: this.#props.projectId,
    });
  }

  /** Agent catalog: get(path), list(). */
  get agents(): AgentCollection {
    return new AgentCollectionRpcTarget({
      auth: this.#props.auth,
      ctx: this.#props.ctx,
      projectId: this.#props.projectId,
    });
  }

  /** Project-attributed outbound fetch (+ intercept). */
  get egress(): ProjectEgress {
    return new ProjectEgressRpcTarget({ projectId: this.#props.projectId });
  }

  /** Read-only catalogue of known-good itx script snippets (`list()`, `get({ id })`). */
  get examples(): ItxExampleCatalog {
    return new ItxExampleCatalogRpcTarget();
  }

  /** Slack/Google connections + the connection-scoped API proxies (`integrations.gmail`, `integrations.slack`). */
  get integrations(): ProjectIntegrations {
    return new IntegrationsRpcTarget({
      auth: this.#props.auth,
      projectId: this.#props.projectId,
    });
  }

  /** Ad-hoc MCP clients: connect(url); `itx.mcp.exa` is the built-in Exa web search. */
  get mcp(): McpClientCollection {
    return new McpClientCollectionRpcTarget({
      egress: projectEgressFetcher(this.#props.ctx.exports, this.#props.projectId),
    });
  }

  /** Ad-hoc OpenAPI clients: connect(spec). */
  get openapi(): OpenApiCollection {
    return new OpenApiCollectionRpcTarget({
      egress: projectEgressFetcher(this.#props.ctx.exports, this.#props.projectId),
    });
  }

  /** Repo catalog by path. */
  get repos(): ProjectRepoCollection {
    return new ProjectRepoCollectionRpcTarget({
      auth: this.#props.auth,
      projectId: this.#props.projectId,
    });
  }

  /** Path-addressed sandboxes (`itx.sandboxes.get("/sandboxes/cloudflare/whatever")`). */
  get sandboxes(): SandboxCollection {
    return new SandboxCollectionRpcTarget({
      auth: this.#props.auth,
      projectId: this.#props.projectId,
    });
  }

  /** Secret catalog by path. */
  get secrets(): SecretCollection {
    return new SecretCollectionRpcTarget({
      auth: this.#props.auth,
      projectId: this.#props.projectId,
    });
  }

  /** The project repo at /repos/project. */
  get repo(): Repo {
    return new RepoRpcTarget({
      auth: this.#props.auth,
      path: PROJECT_REPO_PATH,
      projectId: this.#props.projectId,
    });
  }

  /** Dynamic worker refs: get(ref). */
  get workers(): DynamicWorkerCollection {
    return new DynamicWorkerCollectionRpcTarget({
      auth: this.#props.auth,
      ctx: this.#props.ctx,
      loader: env.LOADER,
      projectId: this.#props.projectId,
    });
  }

  /** The default repo-backed project worker — a convenience alias; the general API is `workers.get(ref)`. */
  get worker(): DynamicWorkerCapability<ProjectWorker> {
    return this.workers.get<ProjectWorker>(defaultProjectWorkerRef());
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

function defaultProjectWorkerRef(): StatelessDynamicWorkerRef {
  return {
    path: "/",
    source: {
      repoPath: PROJECT_REPO_PATH,
      sourcePath: PROJECT_WORKER_SOURCE_PATH,
      type: "repo",
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
class SessionRpcTarget extends RpcTarget implements Session {
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
  get streams(): StreamCollection {
    return new StreamCollectionRpcTarget({
      auth: this.props.auth,
      projectId: null,
    });
  }

  /** Deployment-wide repos (admin only; projectId: null). */
  get repos(): RepoCollection {
    return new RepoCollectionRpcTarget({
      auth: this.props.auth,
      projectId: null,
    });
  }

  /** Project catalog: list(), get(projectId), create({ slug }) — each vends an itx. */
  get projects(): ProjectCollection {
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
export class UnauthenticatedOsRpcTarget extends RpcTarget implements UnauthenticatedOs {
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
  async authenticate(input: ItxAuthCredentials): Promise<Session> {
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
class CapabilityProvisionRpcTarget extends RpcTarget implements CapabilityProvision {
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
export class StreamSubscriptionRpcTarget extends RpcTarget implements StreamSubscriptionHandle {
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
   * Liveness probe (see `StreamSubscriptionHandle.ping` in types.ts). Captures
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
class ProjectEgressRpcTarget extends RpcTarget implements ProjectEgress {
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
export class ProjectEgressInterceptRpcTarget extends RpcTarget implements ProjectEgressIntercept {
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
  extends RpcTarget
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

class ItxExampleCatalogRpcTarget extends RpcTarget implements ItxExampleCatalog {
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
class ProcessorRelayRpcTarget<State> extends RpcTarget implements StreamProcessorRpc<State> {
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
class ProcessorStateSubscriptionRpcTarget
  extends RpcTarget
  implements ProcessorStateSubscriptionHandle
{
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

type McpClientDeps = { egress: Fetcher };

// Exa's hosted MCP server works unauthenticated (rate-limited); pre-connecting
// it gives every project web search with zero setup.
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";

class McpClientCollectionRpcTarget extends RpcTarget implements McpClientCollection {
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
    return new McpClientRpcTarget({ config: { url: EXA_MCP_URL }, egress: this.props.egress });
  }
}

class McpClientRpcTarget extends RpcTarget {
  static async connect(input: McpClientConnectInput, deps: McpClientDeps) {
    return new McpClientRpcTarget({ config: input, egress: deps.egress });
  }

  constructor(
    readonly props: {
      config: McpClientConnectInput;
      egress: Fetcher;
    },
  ) {
    super();
    return withInvokeCapabilityFallback(this);
  }

  async __describe(): Promise<Description> {
    return describeNode({
      instructions: `An ad-hoc MCP client for ${this.props.config.url} — a flattened dispatcher: any dotted call is one MCP tool invocation (\`client.someTool(input)\` calls the tool "someTool"). Tool names come from the server, not from this node; list them with the server's own discovery if it offers one.`,
      parent: "itx.mcp (connect(url), or the built-in exa)",
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
type OpenApiDeps = { egress: Fetcher };

class OpenApiCollectionRpcTarget extends RpcTarget implements OpenApiCollection {
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

class OpenApiRpcTarget extends RpcTarget {
  static async connect(input: OpenApiConnectInput, deps: OpenApiDeps) {
    const spec = await fetchSpec(input, deps.egress);
    return new OpenApiRpcTarget({
      config: input,
      egress: deps.egress,
      operations: listOpenApiOperations(spec),
      spec,
    });
  }

  constructor(
    readonly props: {
      config: OpenApiConnectInput;
      egress: Fetcher;
      operations: OpenApiOperation[];
      spec: Record<string, unknown>;
    },
  ) {
    super();
    return withInvokeCapabilityFallback(this);
  }

  async __describe(): Promise<Description> {
    return describeNode({
      instructions:
        "An ad-hoc OpenAPI client — a flat dispatcher: `client.someOperationId(input)` executes that operation against the spec's server. `children` lists the operations parsed from the spec.",
      children: Object.fromEntries(
        this.props.operations.map((operation) => [
          operation.operationId,
          `${operation.method.toUpperCase()} ${operation.path}`,
        ]),
      ),
      parent: "itx.openapi.connect(spec)",
    });
  }

  async invokeCapability({
    args = [],
    path,
  }: {
    args?: unknown[];
    path: string[];
  }): Promise<unknown> {
    const operationId = path[0];
    if (!operationId) throw new Error("OpenAPI operation calls need an operationId path.");
    if (path.length > 1) {
      throw new Error(`OpenAPI operations are flat operationIds, got "${path.join(".")}".`);
    }
    const operation = this.props.operations.find(
      (candidate) => candidate.operationId === operationId,
    );
    if (!operation) {
      throw new Error(`Operation "${operationId}" is not in the OpenAPI spec.`);
    }
    return await executeOperation({
      egress: this.props.egress,
      input: args[0],
      operation,
      props: this.props.config,
      spec: this.props.spec,
    });
  }
}

async function fetchSpec(
  props: OpenApiConnectInput,
  egress: Fetcher,
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
  egress: Fetcher;
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

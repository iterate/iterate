/**
 * Public ITX capability contract.
 *
 * `/api/itx` gives callers one unauthenticated object. Authentication returns a
 * root catalog, and every object reachable from that catalog is a Cap'n Web /
 * Workers RPC capability. Projects and agents expose stable built-ins
 * (`streams`, `repos`, `workers`, `runScript`, etc.) plus dynamic dotted
 * capabilities installed through the stream-backed ITX processor. Streams are
 * the durable coordination layer underneath those surfaces: processors,
 * project bootstrap, repo bootstrap, and agent loops all communicate by
 * appending and reducing events.
 */

// -----------------------------------------------------------------------------
// The three nouns. Keeping them distinct is what makes this system legible:
//
// - a SESSION is what `authenticate()` returns. It is a catalog that *vends*
//   itxs; it is not itself an itx.
// - a PROJECT is the tenant / isolation boundary — a `prj_…` id, its Durable
//   Objects, its streams. You never hold a "project object"; you hold an itx
//   scoped into a project.
// - an ITX is a capability context scoped into one project at one path. It is
//   the `itx` in every `async (itx) => { … }` script and what `env.ITX.get()`
//   returns. `session.projects.get(id)` gives you the itx at the project root;
//   a nested scope (`/agents/bla`) is the SAME type at a deeper path.
// -----------------------------------------------------------------------------

/**
 * Entry point exposed before any principal or project authority is known.
 *
 * `/api/itx` hands every caller one of these; the only thing it can do is
 * `authenticate(...)`, which on success returns a {@link Session}. This is the
 * canonical Cap'n Web pattern: authority cannot be forged, only handed back by a
 * method that already checked you.
 */
export interface UnauthenticatedItx {
  authenticate(input: ItxAuthCredentials): Session;
}

/**
 * What you authenticate into: a catalog that vends itxs.
 *
 * A session is NOT an itx — it is the directory you use to reach one.
 * `projects` is principal-scoped. `streams` and `repos` here are the
 * deployment-wide surfaces backed by `projectId: null`, so only admin/internal
 * auth can reach them.
 */
export interface Session {
  projects: ProjectCollection;
  repos: RepoCollection;
  streams: StreamCollection;
  whoami(): string;
}

/** Catalog of projects reachable from a {@link Session}. */
export interface ProjectCollection {
  get(projectId: string): Itx;
  create(args: { projectId?: string; slug: string }): Promise<Itx>;
  list(): string[];
}

/**
 * An **itx**: a capability context scoped into one project at one path.
 *
 * The same interface serves the project root (`itxPath: "/"`) and every nested
 * scope (`/agents/bla`, `/agents/slack/ts-124`, …). A nested scope is not a
 * different type — it exposes all the project built-ins below PLUS the dynamic
 * capabilities mounted on its own scope and inherited from every enclosing scope
 * (resolution chains child → parent → project; a nearer scope shadows a farther
 * one). `agent`/`chat` are present only when the scope sits under `/agents/`.
 *
 * DESIGN NOTE — why the built-ins are explicit members, not dynamic entries:
 * this object is an RpcTarget that sits *in front of* the ITX Durable Object. A
 * call like `itx.streams.get("/x")` resolves against these known members in the
 * isolate and never touches the ITX DO, so the hot path pays no extra round trip
 * to check whether `streams` was shadowed. The deliberate trade-off is that a
 * dynamic capability therefore CANNOT shadow a built-in name — the built-in
 * always wins. If shadowable built-ins turn out to be needed often, we'd move
 * resolution behind the DO and accept the round trip; today we don't.
 */
export interface Itx extends ItxCapabilityHost {
  ai: Ai;
  agents: AgentCollection;
  describe(): Promise<ProjectDescription>;
  egress: ProjectEgress;
  mcp: McpClientCollection;
  openapi: OpenApiCollection;
  processor: StreamProcessorRpc<ProjectProcessorState>;
  repo: Repo;
  repos: ProjectRepoCollection;
  secrets: SecretCollection;
  streams: ProjectStreamCollection;
  worker: ProjectWorker;
  workers: DynamicWorkerCollection;
  // Present only on an agent-scoped itx (path under `/agents/`). `agent` is this
  // agent's own control surface; `chat` is its web-chat door. They are getters
  // derived from the scope path, not mounted capabilities — see rpc-targets.ts.
  agent?: Agent;
  chat?: AgentChat;
}

/** Agent-local web chat response tool exposed inside agent script execution. */
export interface AgentChat {
  sendMessage(input: { message: string }): Promise<StreamEvent>;
}

/** Workers AI binding exposed through ITX as a project/agent capability. */
export interface Ai {
  models(): Promise<unknown>;
  run(model: string, body: unknown): Promise<unknown>;
}

/** Agent catalog within one project. */
export interface AgentCollection {
  get(path: string): Agent;
  list(): Promise<StreamListItem[]>;
}

/** Agent capability surface for message loops and agent-local dynamic tools. */
export interface Agent extends ItxCapabilityHost {
  chat: AgentChat;
  processor: StreamProcessorRpc<AgentProcessorState>;
  stream: Stream;
  sendMessage(message: string): Promise<StreamEvent>;
  ask(input: { message: string }): Promise<StreamEvent>;
  whoami(): string;
}

/** Stream catalog for either a project or the deployment-wide global scope. */
export interface StreamCollection {
  get(path: string): Stream;
}

/** Project-scoped stream catalog with reduced-state listing. */
export interface ProjectStreamCollection extends StreamCollection {
  list(): Promise<StreamListItem[]>;
}

/**
 * Durable event stream capability.
 *
 * Streams are the public coordination primitive, not an internal queue hidden
 * behind domain methods. Domain helpers can construct common event shapes, but
 * callers and processors still work with explicit events.
 */
export interface Stream {
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
  at(path: string): Stream;
  getEvent(
    input: { offset: number; idempotencyKey?: never } | { idempotencyKey: string; offset?: never },
  ): Promise<StreamEvent | undefined>;
  getEvents(input?: {
    afterOffset?: number;
    beforeOffset?: number | null;
    limit?: number;
  }): Promise<StreamEvent[]>;
  waitForEvent(input: {
    afterOffset?: number;
    eventTypes?: readonly string[];
    predicate?: (event: StreamEvent) => boolean | Promise<boolean>;
    timeoutMs: number;
  }): Promise<StreamEvent>;
  getProcessorRuntimeState(input: {
    subscriptionKey: string;
  }): Promise<ProcessorRuntimeState | null>;
  runtimeState(): Promise<{
    coreProcessorState: unknown;
    runtime: {
      connections: Record<string, unknown>;
    };
  }>;
  subscribe(input: {
    subscriptionKey?: string;
    processEventBatch: ProcessEventBatch;
    replayAfterOffset?: number;
    eventTypes?: readonly string[];
    events?: boolean;
    subscriber?: unknown;
  }): Promise<StreamSubscriptionHandle>;
}

/** Repo catalog for either a project or the deployment-wide global scope. */
export interface RepoCollection {
  create(input: { path: string }): Promise<Repo>;
  get(path: string): Repo;
}

/** Project-scoped repo catalog with reduced-state listing. */
export interface ProjectRepoCollection extends RepoCollection {
  list(): Promise<StreamListItem[]>;
}

/** Git-backed repo capability used by project workers and dynamic worker refs. */
export interface Repo {
  commitFiles(input: CommitRepoFilesInput): Promise<CommitRepoFilesResult>;
  create(): Promise<Repo>;
  processor: StreamProcessorRpc<RepoProcessorState>;
  whoami(): Promise<string>;
}

/** Secret catalog within one project. */
export interface SecretCollection {
  get(path: string): Secret;
  list(): Promise<StreamListItem[]>;
}

/** Path-addressed secret capability. Secret material has no public read API. */
export interface Secret {
  describe(): Promise<SecretDescription>;
  fetch(req: Request): Promise<Response>;
  processor: StreamProcessorRpc<SecretProcessorState>;
  update(input: SecretUpdateInput): Promise<StreamEvent>;
}

export type SecretUpdateInput = {
  egress?: { urls: string[] };
  material?: string;
};

export type SecretDescription = {
  audit: {
    lastUsedAt?: string;
    lastUsedBy?: string;
    lastUsedUrl?: string;
    usedCount: number;
  };
  egress: { urls: string[] };
  hasMaterial: boolean;
};

export type StreamListItem = {
  createdAt: string;
  path: string;
};

export type ProjectProcessorState = {
  agents: StreamListItem[];
  createRequest: { projectId: string; slug: string } | null;
  created: boolean;
  repos: StreamListItem[];
  secrets: StreamListItem[];
  streams: StreamListItem[];
};

export type AgentProcessorState = {
  currentRequest:
    | { phase: "scheduled"; requestId: string; scheduledOffset: number }
    | { phase: "requested"; llmRequestId: number }
    | null;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  llmConfig: { model: string };
  llmProvider: "cloudflare-ai";
  pendingTriggerOffset: number | null;
  scriptExecutionsCompleted: string[];
  systemPrompt: string;
};

export type RepoProcessorState = {
  artifactName: string | null;
  created: boolean;
  defaultBranch: string | null;
  initialized: boolean;
  remote: string | null;
};

export type SecretProcessorState = {
  audit: {
    lastUsedAt?: string;
    lastUsedBy?: string;
    lastUsedUrl?: string;
    usedCount: number;
  };
  egress: { urls: string[] };
  encryptedMaterial: {
    algorithm: "AES-GCM-SHA256";
    ciphertext: string;
    iv: string;
  } | null;
};

export type ProcessorSnapshot<State> = {
  offset: number;
  state: State;
};

export interface StreamProcessorRpc<State = unknown> {
  getRuntimeState(): Promise<ProcessorRuntimeState<State>>;
  onStateChange(cb: (state: State) => unknown): Promise<(() => void) & Disposable>;
  snapshot(): Promise<ProcessorSnapshot<State>>;
  waitUntilEvent(input: { offset: number; timeoutMs?: number }): Promise<void>;
}

/** Capability-tree entry point for ad-hoc project-scoped worker refs. */
export interface DynamicWorkerCollection {
  get<T extends object = Record<string, unknown>>(
    ref: DynamicWorkerRef,
  ): DynamicWorkerCapability<T>;
}

/*
 * A project can make outbound HTTPS calls, substituting its real secrets into
 * them at the last moment. A client can install ONE of two live egress modes,
 * and they differ in exactly one thing — how much of the traffic it may see:
 *
 *   intercept()           MITM. The client is handed the outbound Request
 *                         *before* substitution, so it sees getSecret(...)
 *                         placeholders (never real material) and may inspect,
 *                         rewrite, or answer it.
 *
 *   useEgressHttpsProxy() non-MITM. The client only dials TCP and shuttles
 *                         opaque TLS records. The worker substitutes the secret
 *                         and terminates TLS itself, so the proxy sees the target
 *                         host/port but never the request, body, or secret — the
 *                         real token leaves from the proxy's IP as ciphertext.
 */

/** intercept() callback. Runs pre-substitution, so it only ever sees getSecret(...) placeholders. */
export type ProjectEgressInterceptor = (req: Request) => Promise<Response>;

/** Where the proxy should open a TCP connection. */
export interface EgressHttpsProxyDial {
  host: string;
  port: number;
}

/** A raw, bidirectional TCP byte stream the worker runs its TLS client over. */
export interface EgressHttpsProxyConnection {
  read(): Promise<Uint8Array | null>;
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/**
 * A client-provided, non-MITM egress proxy: it only opens TCP sockets and moves
 * opaque TLS records. It must never receive a materialized Request or Response.
 */
export interface EgressHttpsProxy {
  dial(input: EgressHttpsProxyDial): Promise<EgressHttpsProxyConnection>;
}

/** Disposable handle for one installed egress mode (intercept or proxy). */
export interface ProjectEgressHandle extends Disposable {
  release(): Promise<void>;
}

/**
 * Project-owned egress facet.
 *
 * `fetch` is the one outbound door: explicit RPC egress and a dynamic worker's
 * bare `fetch()` both flow through it (via the WorkerEntrypoint gateway), so a
 * single decision point in the Project Durable Object governs all egress.
 *
 * `intercept` / `useEgressHttpsProxy` install one live mode (last writer wins);
 * releasing or disposing the returned handle clears only the mode it installed,
 * and only if it is still current.
 */
export interface ProjectEgress {
  fetch(req: Request): Promise<Response>;
  intercept(handler: ProjectEgressInterceptor): Promise<ProjectEgressHandle>;
  useEgressHttpsProxy(proxy: EgressHttpsProxy): Promise<ProjectEgressHandle>;
}

export type ProjectDescription = {
  capabilities: CapabilityDescription[];
  name: string;
  projectId: string;
};

export type CapabilityDescription = {
  instructions?: string;
  path: string[];
  providedAtOffset?: number;
  /**
   * The itx scope path this capability is declared at (`"/"`, `"/agents/bla"`, …).
   * Set when a scope reports capabilities it inherited from an enclosing scope,
   * so the reader can tell a local mount from an inherited one. Absent on
   * built-ins (they exist at every scope).
   */
  scope?: string;
  type: "builtin" | "live" | "itx-expression";
  types?: string;
};

export interface OpenApiCollection {
  connect(input: OpenApiConnectInput): Promise<OpenApiRpc>;
}

export type OpenApiConnectInput = {
  baseUrl?: string;
  headers?: Record<string, string>;
  specUrl: string;
};

export type OpenApiRpc = object;

export interface McpClientCollection {
  connect(input: McpClientConnectInput): Promise<McpClientRpc>;
}

export type McpClientConnectInput = {
  headers?: Record<string, string>;
  timeoutMs?: number;
  url: string;
};

export type McpClientRpc = object;

/**
 * Shared host operations for objects that can own dynamic ITX capabilities.
 *
 * Project and agent targets both delegate these to their scoped ITX Durable
 * Object, so scripts and mounted tools use the same shape in either context.
 */
export interface ItxCapabilityHost {
  runScript(code: string): Promise<{
    completedEvent: StreamEvent;
    executionId: string;
    result: unknown;
  }>;
  provideCapability(input: ProvideCapabilityInput): Promise<CapabilityProvision>;
  revokeCapability(input: RevokeCapabilityInput): Promise<void>;
}

/**
 * Ownership handle for one mounted capability.
 *
 * The offset identifies the exact `capability-provided` event, which lets
 * disposal or explicit revoke remove this mount without racing a newer mount at
 * the same path.
 */
export interface CapabilityProvision extends Disposable {
  readonly path: string[];
  readonly providedAtOffset: number;
  revoke(): Promise<void>;
}

/** Append input before the stream assigns offset and timestamp. */
export type StreamEventSource = {
  processor?: {
    slug: string;
    version: string;
  };
  crossPost?: {
    ruleId: string;
    from: {
      createdAt: string;
      offset: number;
      path: string;
      projectId: string | null;
      type: string;
    };
  };
};

export type StreamEventInput = {
  type: string;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  source?: StreamEventSource;
  idempotencyKey?: string;
};

/** Durable stream event after commit. */
export type StreamEvent = StreamEventInput & {
  createdAt: string;
  offset: number;
};

/** Stable identity for one stream subscription connection. */
export type SubscriptionKey = string;

/**
 * Batch delivered to stream processors and live subscribers.
 *
 * Kept named because callback retention, processor hosts, and tests all depend
 * on the same cross-RPC batch envelope.
 */
export type StreamEventBatch = {
  projectId: string | null;
  path: string;
  events: StreamEvent[];
  streamMaxOffset: number;
  state: unknown;
};

/**
 * Callback invoked by the stream pump for each delivered batch.
 *
 * It stays as a named type because Workers RPC callback lifecycle helpers need
 * to duplicate, retain, and dispose exactly this callback shape.
 */
export type ProcessEventBatch = (batch: StreamEventBatch) => unknown;

/** Serializable snapshot plus optional live runtime debug state for a processor. */
export type ProcessorRuntimeState<State = unknown> = {
  snapshot: { offset: number; state: State };
  runtime?: Record<string, unknown>;
};

/**
 * Optional runtime-state callback exposed by a hosted processor.
 *
 * It accepts sync or async implementations because local processors can return
 * immediately, while RPC-backed processors may need an async round trip.
 */
export type GetProcessorRuntimeState = () => ProcessorRuntimeState | Promise<ProcessorRuntimeState>;

/** Live subscription handle returned by `Stream.subscribe`. */
export type StreamSubscriptionHandle = Disposable & {
  subscriptionKey: SubscriptionKey;
  streamMaxOffset: number;
  unsubscribe(): void;
};

/**
 * One repo file mutation.
 *
 * Kept named because public `Repo.commitFiles`, input parsing, and artifact
 * commit implementation all validate the same command shape.
 */
export type RepoFileChange =
  | {
      path: string;
      content: string;
    }
  | {
      path: string;
      delete: true;
    };

/** Command object for committing a batch of repo file mutations. */
export type CommitRepoFilesInput = {
  author?: { email: string; name: string };
  branch?: string;
  changes: RepoFileChange[];
  message: string;
};

/** Result returned after a repo commit attempt, including no-op commits. */
export type CommitRepoFilesResult = {
  branch: string;
  changedPaths: string[];
  commitOid: string;
  noChanges: boolean;
};

/** Dynamic invocation envelope used by flattened live capabilities. */
export type FlattenedCapabilityInvocation = {
  args: unknown[];
  flattenNestedPath?: boolean;
  path: string[];
};

/** Target shape for a live capability that wants to receive flattened paths. */
export type FlattenedCapabilityTarget = {
  invokeCapability(input: FlattenedCapabilityInvocation): unknown;
};

/** Durable expression over the project ITX surface. */
export type ItxExpressionStep = string | [method: string, ...args: unknown[]];
export type ItxExpression = ItxExpressionStep[];

/** Capability recipe accepted by `provideCapability`. */
export type ProvideCapabilityInput =
  | {
      capability: unknown;
      flattenNestedPaths?: false;
      instructions?: string;
      path: string[];
      type: "live";
      types?: string;
    }
  | {
      capability: FlattenedCapabilityTarget;
      flattenNestedPaths: true;
      instructions?: string;
      path: string[];
      type: "live";
      types?: string;
    }
  | {
      expression: ItxExpression;
      flattenNestedPaths?: boolean;
      instructions?: string;
      path: string[];
      type: "itx-expression";
      types?: string;
    };

/** Event payload stored when a capability is mounted on an ITX stream. */
export type CapabilityProvidedPayload =
  | {
      flattenNestedPaths?: boolean;
      instructions?: string;
      path: string[];
      type: "live";
      types?: string;
    }
  | {
      expression: ItxExpression;
      flattenNestedPaths?: boolean;
      instructions?: string;
      path: string[];
      type: "itx-expression";
      types?: string;
    };

/** Reduced capability table row: payload plus the providing event offset. */
export type CapabilityRecord = CapabilityProvidedPayload & {
  providedAtOffset: number;
};

/** Revoke command for the current mount at a path or one exact mount offset. */
export type RevokeCapabilityInput = {
  path: string[];
  providedAtOffset?: number;
};

/** Credentials accepted by `UnauthenticatedItx.authenticate`. */
export type ItxAuthCredentials =
  | { type: "from-server-cookie" }
  | { type: "token"; token: ItxAuthToken }
  | { type: "trusted-internal"; token: string };

/** Minimal fake token model used by the reference worker. */
export type ItxAuthToken =
  | { type: "admin"; principal?: string }
  | { type: "user"; principal: string; projectScopes: string[] };

/** Authority object carried by server-side RPC target instances. */
export interface ItxAuth {
  readonly principal: string;
  isAdmin(): boolean;
  canAccessProject(projectId: string): boolean;
  assertCanAccessProject(projectId: string | null): void;
  listAccessibleProjects(): string[];
}

/**
 * Declarative source for a dynamic worker.
 *
 * `inline` is the simplest execution primitive: the caller already has module
 * text and asks the Worker Loader to run it. `repo` keeps source identity
 * separate from runtime identity; the repo resolves the current worker source
 * and contributes its own cache key, so future repo commits affect the next use.
 */
export type DynamicWorkerSource =
  | {
      type: "inline";
      mainModule: string;
      modules: Record<string, string>;
    }
  | {
      type: "repo";
      repoPath: string;
      sourcePath: string;
    };

type DynamicWorkerRefBase = {
  /**
   * ITX scope path for the worker's `env.ITX` binding and for stateful worker
   * Durable Object names. This is intentionally not the mounted capability path:
   * one worker can be mounted at `db`, `counter`, etc. while all events still
   * belong to the host stream path.
   */
  path: string;
  source: DynamicWorkerSource;
};

/**
 * Stateless workers are WorkerEntrypoint exports loaded directly from source.
 *
 * `props` are passed to `worker.getEntrypoint(name, { props })` and appear as
 * `this.ctx.props` inside the exported WorkerEntrypoint. They deliberately live
 * only on stateless refs: Durable Object facets are started with
 * `ctx.facets.get(name, () => ({ class, id? }))`, which does not accept
 * WorkerEntrypoint-style props.
 */
export type StatelessDynamicWorkerRef = DynamicWorkerRefBase & {
  type: "stateless";
  entrypoint?: string;
  props?: Record<string, JsonValue>;
};

/**
 * Stateful workers are Durable Object class exports hosted by
 * `StatefulWorkerDurableObject`.
 *
 * `durableWorkerKey` is the durable identity under `{ projectId, path }`. It is
 * not a source cache key: source changes deliberately affect the next use of the
 * same durable worker identity.
 */
export type StatefulDynamicWorkerRef = DynamicWorkerRefBase & {
  type: "stateful";
  className: string;
  durableWorkerKey: string;
};

/** Worker recipe accepted by `workers.get` and worker-backed capabilities. */
export type DynamicWorkerRef = StatelessDynamicWorkerRef | StatefulDynamicWorkerRef;

/** Dynamic worker RPC stub plus the disposal operation owned by the caller. */
export type DynamicWorkerCapability<T extends object = Record<string, unknown>> = T & Disposable;

/**
 * Default seeded project worker contract.
 *
 * This documents the reference repo's `worker.js` only. Arbitrary dynamic
 * workers should be typed by callers through `workers.get<T>(ref)`.
 */
export interface ProjectWorker {
  fetch(req: Request): Promise<Response>;
  processEvent(input: { event: StreamEvent }): Promise<void>;
  testFetch(input: { headerValue: string; url: string }): Promise<unknown>;
}

/** JSON subset accepted by WorkerEntrypoint props and script results. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Minimal ExecutionContext shape the RPC adapter layer needs.
 *
 * This stays at the bottom because it is server-side plumbing, not part of the
 * client-facing ITX contract. It is exported only so domain hosts can inject
 * project/agent capability targets without importing the full worker module.
 */
export type CfExecutionContext = {
  exports: ExecutionContext["exports"];
  waitUntil?: ExecutionContext["waitUntil"];
};

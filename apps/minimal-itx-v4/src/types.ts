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

/** Entry point exposed before any principal or project authority is known. */
export interface UnauthenticatedItx {
  authenticate(input: ItxAuthCredentials): ItxRoot;
}

/**
 * Authenticated root catalog.
 *
 * `projects` is project-scoped. `streams` and `repos` are deployment-wide
 * surfaces backed by `projectId: null`, so only admin/internal auth should be
 * able to reach them.
 */
export interface ItxRoot {
  projects: ProjectCollection;
  repos: RepoCollection;
  streams: StreamCollection;
  whoami(): string;
}

/** Project catalog visible from the authenticated root. */
export interface ProjectCollection {
  get(projectId: string): Project;
  create(args: { projectId?: string; slug: string }): Promise<Project>;
  list(): string[];
}

/**
 * Project capability surface.
 *
 * The built-ins are deliberately explicit so user-provided dynamic
 * capabilities cannot shadow core project operations.
 */
export interface Project extends ItxCapabilityHost {
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
}

/**
 * Agent-scoped ITX is still project-scoped ITX.
 *
 * Project capabilities stay at the root so code can move between project and
 * agent contexts; the narrower agent-local surface hangs under `.agent`.
 */
export interface AgentItx extends Project {
  agent: Agent;
  chat: AgentChat;
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

/** Live replacement for project egress. It sees getSecret(...) placeholders, never material. */
export type ProjectEgressInterceptor = (req: Request) => Promise<Response>;

/** Disposable handle for one live project egress interception. */
export interface ProjectEgressIntercept extends Disposable {
  release(): Promise<void>;
}

/**
 * Project-owned egress facet.
 *
 * `fetch` is the explicit outbound door. Dynamic workers' bare `fetch()` uses
 * the same project egress path through the WorkerEntrypoint gateway.
 *
 * `intercept` installs one live runtime replacement on the Project Durable
 * Object. Last writer wins; disposing or releasing the handle clears only the
 * interceptor it installed if it is still current.
 */
export interface ProjectEgress {
  fetch(req: Request): Promise<Response>;
  intercept(handler: ProjectEgressInterceptor): Promise<ProjectEgressIntercept>;
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

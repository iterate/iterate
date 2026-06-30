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
  agents: AgentCollection;
  describe(): Promise<{ projectId: string; name: string }>;
  egress: ProjectEgress;
  repo: Repo;
  repos: RepoCollection;
  streams: StreamCollection;
  worker: ProjectWorker;
  workers: WorkerCollection;
}

/**
 * Agent-scoped ITX is still project-scoped ITX.
 *
 * Project capabilities stay at the root so code can move between project and
 * agent contexts; the narrower agent-local surface hangs under `.agent`.
 */
export interface AgentItx extends Project {
  agent: Agent;
}

/** Agent catalog within one project. */
export interface AgentCollection {
  create(input: { path: string }): Promise<StreamEvent>;
  get(path: string): Agent;
}

/** Agent capability surface for message loops and agent-local dynamic tools. */
export interface Agent extends ItxCapabilityHost {
  stream: Stream;
  create(): Promise<StreamEvent>;
  sendMessage(message: string): Promise<StreamEvent>;
  ask(input: { message: string }): Promise<StreamEvent>;
  whoami(): string;
}

/** Stream catalog for either a project or the deployment-wide global scope. */
export interface StreamCollection {
  get(path: string): Stream;
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

/** Git-backed repo capability used by project workers and dynamic worker refs. */
export interface Repo {
  commitFiles(input: CommitRepoFilesInput): Promise<CommitRepoFilesResult>;
  create(): Promise<Repo>;
  whoami(): Promise<string>;
}

/** Capability-tree entry point for ad-hoc project-scoped worker refs. */
export interface WorkerCollection {
  get<T extends object = Record<string, unknown>>(ref: WorkerRef): WorkerCapability<T>;
}

/** Project-owned egress fetcher used by dynamic workers and explicit callers. */
export interface ProjectEgress {
  fetch(req: Request): Promise<Response>;
}

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
  provideCapability(input: {
    path: string[];
    capability: ProvidedCapability;
  }): Promise<CapabilityProvision>;
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
export type StreamEventInput = {
  type: string;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  source?: {
    processor?: {
      slug: string;
      version: string;
    };
  };
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
export type ProcessorRuntimeState = {
  snapshot: { offset: number; state: unknown };
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

/**
 * Capability recipe accepted by `provideCapability`.
 *
 * Live targets are retained in the current ITX Durable Object incarnation.
 * Worker targets are durable recipes and load only when invoked.
 */
export type ProvidedCapability =
  | { flattenNestedPath?: false; target: unknown; type: "live" }
  | { flattenNestedPath: true; target: FlattenedCapabilityTarget; type: "live" }
  | { flattenNestedPath?: boolean; type: "worker"; workerRef: WorkerRef };

/** Event payload stored when a capability is mounted on an ITX stream. */
export type CapabilityProvidedPayload =
  | {
      flattenNestedPath?: boolean;
      type: "live";
      path: string[];
    }
  | {
      flattenNestedPath?: boolean;
      type: "worker";
      path: string[];
      workerRef: WorkerRef;
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
export type WorkerSource =
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

type WorkerRefBase = {
  /**
   * ITX scope path for the worker's `env.ITX` binding and for stateful worker
   * Durable Object names. This is intentionally not the mounted capability path:
   * one worker can be mounted at `db`, `counter`, etc. while all events still
   * belong to the host stream path.
   */
  path: string;
  source: WorkerSource;
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
export type StatelessWorkerRef = WorkerRefBase & {
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
export type StatefulWorkerRef = WorkerRefBase & {
  type: "stateful";
  className: string;
  durableWorkerKey: string;
};

/** Worker recipe accepted by `workers.get` and worker-backed capabilities. */
export type WorkerRef = StatelessWorkerRef | StatefulWorkerRef;

/** Dynamic worker RPC stub plus the disposal operation owned by the caller. */
export type WorkerCapability<T extends object = Record<string, unknown>> = T & Disposable;

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

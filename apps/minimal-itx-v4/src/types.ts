// [[ There should be a comment at the top of this file explaining the whole system in a nutshell ]]

// [[ Bottom of file! ]]

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// [[ This worker stuff is decent and well commented but should be further down the file ]]

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

export type WorkerRef = StatelessWorkerRef | StatefulWorkerRef;

export type WorkerCapability<T extends object = Record<string, unknown>> = T & Disposable;

/** Capability-tree entry point for ad-hoc project-scoped worker refs. */
export interface WorkerCollection {
  get<T extends object = Record<string, unknown>>(ref: WorkerRef): WorkerCapability<T>;
}

// [[ Needs docstrings - should be relatively close to top of file ]]
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
  getProcessorRuntimeState(input: { subscriptionKey: string }): Promise<{
    snapshot: {
      offset: number;
      state: unknown;
    };
    runtime?: Record<string, unknown>;
  } | null>;
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

export interface StreamCollection {
  get(path: string): Stream;
}

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

export type StreamEvent = StreamEventInput & {
  createdAt: string;
  offset: number;
};

export type SubscriptionKey = string;

export type StreamEventBatch = {
  projectId: string | null;
  path: string;
  events: StreamEvent[];
  streamMaxOffset: number;
  state: unknown;
};

// [[ Why is this a named type and not inline? Also bad type name ]]
export type ProcessEventBatch = (batch: StreamEventBatch) => unknown;

// [[ Why is this a named type and not inline? ]]
export type ProcessorRuntimeState = {
  snapshot: { offset: number; state: unknown };
  runtime?: Record<string, unknown>;
};

// [[ A bit of a smell that this is | Promise ]]
// [[ Why is this a named type and not inline? ]]
export type GetProcessorRuntimeState = () => ProcessorRuntimeState | Promise<ProcessorRuntimeState>;

export type StreamSubscriptionHandle = Disposable & {
  subscriptionKey: SubscriptionKey;
  streamMaxOffset: number;
  unsubscribe(): void;
};

// [[ Why is this a named type and not inline? ]]
export type RepoFileChange =
  | {
      path: string;
      content: string;
    }
  | {
      path: string;
      delete: true;
    };

// [[ Why is this a named type and not inline? ]]
export type CommitRepoFilesInput = {
  author?: { email: string; name: string };
  branch?: string;
  changes: RepoFileChange[];
  message: string;
};

// [[ Why is this a named type and not inline? ]]
export type CommitRepoFilesResult = {
  branch: string;
  changedPaths: string[];
  commitOid: string;
  noChanges: boolean;
};

export interface Repo {
  commitFiles(input: CommitRepoFilesInput): Promise<CommitRepoFilesResult>;
  create(): Promise<Repo>;
  whoami(): Promise<string>;
}

export interface RepoCollection {
  create(input: { path: string }): Promise<Repo>;
  get(path: string): Repo;
}

// [[ Why are we dragging this around here? where is it used? Seems a little messy - should if anything be at very bottom and well commented ]]
export type CfExecutionContext = {
  exports: ExecutionContext["exports"];
  waitUntil?: ExecutionContext["waitUntil"];
};

// [[ Should be at top of file... ]]
export interface UnauthenticatedItx {
  authenticate(input: ItxAuthCredentials): ItxRoot;
}

// [[ ... and followed directly by this and then ProjectCollection ]]
// [[ Needs to gain StreamCollection (which can even access "global" streams with projectId null) and RepoCollection (which can also access "global" repos with projectId null) ]]
export interface ItxRoot {
  projects: ProjectCollection;
  repos: RepoCollection;
  streams: StreamCollection;
  whoami(): string;
}

/**
 * Agent-scoped workers still run inside a project. Keep project capabilities at
 * the root so code can move between project and agent contexts, and hang the
 * narrower agent surface under `.agent` for agent-local stream/messages/tools.
 */
export interface AgentItx extends Project {
  agent: Agent;
}

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

// [[ Needs docstring - in general they ALL do ]]
export interface CapabilityProvision extends Disposable {
  readonly path: string[];
  readonly providedAtOffset: number;
  revoke(): Promise<void>;
}

export type FlattenedCapabilityInvocation = {
  args: unknown[];
  path: string[];
};

export type FlattenedCapabilityTarget = {
  invokeCapability(input: FlattenedCapabilityInvocation): unknown;
};

export type ProvidedCapability =
  | { flattenNestedPath?: false; target: unknown; type: "live" }
  | { flattenNestedPath: true; target: FlattenedCapabilityTarget; type: "live" }
  | { flattenNestedPath?: boolean; type: "worker"; workerRef: WorkerRef };

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

export type CapabilityRecord = CapabilityProvidedPayload & {
  providedAtOffset: number;
};

export type RevokeCapabilityInput = {
  path: string[];
  providedAtOffset?: number;
};

export type ItxAuthCredentials =
  | { type: "from-server-cookie" }
  | { type: "token"; token: ItxAuthToken }
  | { type: "trusted-internal"; token: string };

export type ItxAuthToken =
  | { type: "admin"; principal?: string }
  | { type: "user"; principal: string; projectScopes: string[] };

export interface ItxAuth {
  readonly principal: string;
  isAdmin(): boolean;
  canAccessProject(projectId: string): boolean;
  assertCanAccessProject(projectId: string | null): void;
  listAccessibleProjects(): string[];
}

export interface Agent extends ItxCapabilityHost {
  stream: Stream;
  create(): Promise<StreamEvent>;
  sendMessage(message: string): Promise<StreamEvent>;
  ask(input: { message: string }): Promise<StreamEvent>;
  whoami(): string;
}

export interface AgentCollection {
  create(input: { path: string }): Promise<StreamEvent>;
  get(path: string): Agent;
}

// [[ I think instead of extends ItxCapabilityHost, we can just inline it here and  ]]
export interface Project extends ItxCapabilityHost {
  streams: StreamCollection;
  describe(): Promise<{ projectId: string; name: string }>;
  agents: AgentCollection;
  egress: ProjectEgress;
  repos: RepoCollection;
  repo: Repo;
  worker: ProjectWorker;
  workers: WorkerCollection;
}

export interface ProjectCollection {
  get(projectId: string): Project;
  create(args: { projectId?: string; slug: string }): Promise<Project>;
  list(): string[];
}

// [[ Not sure this belongs here - it just happens to be the shape of worker.js right now but obvs it is user-defined ]]
export interface ProjectWorker {
  fetch(req: Request): Promise<Response>;
  processEvent(input: { event: StreamEvent }): Promise<void>;
  testFetch(input: { headerValue: string; url: string }): Promise<unknown>;
}

export interface ProjectEgress {
  fetch(req: Request): Promise<Response>;
}

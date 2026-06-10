import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { WorkerShape } from "@valtown/codemirror-ts/worker";

export type ItxReplTypeScriptWorker = WorkerShape & {
  getAutocompletionWithDocs(input: {
    context: Pick<CompletionContext, "explicit" | "pos">;
    path: string;
  }): Promise<CompletionResult | null>;
};

// Ambient declarations for REPL autocomplete. This is the itx surface as the
// editor sees it; TypeScript uses these JSDoc comments for autocomplete detail
// and hover text in the browser REPL.
export const itxReplDeclaration = `
declare class RpcTarget {}

type JsonRecord = Record<string, unknown>;

/**
 * Anything not declared here resolves through the capability fallthrough.
 *
 * Capability property access accumulates a path locally, then the terminal
 * call dispatches once: \`itx.slack.chat.postMessage(...)\`.
 */
type CapSurface = {
  (...args: any[]): Promise<unknown>;
  [segment: string]: CapSurface;
};

interface ProjectSummary {
  id: string;
  slug: string;
  customHostname?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

/**
 * Narrowing lives here: \`get()\` checks the principal's grants and returns a
 * new project-scoped handle.
 */
interface ItxProjects {
  /** Admin principals only: create a project and return its summary. */
  create(input: { id?: string; slug: string }): Promise<ProjectSummary>;
  /**
   * Narrow to a project. There is no separate "project object"; the returned
   * handle is an itx scoped to that project.
   */
  get(projectIdOrSlug: string): Promise<Itx>;
  /** List the projects this handle may see. */
  list(input?: { limit?: number; offset?: number }): Promise<{ projects: ProjectSummary[]; total: number }>;
  /** Admin principals only: remove a project by id. */
  remove(input: { id: string }): Promise<{ ok: true; id: string; deleted: boolean }>;
}

/** A registry entry as reported by \`describe()\`. Never contains live stubs. */
interface CapDescription {
  name: string;
  /** The target's kind: "live" | "rpc" | "url". */
  kind: "live" | "rpc" | "url";
  /** How the target is invoked once resolved. */
  invoke: "members" | "path-call";
  /** Which context owns the entry; provenance for shadowing visibility. */
  owner: string;
  /** Live caps only: is the provider currently connected? */
  connected?: boolean;
  /** Lifted from meta for convenience: the one thing to read first. */
  instructions?: string;
  meta?: JsonRecord;
  updatedAtMs?: number;
}

/**
 * Stored source for a dynamic worker capability. The platform materializes it
 * into an isolate on demand.
 */
interface CapSource {
  /** Cache key for the materialized isolate; change it whenever modules change. */
  cacheKey: string;
  mainModule: string;
  modules: Record<string, string>;
  /** Named export to load; defaults to the default export. */
  entrypoint?: string;
  /** Whether the entrypoint is stateless or a stateful Durable Object export. */
  exportType?: "worker-entrypoint" | "durable-object";
  compatibilityDate?: string;
}

/**
 * Where an rpc target's worker lives. First-party and user-space code use the
 * same shape; only the ref type differs.
 */
type WorkerRef =
  /** A service/env binding such as AI; without an entrypoint, the binding itself is the target. */
  | { type: "binding"; binding: string }
  /** The platform worker's own exports, such as McpClient, ProjectWorker, or policy wrappers. */
  | { type: "loopback" }
  /** A Durable Object addressed by namespace binding and instance name. */
  | { type: "durable-object"; binding: string; name: string }
  /** A dynamic worker materialized from stored source. */
  | { type: "source"; source: CapSource };

/**
 * The capability target. Live targets are session-bound; rpc/url targets are
 * durable refs that the registry restores to live objects on demand.
 */
type CapTarget =
  | { type: "live"; stub: object }
  | {
      type: "rpc";
      worker: WorkerRef;
      /** Named export to use; defaults to the worker's default export or binding object. */
      entrypoint?: string;
      /** Serializable entrypoint parameterization; the registry adds context/cap attribution. */
      props?: JsonRecord;
    }
  | {
      type: "url";
      url: string;
      /** Sent on connect; values pass through project egress secret substitution. */
      headers?: Record<string, string>;
    };

type CapInvoke = "members" | "path-call";

type CapMeta = {
  /** Shown in describe(); write it for the agent who finds this cap. */
  instructions?: string;
  [key: string]: unknown;
};

/** Registry verbs. All registration is \`define\`; the target kind carries direction and durability. */
interface ItxCaps {
  /**
   * Register a capability on this handle's context: a flat-identifier name
   * plus a target. Live targets are session-bound; rpc/url targets are durable.
   * Nested names belong to the provided object, not the registry.
   */
  define(input: { name: string; target: CapTarget; invoke?: CapInvoke; meta?: CapMeta }): Promise<{ name: string; ok: true }>;
  /**
   * Legacy alias: \`provide({ name, target: stub })\` is equivalent to defining
   * a live capability target.
   */
  provide(input: { name: string; target: RpcTarget | Function | JsonRecord; invoke?: CapInvoke; meta?: CapMeta }): Promise<{ name: string; ok: true }>;
  /** Remove a capability registration from this context. */
  revoke(input: { name: string }): Promise<{ name: string; ok: true }>;
  /** The merged chain view; same data \`itx.describe()\` embeds. */
  describe(): Promise<CapDescription[]>;
  /**
   * A signed, expiring URL for one HTTP-exposed cap. Possession grants exactly
   * that cap's fetch surface until expiry.
   */
  shareUrl(input: { name: string; path?: string; ttlSeconds?: number }): Promise<string>;
}

/** An event as read back from a stream. */
interface StreamEvent {
  type: string;
  payload?: unknown;
  /** 1-based durable offset; the resume cursor. */
  offset: number;
}

/** An event as appended. */
interface StreamEventInput {
  type: string;
  payload?: unknown;
  /** Appends with the same key are dropped instead of duplicated. */
  idempotencyKey?: string;
}

/** The public state of one stream. */
interface StreamState {
  namespace: string;
  path: string;
  eventCount: number;
  childPaths: string[];
  metadata: Record<string, unknown>;
}

/** How a stream is addressed: relative to this handle or as \`namespace:/path\`. */
type StreamRef = string | { namespace?: string; path: string };

/** A handle pinned to one stream. */
interface ItxStream {
  /** Return the stream namespace and path this handle is pinned to. */
  describe(): { namespace: string; path: string };
  /** Append one event and return the stored event, including its durable offset. */
  append(event: StreamEventInput): Promise<StreamEvent>;
  /** Append multiple events in one batch. */
  appendBatch(events: StreamEventInput[]): Promise<StreamEvent[]>;
  /** Read events from a durable offset window. */
  read(input?: { afterOffset?: number | "start" | "end"; beforeOffset?: number | "start" | "end" }): Promise<StreamEvent[]>;
  /** Read the stream's current state. */
  getState(): Promise<StreamState>;
  /** List child stream paths under this stream. */
  listChildren(): Promise<unknown>;
  /**
   * The reactive primitive: catch up from \`afterOffset\`, then receive every
   * committed batch until unsubscribed. Each batch carries current state.
   */
  subscribe(
    onEventBatch: (batch: { events: StreamEvent[]; state: StreamState; streamMaxOffset: number }) => unknown,
    opts: { afterOffset: number | "start" | "end"; events?: boolean },
  ): Promise<{ unsubscribe(): void }>;
  /** Sugar for state-only subscription from the end of the stream. */
  onStateChange(onState: (state: StreamState) => unknown): Promise<{ unsubscribe(): void }>;
}

/** The streams collection, namespace-bound by the handle. */
interface ItxStreams {
  /** Resolve a stream ref, either relative to this handle or absolute. */
  get(ref: StreamRef): ItxStream;
  /** Create a stream path in this handle's namespace. */
  create(input: { streamPath: string }): Promise<unknown>;
}

interface ItxWorkspaceGit {
  /** Stage files in the project workspace. */
  add(input: JsonRecord): Promise<unknown>;
  /** Clone a repository into the project workspace. */
  clone(input: JsonRecord): Promise<unknown>;
  /** Commit staged workspace changes. */
  commit(input: JsonRecord): Promise<unknown>;
  /** Push workspace commits to the remote repository. */
  push(input: JsonRecord): Promise<unknown>;
  /** Read git status for the project workspace. */
  status(input: JsonRecord): Promise<unknown>;
}

/** The project's workspace filesystem and git surface. */
interface ItxWorkspace {
  readonly git: ItxWorkspaceGit;
  /** Read a file from the project workspace. */
  readFile(path: string): Promise<string>;
  /** Write a file in the project workspace. */
  writeFile(path: string, content: string): Promise<unknown>;
}

/** The Project Durable Object surface exposed as cap #0. */
interface ItxProjectAdmin {
  /** Call a public function exported by the project's worker. */
  callWorkerFunction(input: { args?: unknown[]; path: string[] }): Promise<unknown>;
  /** Return the project summary and ingress URL. */
  describe(): Promise<ProjectSummary & { ingressUrl: string }>;
  /** Fetch through the project's egress path. */
  egressFetch(request: Request): Promise<Response>;
  /** fetch on the PROJECT is egress (the worker's fetch is the homepage). */
  fetch(request: Request): Promise<Response>;
  /** Return the project's public ingress URL. */
  ingressUrl(): Promise<string>;
  /** The project's stream processor: phase/project/worker reduced state. */
  readonly processor: {
    snapshot(): Promise<{ offset: number; state: unknown }>;
  };
}

/** What \`itx.describe()\` returns: context, principal, caps, and project breadcrumbs. */
interface ItxDescription {
  /** "global", a project id, or a ctx_* child context id. */
  context: string;
  /** Who this handle was minted for. */
  principal?: unknown;
  /** Attribution: which capability's isolate holds this handle, if any. */
  cap?: string;
  /** The merged capability chain, including provider-supplied instructions. */
  caps: CapDescription[];
  /** The bound project's own description, if this handle has one. */
  project: unknown | null;
}

/**
 * Declaration-merge point for caps you expect to exist, so they complete and
 * type-check. Runtime truth is always \`itx.describe()\`.
 */
interface KnownCaps {}

/**
 * The built-in surface of every handle. Everything else you see on an \`itx\`
 * is a capability that fell through to the registry.
 */
interface ItxBuiltins {
  /** Register, revoke, inspect, and share capabilities on this context. */
  readonly caps: ItxCaps;
  /**
   * Event streams. The handle picks the default namespace: the project id on
   * a project handle, or "global" on an admin global handle.
   */
  readonly streams: ItxStreams;
  /**
   * Narrow to a project. The access check returns a new project-scoped handle;
   * there is no separate project object.
   */
  readonly projects: ItxProjects;
  /** The project's git repos capability. */
  readonly repos: CapSurface;
  /** The project's workspace: file reads/writes and git operations. */
  readonly workspace: ItxWorkspace;
  /** The project worker. Public methods/getters are reachable at any depth. */
  readonly worker: CapSurface;
  /** The Project Durable Object stub, whole surface, exposed as cap #0. */
  readonly project: ItxProjectAdmin;
  /**
   * Explicit project egress. Secret placeholders are substituted inside the
   * project's egress hop, so browser and capability code never sees secrets.
   */
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
  /**
   * Who/what am I holding? Returns the context, principal, and merged
   * capability chain with provider-supplied instructions. When in doubt,
   * describe.
   */
  describe(): Promise<ItxDescription>;
  /**
   * Explicit form of the fallthrough: \`itx.cap("slack")\` is equivalent to
   * \`itx.slack\`. Useful when the name is computed or shadowed by a built-in.
   */
  cap(name: string): CapSurface;
  /**
   * Create a child context under this one: a disposable agent session or REPL
   * scratchpad. Child caps shadow this context's; misses delegate upward.
   */
  fork(opts?: { name?: string }): Promise<Itx>;
}

/**
 * A live handle on a context. Unknown property names fall through to the
 * capability registry at runtime.
 */
type Itx = ItxBuiltins & KnownCaps & Record<string, CapSurface>;

/** The connected Iterate context handle for this REPL session. */
declare const itx: Itx;
/** Environment-style values injected into this REPL session. */
declare const env: JsonRecord;
/** The last successful REPL result. */
declare let $_: unknown;
/** Alias for the last successful REPL result. */
declare let _: unknown;
`;

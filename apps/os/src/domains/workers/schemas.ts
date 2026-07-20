import { z } from "zod";
import type { StreamPushEventBatch } from "iterate/processors";
import type { ProjectRpcTarget } from "../../rpc-targets.ts";
import { normalizePath } from "../durable-object-names.ts";

const DURABLE_WORKER_KEY = /^[a-z][a-z0-9-]{0,62}$/;

// -----------------------------------------------------------------------------
// Dynamic worker recipe types.
//
// These hand-authored shapes ARE the public itx contract for dynamic workers
// (docstrings included) and each is pinned to its zod schema below via
// `satisfies z.ZodType<…>`, so a schema reshape fails typecheck instead of
// silently forking the two. A schema and its type deliberately share a name
// (value vs type namespaces): `DynamicWorkerRef` is both the parser and the
// type it produces.
// -----------------------------------------------------------------------------

/**
 * Where a dynamic worker's source files come from.
 *
 * `inline` supplies the file map directly — the primitive behind run-script and
 * worker-backed provided capabilities where the caller hands over a small
 * TypeScript entry file, helpers, and optionally a `package.json`. `repo` names
 * a project repo snapshot: a branch (late-bound, so future commits affect the
 * next use) or a pinned commit, narrowed by include/exclude glob masks so a
 * large repo does not become build input by default.
 */
export type WorkerFileSource =
  | {
      type: "inline";
      files: Record<string, string>;
    }
  | {
      type: "repo";
      repoPath: string;
      /**
       * Defaults to the repo's default branch when omitted. A pinned commit
       * may name the branch it lives on — clones are single-branch, so an
       * off-default-branch commit is unreachable without it.
       */
      ref?: { branch: string } | { commitOid: string; branch?: string };
      include?: string[];
      exclude?: string[];
    };

/**
 * Build options for a dynamic worker.
 *
 * Deliberately small: exactly what `@cloudflare/worker-bundler` expresses
 * (`createWorker` / `createApp` inside workerd). When the file map has a
 * `package.json`, production dependencies are installed from the npm registry
 * by the package's in-worker downloader. Project build scripts never run.
 */
export type WorkerBuildOptions = {
  /** Entry point file path relative to the source root. Default: "worker.ts".
   * For full-stack apps this is the server entry (`createApp`'s `server`). */
  entryPoint?: string;
  /** Optional browser entry. When set, the build uses `createApp` (server +
   * client bundle + static assets) instead of plain `createWorker`. */
  client?: string;
  /** Bundle to loader-ready output (default: true). `bundle: false` is the
   * run-script fast path: inline JavaScript that is ALREADY loader-ready
   * skips the build pipeline entirely. */
  bundle?: boolean;
  minify?: boolean;
  /** Build from this subdirectory of the resolved source: files outside it
   * are dropped and paths are re-rooted, so a repo can host an app at e.g.
   * `apps/todos/` with its own package.json. */
  rootDir?: string;
  /** Platform-supplied modules resolvable by exact specifier (the `iterate/sdk`
   * runtime rides in this way). A source's own entry wins over the platform's. */
  virtualModules?: Record<string, string>;
};

/**
 * Declarative source for a dynamic worker: an orthogonal file source plus
 * Cloudflare-compatible build options.
 *
 * Materialization resolves `files` to a file map and builds it through
 * Cloudflare's worker bundler; the loader-ready output is cached by a
 * deterministic build key, so the same source+options never builds twice.
 */
export type DynamicWorkerSource = {
  files: WorkerFileSource;
  options?: WorkerBuildOptions;
};

/** Fields shared by every dynamic worker ref (stateless and stateful): the
 * itx scope `path` the worker binds to and the declarative `source` it is
 * built from. */
export type DynamicWorkerRefBase = {
  /**
   * itx scope path for the worker's `env.ITX` binding and for stateful worker
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
  /**
   * What a call does when the worker's source changed since the running
   * version. `"block"` (default) waits for the rebuild — commit-then-call
   * sees the new code. `"stale-while-rebuild"` keeps answering with the
   * running version and swaps to the new build in the background: better
   * availability, but the next few calls after a commit may see old code.
   * The policy rides the REF, not the durable identity — callers sharing one
   * `durableWorkerKey` should agree on it (and on `source`), or each call
   * flips the facet to its own version.
   */
  updatePolicy?: "block" | "stale-while-rebuild";
};

/** Worker recipe accepted by `workers.get` and worker-backed capabilities. */
export type DynamicWorkerRef = StatelessDynamicWorkerRef | StatefulDynamicWorkerRef;

/**
 * Dynamic worker RPC stub plus platform-owned lifecycle operations. The
 * lifecycle names are platform verbs: a worker method with the same name is
 * shadowed on this stub (still reachable via
 * `invokeCapability({ path: [...] })`).
 */
export type DynamicWorkerCapability<T extends object = Record<string, unknown>> = T &
  Disposable & {
    /** Abort the stateful worker Durable Object incarnation. Stateless worker refs reject. */
    kill(): Promise<void>;
    /**
     * Arm (ms timestamp) — or with null, disarm — the stateful worker's
     * durable alarm; the fire calls the worker class's own `alarm(alarmInfo)`
     * method, retried by the platform if it throws. Facets have no native
     * alarms in workerd, so the hosting Durable Object keeps the real one on
     * the worker's behalf. Stateless worker refs reject. Inside the worker,
     * `IterateDurableObject` presents this as the ordinary `ctx.storage`
     * alarm API automatically.
     */
    setAlarm(atMs: number | null): Promise<void>;
    /** The stateful worker's armed alarm time (ms) or null. Stateless worker refs reject. */
    getAlarm(): Promise<number | null>;
  };

/**
 * Per-stub dispatch options for `DynamicWorkerCollection.get`.
 *
 * `flattenNestedPaths` mirrors `provideCapability`: dotted calls on the stub
 * become ONE `invokeCapability({ path, args })` call that the worker's own
 * `invokeCapability` method dispatches in userspace (one RPC per call),
 * instead of the default member-by-member replay on the entrypoint.
 * `buildBudgetMs` bounds how long a call waits on a cold source build; past
 * it the call fails with an error whose `name` is
 * `"WorkerBuildInProgressError"` — the NAME is the contract (it survives
 * Workers RPC; class identity does not), so userspace matches
 * `error.name === "WorkerBuildInProgressError"` to render its own building
 * page (the seeded template's router does exactly this).
 */
export type DynamicWorkerDispatchOptions = {
  buildBudgetMs?: number;
  flattenNestedPaths?: boolean;
};

/** JSON subset accepted by WorkerEntrypoint props and script results. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Default seeded project worker contract.
 *
 * This documents the reference repo's `worker.ts` only. Arbitrary dynamic
 * workers should be typed by callers through `workers.get<T>(ref)`. The
 * platform dispatches to it with flattened paths, so the worker implements
 * `invokeCapability` in userspace and every dotted call — including any
 * nested surface a userland getter hands back (an SDK client the project
 * adds and installs through its `package.json`) — is one RPC.
 */
export interface ProjectWorker {
  fetch(req: Request): Promise<Response>;
  invokeCapability(input: { args?: unknown[]; path: string[] }): Promise<unknown>;
  /**
   * Checkpointed event delivery: every project-scoped stream pumps its
   * committed events here (see ProjectWorkerDelivery). Batches arrive in
   * per-stream order, at-least-once — each event carries the `path` of the
   * stream it lives on, so `${event.path}@${event.offset}` identifies a
   * delivery globally and is the idempotency-key idiom for reactions. The
   * stream only advances its checkpoint when this resolves; throwing means
   * the whole batch is redelivered later. Ephemeral events
   * (`ephemeral: true` appends — e.g. `agent/llm-response-chunk`) are never
   * delivered to this feed; their durable truth arrives as its own event.
   */
  processEventBatch(batch: StreamPushEventBatch): Promise<void>;
}

const WorkerFileSource = z.discriminatedUnion("type", [
  z.strictObject({
    files: z.record(z.string(), z.string()),
    type: z.literal("inline"),
  }),
  z.strictObject({
    exclude: z.array(z.string()).optional(),
    include: z.array(z.string()).optional(),
    ref: z
      .union([
        z.strictObject({ branch: z.string().min(1) }),
        z.strictObject({
          branch: z.string().min(1).optional(),
          commitOid: z.string().regex(/^[0-9a-f]{40}$/),
        }),
      ])
      .optional(),
    repoPath: z.string(),
    type: z.literal("repo"),
  }),
]) satisfies z.ZodType<WorkerFileSource, unknown>;

export const WorkerBuildOptions = z.strictObject({
  bundle: z.boolean().optional(),
  client: z.string().optional(),
  entryPoint: z.string().optional(),
  minify: z.boolean().optional(),
  rootDir: z.string().optional(),
  virtualModules: z.record(z.string(), z.string()).optional(),
}) satisfies z.ZodType<WorkerBuildOptions, unknown>;

export const DynamicWorkerSource = z.strictObject({
  files: WorkerFileSource,
  options: WorkerBuildOptions.optional(),
}) satisfies z.ZodType<DynamicWorkerSource, unknown>;

const WorkerRefBase = {
  path: z.string().transform(normalizePath),
  source: DynamicWorkerSource,
};

const StatelessDynamicWorkerRef = z.strictObject({
  ...WorkerRefBase,
  entrypoint: z.string().optional(),
  props: z.record(z.string(), z.json()).optional(),
  type: z.literal("stateless"),
}) satisfies z.ZodType<StatelessDynamicWorkerRef, unknown>;

const StatefulDynamicWorkerRef = z.strictObject({
  ...WorkerRefBase,
  className: z.string(),
  durableWorkerKey: z.string().regex(DURABLE_WORKER_KEY),
  type: z.literal("stateful"),
  updatePolicy: z.enum(["block", "stale-while-rebuild"]).optional(),
}) satisfies z.ZodType<StatefulDynamicWorkerRef, unknown>;

export const DynamicWorkerRef = z.discriminatedUnion("type", [
  StatelessDynamicWorkerRef,
  StatefulDynamicWorkerRef,
]) satisfies z.ZodType<DynamicWorkerRef, unknown>;

/**
 * The `env.ITX` binding every dynamic worker receives — one object, two
 * channels, split by what the wire can carry:
 *
 * - `get()` — the capability tree. An itx scoped to the worker's path;
 *   everything on it is Workers RPC method calls whose arguments and results
 *   are serialized data or live stubs. No name on this tree is
 *   protocol-special (`fetch` included).
 * - `fetch(request)` — the fetch lane. Real HTTP into a sibling dynamic
 *   worker, selected by the `x-iterate-worker-dispatch` header (JSON
 *   `{ ref, buildBudgetMs? }`, the same ref shape `workers.get` takes). This
 *   is a chain of real workerd fetch hops end to end, so it is the ONLY
 *   channel that can carry protocol semantics — WebSocket upgrades reach the
 *   target class's own `fetch` handler and the 101's socket tunnels back.
 *   A cold build answers a 503 building page marked
 *   `x-iterate-worker-building` (auto-refreshing for browsers, retryable for
 *   WebSocket reconnect loops).
 *
 * Authority is identical on both channels: the binding's own scope, minted by
 * the host — worker code never picks its own project.
 *
 * @public — not reachable from the /api entrypoint walk; published for
 * project-worker code, which imports it from its `iterate` devDependency's
 * `iterate/sdk` export (re-exported by the seeded sdk.ts).
 */
export type ItxBinding = {
  fetch(request: Request): Promise<Response>;
  /**
   * The value delivered over the loopback is an RPC STUB of the project root,
   * and stubs are disposable — typed honestly so worker code can (and
   * should) write `using itx = await this.env.ITX.get()`: releasing the stub
   * when the handler ends keeps workerd's "An RPC stub was not disposed
   * properly" warning out of production logs. Values obtained THROUGH it
   * hold their own references and survive its disposal.
   */
  get(): Promise<ProjectRpcTarget & Disposable>;
};

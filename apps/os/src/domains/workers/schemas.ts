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
 * next use) or a pinned commit. The whole snapshot is passed through by
 * default; optional include/exclude glob masks let callers narrow it.
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

/** Portable loader names accepted by `@cloudflare/worker-bundler`. */
export type WorkerBundlerLoader =
  | "js"
  | "jsx"
  | "ts"
  | "tsx"
  | "json"
  | "css"
  | "text"
  | "binary"
  | "base64"
  | "dataurl";

/**
 * The serializable `@cloudflare/worker-bundler` options shared by
 * `createWorker` and `createApp`.
 *
 * These fields are passed through unchanged. The method-specific types below
 * replace only `files` with a repo-aware value and omit callbacks that cannot
 * cross the isolated bundler Worker's RPC boundary.
 */
export type WorkerBundlerOptions = {
  bundle?: boolean;
  conditions?: string[];
  define?: Record<string, string>;
  externals?: string[];
  jsx?: "transform" | "preserve" | "automatic";
  jsxImportSource?: string;
  loader?: Record<string, WorkerBundlerLoader>;
  minify?: boolean;
  registry?: string;
  sourcemap?: boolean;
  target?: string;
};

/** JSON-safe `AssetConfig` accepted by worker-bundler's asset handler. */
export type WorkerBundlerAssetConfig = {
  headers?: Record<string, { set?: Record<string, string>; unset?: string[] }>;
  html_handling?: "auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash" | "none";
  not_found_handling?: "single-page-application" | "404-page" | "none";
  redirects?: {
    dynamic?: Record<string, { status: number; to: string }>;
    static?: Record<string, { status: number; to: string }>;
  };
};

/** Serializable `createWorker` input. `files` is repo-aware; after resolving
 * it, OS passes the resulting path-to-source map to worker-bundler unchanged.
 * The plugin callback and custom `FileSystem` variants cannot cross Workers
 * RPC, so those are the only upstream inputs omitted here. */
export type WorkerBundlerCreateWorkerOptions = WorkerBundlerOptions & {
  files: WorkerFileSource;
  entryPoint?: string;
  virtualModules?: Record<string, string>;
};

/** Serializable `createApp` input. The generated browser bundles and explicit
 * text assets are retained in the host and served by worker-bundler's own
 * asset handler. ArrayBuffer assets and the esbuild plugin callback are the
 * only upstream inputs omitted from this data-only boundary. */
export type WorkerBundlerCreateAppOptions = WorkerBundlerOptions & {
  assetConfig?: WorkerBundlerAssetConfig;
  assets?: Record<string, string>;
  client?: string | string[];
  files: WorkerFileSource;
  server?: string;
};

/**
 * One direct worker-bundler call. The wrapper names deliberately match the
 * upstream functions; OS only resolves the repo-aware `files` value, adds its
 * platform virtual modules to `createWorker`, and caches the returned build.
 */
export type DynamicWorkerSource =
  | { createApp: WorkerBundlerCreateAppOptions }
  | { createWorker: WorkerBundlerCreateWorkerOptions };

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

const WorkerBundlerLoader = z.enum([
  "js",
  "jsx",
  "ts",
  "tsx",
  "json",
  "css",
  "text",
  "binary",
  "base64",
  "dataurl",
]) satisfies z.ZodType<WorkerBundlerLoader, unknown>;

const WorkerBundlerOptions = {
  bundle: z.boolean().optional(),
  conditions: z.array(z.string()).optional(),
  define: z.record(z.string(), z.string()).optional(),
  externals: z.array(z.string()).optional(),
  jsx: z.enum(["transform", "preserve", "automatic"]).optional(),
  jsxImportSource: z.string().optional(),
  loader: z.record(z.string(), WorkerBundlerLoader).optional(),
  minify: z.boolean().optional(),
  registry: z.string().optional(),
  sourcemap: z.boolean().optional(),
  target: z.string().optional(),
};

const WorkerBundlerAssetRule = z.strictObject({
  status: z.number(),
  to: z.string(),
});

const WorkerBundlerAssetConfig = z.strictObject({
  headers: z
    .record(
      z.string(),
      z.strictObject({
        set: z.record(z.string(), z.string()).optional(),
        unset: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  html_handling: z
    .enum(["auto-trailing-slash", "force-trailing-slash", "drop-trailing-slash", "none"])
    .optional(),
  not_found_handling: z.enum(["single-page-application", "404-page", "none"]).optional(),
  redirects: z
    .strictObject({
      dynamic: z.record(z.string(), WorkerBundlerAssetRule).optional(),
      static: z.record(z.string(), WorkerBundlerAssetRule).optional(),
    })
    .optional(),
}) satisfies z.ZodType<WorkerBundlerAssetConfig, unknown>;

export const WorkerBundlerCreateWorkerOptions = z.strictObject({
  ...WorkerBundlerOptions,
  entryPoint: z.string().optional(),
  files: WorkerFileSource,
  virtualModules: z.record(z.string(), z.string()).optional(),
}) satisfies z.ZodType<WorkerBundlerCreateWorkerOptions, unknown>;

export const WorkerBundlerCreateAppOptions = z.strictObject({
  ...WorkerBundlerOptions,
  assetConfig: WorkerBundlerAssetConfig.optional(),
  assets: z.record(z.string(), z.string()).optional(),
  client: z.union([z.string(), z.array(z.string())]).optional(),
  files: WorkerFileSource,
  server: z.string().optional(),
}) satisfies z.ZodType<WorkerBundlerCreateAppOptions, unknown>;

export const DynamicWorkerSource = z.union([
  z.strictObject({ createApp: WorkerBundlerCreateAppOptions }),
  z.strictObject({ createWorker: WorkerBundlerCreateWorkerOptions }),
]) satisfies z.ZodType<DynamicWorkerSource, unknown>;

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

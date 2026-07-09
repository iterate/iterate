import { z } from "zod";
import type { CreateWorkerOptions } from "@cloudflare/worker-bundler";
import type { ProjectRpcTarget } from "../../rpc-targets.ts";
import { normalizePath } from "../durable-object-names.ts";
import type { StreamEventBatch } from "../streams/rpc-types.ts";

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

/** Loader names accepted by Cloudflare's worker bundler `loader` option. */
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
 * Build options for a dynamic worker.
 *
 * This mirrors Cloudflare's `CreateWorkerOptions` from
 * `@cloudflare/worker-bundler` minus `files` (OS supplies files from the
 * selected {@link WorkerFileSource}) — deliberately not a parallel option
 * language (drift fails typecheck via the assignability pin
 * `workerBuildOptionsMatchCloudflare` below). `bundle: false` is allowed; the
 * invariant is one OS materialization pipeline, not one bundled output file.
 * When the file map has a `package.json` with dependencies, the bundler
 * installs them from the npm registry at build time.
 */
export type WorkerBuildOptions = {
  /** Entry point file path relative to the source root (e.g. "worker.ts"). */
  entryPoint?: string;
  /** Bundle all dependencies into a single output file. Default: true. */
  bundle?: boolean;
  /** Modules kept external ("cloudflare:*" always is). */
  externals?: string[];
  /** Target environment. Default: "es2022". */
  target?: string;
  minify?: boolean;
  sourcemap?: boolean;
  /** npm registry URL for dependency installs. */
  registry?: string;
  jsx?: "transform" | "preserve" | "automatic";
  jsxImportSource?: string;
  define?: Record<string, string>;
  loader?: Record<string, WorkerBundlerLoader>;
  conditions?: string[];
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

export type DynamicWorkerRefBase = {
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

/** Dynamic worker RPC stub plus the disposal operation owned by the caller. */
export type DynamicWorkerCapability<T extends object = Record<string, unknown>> = T & Disposable;

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
 * Slack Web API surface exposed by the seeded project worker
 * (`itx.worker.slack.chat.postMessage({...})`).
 *
 * The seeded repo implements this in userland with the real `@slack/web-api`
 * package (installed by the worker build pipeline from its `package.json`), so
 * any nested Web API method family resolves — the index signature reflects
 * that this tree is as wide as the SDK's.
 */
export interface ProjectWorkerSlack {
  chat: {
    postMessage(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  } & Record<string, unknown>;
  [family: string]: unknown;
}

/**
 * Default seeded project worker contract.
 *
 * This documents the reference repo's `worker.ts` only. Arbitrary dynamic
 * workers should be typed by callers through `workers.get<T>(ref)`. The
 * platform dispatches to it with flattened paths, so the worker implements
 * `invokeCapability` in userspace and every dotted call — including any
 * nested `slack.*` Web API family — is one RPC.
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
   * the whole batch is redelivered later.
   */
  processEventBatch(batch: StreamEventBatch): Promise<void>;
  slack: ProjectWorkerSlack;
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
]);

export const WorkerBuildOptions = z.strictObject({
  bundle: z.boolean().optional(),
  conditions: z.array(z.string()).optional(),
  define: z.record(z.string(), z.string()).optional(),
  entryPoint: z.string().optional(),
  externals: z.array(z.string()).optional(),
  jsx: z.enum(["transform", "preserve", "automatic"]).optional(),
  jsxImportSource: z.string().optional(),
  loader: z.record(z.string(), WorkerBundlerLoader).optional(),
  minify: z.boolean().optional(),
  registry: z.string().optional(),
  sourcemap: z.boolean().optional(),
  target: z.string().optional(),
  virtualModules: z.record(z.string(), z.string()).optional(),
}) satisfies z.ZodType<WorkerBuildOptions, unknown>;

// The public build options are Cloudflare's `CreateWorkerOptions` minus
// `files` (OS supplies files from the selected file source) and minus the
// explicitly-not-semver esbuild-plugin escape hatch (not serializable into a
// durable worker recipe). This assignability pin means a bundler option
// reshape fails typecheck here instead of silently forking the two shapes.
type CloudflareWorkerBuildOptions = Omit<
  CreateWorkerOptions,
  "files" | "__dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired"
>;
export const workerBuildOptionsMatchCloudflare = (
  options: WorkerBuildOptions,
): CloudflareWorkerBuildOptions => options;

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
 * project-worker code, which imports it from the project repo's sdk.ts copy
 * of this contract.
 */
export type ItxBinding = {
  fetch(request: Request): Promise<Response>;
  get(): Promise<ProjectRpcTarget>;
};

import { itxEnv as env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import type { DynamicWorkerRef, DynamicWorkerSource, WorkerBuildOptions } from "./schemas.ts";
import {
  KvWorkerBuildArtifactStore,
  type WorkerBuildArtifact,
  type WorkerBuildFailure,
  type WorkerLastGoodBuild,
} from "./artifact-store.ts";
import { workerBuildKey, type ResolvedWorkerFileSource } from "./build-key.ts";
import { ITERATE_SDK_VIRTUAL_MODULE } from "./iterate-sdk-virtual-module.generated.ts";
import type { WorkerServeInfo } from "./worker-serve-overlay.ts";
import { stableSha256 } from "./utils.ts";

const WORKER_COMPATIBILITY_DATE = "2026-05-01";
const WORKER_COMPATIBILITY_FLAGS = ["nodejs_compat"];

/**
 * The build is real and in flight, but the caller's build budget ran out
 * before it finished. Workers RPC preserves `error.name`, so ingress-side
 * classifiers can turn this into a "building your worker" page instead of a
 * 500 — the build keeps running in the builder worker and the retry hits the
 * artifact cache.
 */
class WorkerBuildInProgressError extends Error {
  override readonly name = "WorkerBuildInProgressError";
}

/** Name-based, because the error crosses Workers RPC (which preserves
 * `error.name` but not class identity). */
export function isWorkerBuildInProgressError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === "WorkerBuildInProgressError";
}

/**
 * The build ran and failed — the message is the builder's own error (compile
 * errors, unresolvable dependencies). Fetch-lane classifiers turn this into
 * the build-failed page; RPC callers see the named error with the builder's
 * message intact, so an agent that just committed broken source learns why.
 */
export class WorkerBuildFailedError extends Error {
  override readonly name = "WorkerBuildFailedError";
}

/** Name-based, because the error crosses Workers RPC (which preserves
 * `error.name` but not class identity). */
export function isWorkerBuildFailedError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === "WorkerBuildFailedError";
}

/**
 * Fully materialized Worker Loader input plus a cache key for the built bytes.
 * The cache key is build identity only; runtime scope and exported symbol are
 * added by `loadResolvedWorker` so the same artifact can be used in multiple
 * itx paths without leaking bindings or entrypoint props across scopes.
 */
export type ResolvedWorkerSource = {
  cacheKey: string;
  mainModule: string;
  modules: Record<string, string>;
  /**
   * Serve-side status for the fetch lane (repo-backed sources only): the
   * commit that is actually serving, and whether it is a stale fallback while
   * a newer commit builds or after its build failed. Per-resolve context,
   * never memoized — the runner stamps it onto responses as the
   * `x-iterate-worker-serve` header.
   */
  serveInfo?: WorkerServeInfo;
};

export type WorkerBindings = Record<string, unknown>;

// Artifacts are immutable (content-addressed by build key), so a small
// per-isolate memo removes the KV manifest+module reads from warm loads.
const resolvedArtifactMemo = new Map<string, ResolvedWorkerSource>();
const RESOLVED_ARTIFACT_MEMO_LIMIT = 64;

export async function resolveWorkerSource({
  buildBudgetMs,
  projectId,
  source,
  waitUntil,
}: {
  /** Give up on a cold resolve after this long (the build itself keeps
   * running in the builder worker). Omitted = wait for the build. */
  buildBudgetMs?: number;
  projectId: string;
  source: DynamicWorkerSource;
  /** The hosting request context's `ctx.waitUntil`. A budget-expired resolve
   * is handed to it so the cold path survives the caller's request ending. */
  waitUntil: (promise: Promise<unknown>) => void;
}): Promise<ResolvedWorkerSource> {
  const options = source.options ?? {};

  // Loader-ready degenerate case: inline JavaScript with bundling explicitly
  // off is exactly what the Worker Loader consumes, so materialization is the
  // identity function. Skipping the pipeline keeps run-script (which executes
  // on every agent turn) at direct-load latency instead of paying a build
  // round trip per script.
  const loaderReady = await loaderReadyInlineSource(source, options);
  if (loaderReady !== null) return loaderReady;

  // The budget covers the WHOLE cold path — head resolution (a Repo DO call)
  // included — so a browser-facing caller's bound is a real bound, not just a
  // bound on the bundler.
  return await withBuildBudget(
    resolveThroughBuilder({
      budgeted: buildBudgetMs !== undefined,
      options,
      projectId,
      source,
      waitUntil,
    }),
    buildBudgetMs,
    waitUntil,
  );
}

/** Race a resolution against the caller's budget without cancelling it: the
 * builder finishes into the artifact cache regardless, so the caller's retry
 * is a hit. */
async function withBuildBudget(
  resolution: Promise<ResolvedWorkerSource>,
  budgetMs: number | undefined,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<ResolvedWorkerSource> {
  if (budgetMs === undefined) return await resolution;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resolution,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // The losing resolution must outlive this request: when the caller
          // returns the building page, the runtime cancels the request's
          // pending work, and a BUILDER.build RPC that hasn't been dispatched
          // yet dies with it — every refresh would then restart the cold path
          // from zero instead of converging on the cached artifact.
          waitUntil(resolution.catch(() => {}));
          reject(new WorkerBuildInProgressError("This worker is still building."));
        }, budgetMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every bundled dynamic worker build can `import ... from "iterate/sdk"`: the
 * platform supplies the sdk runtime as a virtual module, because resolving it
 * by install cannot work — the bundler's npm installer is registry-semver-only
 * and the seeded devDependency is a pkg.pr.new URL. Injection happens BEFORE
 * the build key is computed, and `options` is hashed into the key wholesale,
 * so an sdk change invalidates cached artifacts instead of serving stale
 * builds. A source that supplies its own `iterate/sdk` virtual module wins.
 */
function withIterateSdkVirtualModule(options: WorkerBuildOptions): WorkerBuildOptions {
  return {
    ...options,
    virtualModules: { "iterate/sdk": ITERATE_SDK_VIRTUAL_MODULE, ...options.virtualModules },
  };
}

/** The build-independent inputs one resolve works with: which project, which
 * resolved source, which (sdk-injected) options. */
type BuildIdentity = {
  options: WorkerBuildOptions;
  projectId: string;
  resolved: ResolvedWorkerFileSource;
};

// Concurrent cold resolutions of one build key deliberately do NOT share a
// promise: awaiting another request's in-flight RPC is workerd's
// "cannot perform I/O on behalf of a different request" trap. Duplicates are
// harmless — content-addressed, idempotent artifact writes — just redundant.
async function resolveThroughBuilder(input: {
  /** Whether the caller runs under a build budget — the fetch lane. Budgeted
   * callers prefer availability (previous good build now, fresh build in the
   * background); blocking callers keep commit-then-call-sees-new-code. */
  budgeted: boolean;
  options: WorkerBuildOptions;
  projectId: string;
  source: DynamicWorkerSource;
  waitUntil: (promise: Promise<unknown>) => void;
}): Promise<ResolvedWorkerSource> {
  const options = withIterateSdkVirtualModule(input.options);
  const resolved = await resolveFileSource({ projectId: input.projectId, source: input.source });
  const buildKey = await workerBuildKey({
    compatibilityDate: WORKER_COMPATIBILITY_DATE,
    compatibilityFlags: WORKER_COMPATIBILITY_FLAGS,
    options,
    source: resolved,
  });
  const identity: BuildIdentity = { options, projectId: input.projectId, resolved };
  const store = new KvWorkerBuildArtifactStore(env.WORKER_BUILD_CACHE);

  const memoized = resolvedArtifactMemo.get(buildKey);
  if (memoized !== undefined) {
    await noteLastGoodBuild(store, identity, buildKey);
    return freshServe(memoized, resolved);
  }

  const cached = await store.get(buildKey);
  if (cached !== null) {
    await noteLastGoodBuild(store, identity, buildKey);
    return freshServe(memoizeArtifact(cached), resolved);
  }

  if (input.budgeted) {
    // The fetch lane never makes a browser wait on a build it can avoid: with
    // a previous good build on record, serve THAT — the rebuild (or its
    // recorded failure) rides along as serve info for the overlay.
    const lastGood = await lastGoodArtifact(store, identity, buildKey);
    const failure = await store.getBuildFailure(buildKey);
    if (failure !== null) {
      if (lastGood !== null) return staleServe(lastGood, "build-failed", failure);
      throw new WorkerBuildFailedError(failure.message);
    }
    if (lastGood !== null) {
      dispatchBackgroundBuild({ buildKey, identity, store, waitUntil: input.waitUntil });
      return staleServe(lastGood, "building");
    }
    // Nothing to fall back on: answer "still building" from the in-flight
    // marker instead of piling a duplicate full build onto a running one —
    // the building page's poll loop otherwise multiplies cold builds per tab.
    if (await store.isBuildInFlight(buildKey)) {
      throw new WorkerBuildInProgressError("This worker is still building.");
    }
  }

  // Cache miss: one RPC to the builder worker — the only script carrying the
  // bundler toolchain. The file snapshot is resolved HERE and passed by value
  // (this worker owns the REPO binding; the builder is a pure, bindings-free
  // function worker — see builder-entrypoint.ts), sized by the ref's source
  // masks. The builder returns the artifact by value (so this never waits on
  // KV write propagation); a build failure is recorded (so the fetch lane can
  // fall back without re-running it) and surfaces as the named error.
  try {
    const artifact = await env.BUILDER.build({
      buildKey,
      files: await resolvedSourceFiles(input.projectId, resolved),
      options,
    });
    await noteLastGoodBuild(store, identity, buildKey);
    return freshServe(memoizeArtifact(artifact), resolved);
  } catch (error) {
    await recordBuildFailure(store, buildKey, resolved, error);
    throw new WorkerBuildFailedError(errorMessage(error), { cause: error });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function freshServe(
  artifact: ResolvedWorkerSource,
  resolved: ResolvedWorkerFileSource,
): ResolvedWorkerSource {
  if (resolved.type !== "repo") return artifact;
  return { ...artifact, serveInfo: { commitOid: resolved.commitOid, status: "fresh" } };
}

function staleServe(
  lastGood: { artifact: ResolvedWorkerSource; record: WorkerLastGoodBuild },
  reason: "build-failed" | "building",
  failure?: WorkerBuildFailure,
): ResolvedWorkerSource {
  return {
    ...lastGood.artifact,
    serveInfo: {
      reason,
      status: "stale",
      ...(lastGood.record.commitOid !== undefined ? { commitOid: lastGood.record.commitOid } : {}),
      ...(failure !== undefined ? { failure } : {}),
    },
  };
}

/**
 * The identity of "this worker" across commits — everything in the build key
 * EXCEPT source content. It addresses the mutable last-good pointer, so a
 * failed or in-flight build of new source can find the previous good artifact.
 */
async function workerLastGoodKey(identity: BuildIdentity): Promise<string | null> {
  if (identity.resolved.type !== "repo") return null;
  return await stableSha256({
    branch: identity.resolved.branch,
    exclude:
      identity.resolved.exclude === undefined ? undefined : [...identity.resolved.exclude].sort(),
    include:
      identity.resolved.include === undefined ? undefined : [...identity.resolved.include].sort(),
    options: identity.options,
    projectId: identity.projectId,
    repoPath: identity.resolved.repoPath,
    type: "worker-last-good-key",
  });
}

// Last-good pointer writes ride cold builds plus ONE note per isolate per
// (worker, build) — never the per-request hot path, which would trip KV's
// one-write-per-second-per-key limit. Best-effort by design: a lost write
// costs one stale-fallback opportunity, some other isolate rewrites it.
const lastGoodNoted = new Set<string>();

async function noteLastGoodBuild(
  store: KvWorkerBuildArtifactStore,
  identity: BuildIdentity,
  buildKey: string,
): Promise<void> {
  const workerKey = await workerLastGoodKey(identity);
  if (workerKey === null) return;
  const noteKey = `${workerKey}:${buildKey}`;
  if (lastGoodNoted.has(noteKey)) return;
  if (lastGoodNoted.size >= 512) lastGoodNoted.clear();
  lastGoodNoted.add(noteKey);
  const commitOid = identity.resolved.type === "repo" ? identity.resolved.commitOid : undefined;
  await store
    .putLastGood(workerKey, {
      at: new Date().toISOString(),
      buildKey,
      ...(commitOid !== undefined ? { commitOid } : {}),
    })
    .catch(() => {});
}

/** The previous good build for this worker, loadable — or null (inline
 * source, no pointer yet, pointer at the current key, or artifact expired). */
async function lastGoodArtifact(
  store: KvWorkerBuildArtifactStore,
  identity: BuildIdentity,
  currentBuildKey: string,
): Promise<{ artifact: ResolvedWorkerSource; record: WorkerLastGoodBuild } | null> {
  const workerKey = await workerLastGoodKey(identity);
  if (workerKey === null) return null;
  const record = await store.getLastGood(workerKey);
  if (record === null || record.buildKey === currentBuildKey) return null;
  const artifact = await resolveCachedArtifact(record.buildKey);
  if (artifact === null) return null;
  return { artifact, record };
}

async function recordBuildFailure(
  store: KvWorkerBuildArtifactStore,
  buildKey: string,
  resolved: ResolvedWorkerFileSource,
  error: unknown,
): Promise<void> {
  const commitOid = resolved.type === "repo" ? resolved.commitOid : undefined;
  await store
    .putBuildFailure(buildKey, {
      at: new Date().toISOString(),
      message: errorMessage(error),
      ...(commitOid !== undefined ? { commitOid } : {}),
    })
    .catch(() => {});
}

// Per-isolate dedupe for fetch-lane background rebuilds. Presence-only — the
// promise itself is never shared across requests (workerd's cross-request-I/O
// trap); other requests just skip dispatching a duplicate.
const backgroundBuilds = new Set<string>();

function dispatchBackgroundBuild(input: {
  buildKey: string;
  identity: BuildIdentity;
  store: KvWorkerBuildArtifactStore;
  waitUntil: (promise: Promise<unknown>) => void;
}): void {
  const { buildKey, identity, store } = input;
  if (backgroundBuilds.has(buildKey)) return;
  backgroundBuilds.add(buildKey);
  input.waitUntil(
    (async () => {
      try {
        // Another isolate's builder run marked in-flight; its artifact write
        // will land — do not pile a duplicate full build on top.
        if (await store.isBuildInFlight(buildKey)) return;
        const artifact = await env.BUILDER.build({
          buildKey,
          files: await resolvedSourceFiles(identity.projectId, identity.resolved),
          options: identity.options,
        });
        memoizeArtifact(artifact);
        await noteLastGoodBuild(store, identity, buildKey);
      } catch (error) {
        await recordBuildFailure(store, buildKey, identity.resolved, error);
      } finally {
        backgroundBuilds.delete(buildKey);
      }
    })(),
  );
}

/** The full file map for a resolved source. Only runs on artifact-cache
 * misses, so warm loads never touch the repo. */
async function resolvedSourceFiles(
  projectId: string,
  resolved: ResolvedWorkerFileSource,
): Promise<Record<string, string>> {
  if (resolved.type === "inline") return resolved.files;
  const repo = env.REPO.getByName(
    DurableObjectNameCodec.stringify({ path: resolved.repoPath, projectId }),
  );
  const snapshot = await repo.getFilesSnapshot({
    branch: resolved.branch,
    commitOid: resolved.commitOid,
    exclude: resolved.exclude,
    include: resolved.include,
  });
  return snapshot.files;
}

/**
 * A previously built artifact by exact cache key — memo then KV, never a
 * build. This is the stale-while-rebuild read: the stateful worker host keeps
 * serving the version it already ran while the fresh resolve happens in the
 * background. Null when the artifact expired (or the key was a loader-ready
 * fast-path hash, which never enters the store) — callers fall back to a
 * blocking resolve.
 */
export async function resolveCachedArtifact(
  cacheKey: string,
): Promise<ResolvedWorkerSource | null> {
  const memoized = resolvedArtifactMemo.get(cacheKey);
  if (memoized !== undefined) return memoized;
  const artifact = await new KvWorkerBuildArtifactStore(env.WORKER_BUILD_CACHE).get(cacheKey);
  return artifact === null ? null : memoizeArtifact(artifact);
}

function memoizeArtifact(artifact: WorkerBuildArtifact): ResolvedWorkerSource {
  const resolved: ResolvedWorkerSource = {
    cacheKey: artifact.buildKey,
    mainModule: artifact.mainModule,
    modules: artifact.modules,
  };
  if (resolvedArtifactMemo.size >= RESOLVED_ARTIFACT_MEMO_LIMIT) {
    const oldest = resolvedArtifactMemo.keys().next().value;
    if (oldest !== undefined) resolvedArtifactMemo.delete(oldest);
  }
  resolvedArtifactMemo.set(artifact.buildKey, resolved);
  return resolved;
}

// The fast-path cache key deliberately shares no space with workerBuildKey:
// both hashes carry a distinct `type` discriminant, so a verbatim load can
// never collide with a built artifact in the Worker Loader's cache.
async function loaderReadyInlineSource(
  source: DynamicWorkerSource,
  options: WorkerBuildOptions,
): Promise<ResolvedWorkerSource | null> {
  if (source.files.type !== "inline" || options.bundle !== false) return null;
  if (options.entryPoint === undefined) return null;
  const fileNames = Object.keys(source.files.files);
  if (!fileNames.includes(options.entryPoint)) return null;
  if (!fileNames.every((name) => name.endsWith(".js") || name.endsWith(".mjs"))) return null;
  return {
    cacheKey: await stableSha256({
      entryPoint: options.entryPoint,
      files: source.files.files,
      type: "loader-ready-inline-worker-source",
    }),
    mainModule: options.entryPoint,
    modules: source.files.files,
  };
}

/** Pin any late-bound source identity (a branch name) to a commit so build key
 * and artifact are immutable and auditable. */
async function resolveFileSource({
  projectId,
  source,
}: {
  projectId: string;
  source: DynamicWorkerSource;
}): Promise<ResolvedWorkerFileSource> {
  if (source.files.type === "inline") {
    return { files: source.files.files, type: "inline" };
  }

  if (source.files.ref !== undefined && "commitOid" in source.files.ref) {
    return {
      branch: source.files.ref.branch,
      commitOid: source.files.ref.commitOid,
      exclude: source.files.exclude,
      include: source.files.include,
      repoPath: source.files.repoPath,
      type: "repo",
    };
  }

  // Branch refs are deliberately late-bound: a DynamicWorkerRef names "the
  // worker at this repo path", not a frozen commit, so source changes are
  // visible on next use. The repo answers branch -> head from its durable
  // head cache.
  const repo = env.REPO.getByName(
    DurableObjectNameCodec.stringify({ path: source.files.repoPath, projectId }),
  );
  const head = await repo.getHead(
    source.files.ref === undefined ? {} : { branch: source.files.ref.branch },
  );
  return {
    branch: head.branch,
    commitOid: head.commitOid,
    contentHash: head.contentHash,
    exclude: source.files.exclude,
    include: source.files.include,
    repoPath: source.files.repoPath,
    type: "repo",
  };
}

export function loadResolvedWorker({
  bindings,
  globalOutbound,
  projectId,
  ref,
  resolved,
  scopePath,
}: {
  bindings: WorkerBindings;
  globalOutbound: Fetcher;
  projectId: string;
  ref: DynamicWorkerRef;
  resolved: ResolvedWorkerSource;
  scopePath: string;
}): WorkerStub {
  // The Worker Loader cache must separate all runtime-relevant dimensions. In
  // particular `scopePath` prevents a worker loaded for an agent path from
  // reusing a project-root `env.ITX` binding, even if the module bytes match.
  const exportKey =
    ref.type === "stateless"
      ? `entrypoint:${ref.entrypoint ?? "default"}`
      : `durable-object:${ref.className}`;
  const cacheKey = [
    "worker-loader",
    // The hosting worker's own name. Loader caches are shared across parent
    // workers when they run in one workerd (vitest-pool-workers; a future
    // second LOADER holder), and a cached isolate only works for the parent
    // whose loopback stubs it was created with — a foreign hit fails as an
    // opaque "internal error" (#1614).
    env.WORKER_SELF,
    projectId,
    ref.path,
    scopePath,
    ref.type,
    exportKey,
    resolved.cacheKey,
  ].join(":");
  return env.LOADER.get(cacheKey, () => ({
    compatibilityDate: WORKER_COMPATIBILITY_DATE,
    compatibilityFlags: WORKER_COMPATIBILITY_FLAGS,
    env: bindings,
    globalOutbound,
    mainModule: resolved.mainModule,
    modules: resolved.modules,
  }));
}

import { itxEnv as env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import type { DynamicWorkerSource, WorkerBuildOptions } from "./schemas.ts";
import { KvWorkerBuildArtifactStore, type WorkerBuildArtifact } from "./artifact-store.ts";
import { workerBuildKey, type ResolvedWorkerFileSource } from "./build-key.ts";
import { ITERATE_SDK_VIRTUAL_MODULE } from "./iterate-sdk-virtual-module.generated.ts";
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
 * Fully materialized Worker Loader input plus a cache key for the built bytes.
 * The cache key is build identity only; runtime scope and exported symbol are
 * added by `loadResolvedWorker` so the same artifact can be used in multiple
 * itx paths without leaking bindings or entrypoint props across scopes.
 */
export type ResolvedWorkerSource = {
  cacheKey: string;
  mainModule: string;
  modules: Record<string, string>;
};

/** Completed plain-data resolution retained by one runner. The source object
 * identity proves the immutable recipe is unchanged; mutable branch refs still
 * resolve their durable head on every use and compare `version` afterward. */
export type WorkerSourceResolution = {
  resolved: ResolvedWorkerSource;
  source: DynamicWorkerSource;
  version: string;
};

export type WorkerBindings = Record<string, unknown>;

// Artifacts are immutable (content-addressed by build key), so a small
// per-isolate memo removes the KV manifest+module reads from warm loads.
const resolvedArtifactMemo = new Map<string, ResolvedWorkerSource>();
const RESOLVED_ARTIFACT_MEMO_LIMIT = 64;

const INVALID_LOADER_CLONE_MESSAGE =
  "Unable to deserialize cloned data due to invalid or unsupported version.";

/**
 * Cloudflare emits this exact error when a named Worker Loader isolate can no
 * longer deserialize its retained env Frankenvalue. This is loader
 * infrastructure, not a verdict on the arguments supplied to the worker.
 */
export function isInvalidWorkerLoaderCloneError(error: unknown): boolean {
  return (error as { message?: unknown } | null)?.message === INVALID_LOADER_CLONE_MESSAGE;
}

// Cache only plain digest strings. Concurrent misses may duplicate one digest,
// which is cheaper and safer than sharing a WebCrypto promise across requests.
const loaderCacheKeyMemo = new Map<string, string>();
const LOADER_CACHE_KEY_MEMO_LIMIT = 128;

export async function resolveWorkerSource({
  buildBudgetMs,
  previous,
  projectId,
  source,
  waitUntil,
}: {
  /** Give up on a cold resolve after this long (the build itself keeps
   * running in the builder worker). Omitted = wait for the build. */
  buildBudgetMs?: number;
  /** A completed resolution from this runner. This never carries I/O objects
   * across requests; WorkerStub/entrypoint handles are minted per call. */
  previous?: WorkerSourceResolution;
  projectId: string;
  source: DynamicWorkerSource;
  /** The hosting request context's `ctx.waitUntil`. A budget-expired resolve
   * is handed to it so the cold path survives the caller's request ending. */
  waitUntil: (promise: Promise<unknown>) => void;
}): Promise<WorkerSourceResolution> {
  const options = source.options ?? {};

  // Inline and pinned-commit recipes contain no late-bound identity. A runner
  // owns its parsed ref, so exact source-object identity makes the completed
  // resolution immutable for that target's lifetime.
  if (previous?.source === source && isImmutableFileSource(source)) return previous;

  // Loader-ready degenerate case: inline JavaScript with bundling explicitly
  // off is exactly what the Worker Loader consumes, so materialization is the
  // identity function. Skipping the pipeline keeps run-script (which executes
  // on every agent turn) at direct-load latency instead of paying a build
  // round trip per script.
  const loaderReady = await loaderReadyInlineSource(source, options);
  if (loaderReady !== null) {
    return { resolved: loaderReady, source, version: loaderReady.cacheKey };
  }

  // The budget covers the WHOLE cold path — head resolution (a Repo DO call)
  // included — so a browser-facing caller's bound is a real bound, not just a
  // bound on the bundler.
  return await withBuildBudget(
    resolveThroughBuilder({
      budgeted: buildBudgetMs !== undefined,
      options,
      previous,
      projectId,
      source,
    }),
    buildBudgetMs,
    waitUntil,
  );
}

/** Race a resolution against the caller's budget without cancelling it: the
 * builder finishes into the artifact cache regardless, so the caller's retry
 * is a hit. */
async function withBuildBudget(
  resolution: Promise<WorkerSourceResolution>,
  budgetMs: number | undefined,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<WorkerSourceResolution> {
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

// Concurrent cold resolutions of one build key deliberately do NOT share a
// promise: awaiting another request's in-flight RPC is workerd's
// "cannot perform I/O on behalf of a different request" trap. Duplicates are
// harmless — content-addressed, idempotent artifact writes — just redundant.
async function resolveThroughBuilder(input: {
  /** Whether the caller runs under a build budget (see isBuildInFlight). */
  budgeted: boolean;
  options: WorkerBuildOptions;
  previous?: WorkerSourceResolution;
  projectId: string;
  source: DynamicWorkerSource;
}): Promise<WorkerSourceResolution> {
  const options = withIterateSdkVirtualModule(input.options);
  const resolved = await resolveFileSource({ projectId: input.projectId, source: input.source });
  const version = resolvedSourceVersion(resolved);
  if (input.previous?.source === input.source && input.previous.version === version) {
    return input.previous;
  }
  const buildKey = await workerBuildKey({
    compatibilityDate: WORKER_COMPATIBILITY_DATE,
    compatibilityFlags: WORKER_COMPATIBILITY_FLAGS,
    options,
    source: resolved,
  });

  const memoized = resolvedArtifactMemo.get(buildKey);
  if (memoized !== undefined) {
    return { resolved: memoized, source: input.source, version };
  }

  const store = new KvWorkerBuildArtifactStore(env.WORKER_BUILD_CACHE);
  const cached = await store.get(buildKey);
  if (cached !== null) {
    return { resolved: memoizeArtifact(cached), source: input.source, version };
  }

  // A budgeted caller (the building-page lane) answers "still building" from
  // the in-flight marker instead of piling a duplicate full build onto a
  // running one — the refresh loop otherwise multiplies cold builds per tab.
  if (input.budgeted && (await store.isBuildInFlight(buildKey))) {
    throw new WorkerBuildInProgressError("This worker is still building.");
  }

  // Cache miss: one RPC to the builder worker — the only script carrying the
  // bundler toolchain. The file snapshot is resolved HERE and passed by value
  // (this worker owns the REPO binding; the builder is a pure, bindings-free
  // function worker — see builder-entrypoint.ts), sized by the ref's source
  // masks. The builder returns the artifact by value (so this never waits on
  // KV write propagation) and build failures propagate here as plain errors,
  // attributed to the call that needed the worker.
  const artifact = await env.BUILDER.build({
    buildKey,
    files: await resolvedSourceFiles(input.projectId, resolved),
    options,
  });
  return { resolved: memoizeArtifact(artifact), source: input.source, version };
}

function isImmutableFileSource(source: DynamicWorkerSource): boolean {
  return (
    source.files.type === "inline" ||
    (source.files.ref !== undefined && "commitOid" in source.files.ref)
  );
}

function resolvedSourceVersion(source: ResolvedWorkerFileSource): string {
  if (source.type === "inline") return "inline";
  return source.contentHash ?? `commit:${source.commitOid}`;
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

type LoadResolvedWorkerInput = {
  bindings: WorkerBindings;
  globalOutbound: Fetcher;
  projectId: string;
  resolved: ResolvedWorkerSource;
  scopePath: string;
};

export async function loadResolvedWorker({
  bindings,
  globalOutbound,
  projectId,
  resolved,
  scopePath,
}: LoadResolvedWorkerInput): Promise<WorkerStub> {
  // One isolate is determined by exact code plus its authority-bearing host
  // scope. Export selection happens after WorkerStub lookup, so entrypoint,
  // class, and ref path must not fragment the named isolate cache.
  //
  // Keep this identity stable across parent deployments. workerd retains
  // named identities without a deletion API, so deployment-versioned names
  // grow without bound. A retained env that no longer deserializes is handled
  // by DynamicWorkerRunner's bounded sticky anonymous recovery instead.
  const cacheKey = await workerLoaderCacheKey({
    projectId,
    resolved,
    scopePath,
  });
  return env.LOADER.get(cacheKey, () => workerLoaderCode({ bindings, globalOutbound, resolved }));
}

/**
 * One request-local escape hatch for a poisoned named Loader isolate. Anonymous
 * loads do not add another persistent cache identity; workerd retains the code
 * recipe on the returned stub and can recreate the isolate after eviction.
 */
export function loadResolvedWorkerAnonymous({
  bindings,
  globalOutbound,
  resolved,
}: LoadResolvedWorkerInput): WorkerStub {
  return env.LOADER.load(workerLoaderCode({ bindings, globalOutbound, resolved }));
}

function workerLoaderCode({
  bindings,
  globalOutbound,
  resolved,
}: Pick<LoadResolvedWorkerInput, "bindings" | "globalOutbound" | "resolved">) {
  return {
    compatibilityDate: WORKER_COMPATIBILITY_DATE,
    compatibilityFlags: WORKER_COMPATIBILITY_FLAGS,
    env: bindings,
    globalOutbound,
    mainModule: resolved.mainModule,
    modules: resolved.modules,
  };
}

/** Opaque identity for one exact named Loader isolate and authority scope. */
export async function workerLoaderCacheKey(input: {
  projectId: string;
  resolved: ResolvedWorkerSource;
  scopePath: string;
}): Promise<string> {
  const identity = {
    // The hosting worker's own name. Loader caches are shared across parent
    // workers when they run in one workerd (vitest-pool-workers; a future
    // second LOADER holder), and a cached isolate only works for the parent
    // whose loopback stubs it was created with — a foreign hit fails as an
    // opaque "internal error" (#1614).
    hostingWorker: env.WORKER_SELF,
    projectId: input.projectId,
    resolvedCacheKey: input.resolved.cacheKey,
    scopePath: input.scopePath,
    type: "worker-loader" as const,
  };
  const unhashed = JSON.stringify(identity);
  const memoized = loaderCacheKeyMemo.get(unhashed);
  if (memoized !== undefined) return memoized;

  const cacheKey = `worker-loader:${await stableSha256(identity)}`;
  if (loaderCacheKeyMemo.size >= LOADER_CACHE_KEY_MEMO_LIMIT) {
    const oldest = loaderCacheKeyMemo.keys().next().value;
    if (oldest !== undefined) loaderCacheKeyMemo.delete(oldest);
  }
  loaderCacheKeyMemo.set(unhashed, cacheKey);
  return cacheKey;
}

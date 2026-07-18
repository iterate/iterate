import { itxEnv as env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { DEFAULT_REPO_WORKER_SOURCE_EXCLUDE } from "../repos/utils.ts";
import type { DynamicWorkerRef, DynamicWorkerSource, WorkerBuildOptions } from "./schemas.ts";
import {
  isWorkerBuildFailedError,
  KvWorkerBuildArtifactStore,
  WorkerBuildFailedError,
  type WorkerBuildArtifact,
  type WorkerBuildFailure,
  type WorkerLastGoodBuild,
} from "./artifact-store.ts";
import {
  projectWorkerBuildKey,
  workerBuildKey,
  type ResolvedWorkerFileSource,
} from "./build-key.ts";
import { executeWorkerBuild } from "./build-backend.ts";
import {
  WORKER_COMPATIBILITY_DATE,
  WORKER_COMPATIBILITY_FLAGS,
  canonicalWorkerBuildOptions,
} from "./build-recipe.ts";
import type { WorkerServeInfo } from "./worker-serve-info.ts";
import { stableSha256 } from "./utils.ts";

/**
 * The build is real and in flight, but the caller's build budget ran out
 * before it finished. Workers RPC preserves `error.name`, so ingress-side
 * classifiers can turn this into a "building your worker" page instead of a
 * 500 — the build keeps running in the build backend and the retry hits the
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

/**
 * What a resolve returns: the artifact plus per-resolve serving context for
 * the fetch lane (repo-backed sources only) — which commit is serving and
 * whether it is a stale fallback. The memo stores plain
 * {@link ResolvedWorkerSource}, so serve info can never leak across requests
 * by construction.
 */
export type ServedWorkerSource = ResolvedWorkerSource & { serveInfo?: WorkerServeInfo };

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
   * running in the background). Omitted = wait for the build. */
  buildBudgetMs?: number;
  projectId: string;
  source: DynamicWorkerSource;
  /** The hosting request context's `ctx.waitUntil`. Budget-expired resolves,
   * background rebuilds, and last-good pointer notes are handed to it so
   * they survive the caller's request ending. */
  waitUntil: (promise: Promise<unknown>) => void;
}): Promise<ServedWorkerSource> {
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
 * build finishes into the artifact cache regardless, so the caller's retry
 * is a hit. */
async function withBuildBudget(
  resolution: Promise<ServedWorkerSource>,
  budgetMs: number | undefined,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<ServedWorkerSource> {
  if (budgetMs === undefined) return await resolution;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resolution,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // The losing resolution must outlive this request: when the caller
          // returns the building page, the runtime cancels the request's
          // pending work, and a build that hasn't finished dies with it —
          // every refresh would then restart the cold path from zero instead
          // of converging on the cached artifact.
          waitUntil(resolution.catch(() => {}));
          reject(new WorkerBuildInProgressError("This worker is still building."));
        }, budgetMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The resolve-scoped inputs the serve policy works with: which project,
 * which pinned source, which (sdk-injected) build options. */
type ResolveContext = {
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
}): Promise<ServedWorkerSource> {
  const options = canonicalWorkerBuildOptions(input.options);
  const resolved = await resolveFileSource({ projectId: input.projectId, source: input.source });
  const sharedKey = await workerBuildKey({
    compatibilityDate: WORKER_COMPATIBILITY_DATE,
    compatibilityFlags: WORKER_COMPATIBILITY_FLAGS,
    options,
    source: resolved,
  });
  // Runtime builds live under the project-scoped key (a project can influence
  // its own builder sandbox's output, so runtime artifacts are never shared);
  // the content-only key is the TRUSTED read-first tier, written exclusively
  // by the deploy-time template seeder — see build-key.ts.
  const buildKey = await projectWorkerBuildKey(input.projectId, sharedKey);
  const context: ResolveContext = { options, projectId: input.projectId, resolved };
  const store = new KvWorkerBuildArtifactStore(env.WORKER_BUILD_CACHE);

  const [trustedHit, projectHit] = await Promise.all([
    resolveCachedArtifact(sharedKey),
    resolveCachedArtifact(buildKey),
  ]);
  const hit = trustedHit ?? projectHit;
  if (hit !== null) {
    input.waitUntil(noteLastGoodBuild(store, context, hit.cacheKey));
    return freshServe(hit, resolved);
  }

  if (input.budgeted) {
    // The fetch lane never makes a browser wait on a build it can avoid: with
    // a previous good build on record, serve THAT — the rebuild (or its
    // recorded failure) rides along as serve info for the overlay.
    const [lastGood, failure] = await Promise.all([
      lastGoodArtifact(store, context, buildKey),
      store.getBuildFailure(buildKey),
    ]);
    if (failure !== null) {
      if (lastGood !== null) return staleServe(lastGood, "build-failed", failure);
      throw new WorkerBuildFailedError(failure.message);
    }
    if (lastGood !== null) {
      dispatchBackgroundBuild({ buildKey, context, store, waitUntil: input.waitUntil });
      return staleServe(lastGood, "building");
    }
    // Nothing to fall back on: answer "still building" from the in-flight
    // marker instead of piling a duplicate full build onto a running one —
    // the building page's poll loop otherwise multiplies cold builds per tab.
    if (await store.isBuildInFlight(buildKey)) {
      throw new WorkerBuildInProgressError("This worker is still building.");
    }
  } else {
    // Blocking callers REPLAY a recorded failure within its TTL instead of
    // re-running the build. Same-key retries — the at-least-once event
    // delivery loop above all — would otherwise boot a builder container per
    // attempt for a deterministically broken source, and enough broken-head
    // projects churning that way starves the deployment's whole container
    // capacity (observed live on preview e2e). A fix always commits a NEW
    // head → new key, so healing is never gated on the TTL.
    const recorded = await store.getBuildFailure(buildKey);
    if (recorded !== null) throw new WorkerBuildFailedError(recorded.message);
  }

  return freshServe(await runBuild(store, context, buildKey), resolved);
}

/**
 * One build-run through the build backend (the project's builder sandbox, or
 * local dev's host-toolchain endpoint — build-backend.ts). The file snapshot
 * is resolved HERE and passed by value (this worker owns the REPO binding),
 * sized by the ref's source masks; the artifact is written to the cache by
 * THIS side (the container never holds KV credentials) and returned by value,
 * so nothing waits on KV write propagation. A GENUINE build failure (the
 * backend's named error) is recorded so the fetch lane can fall back without
 * re-running it — and clears the in-flight marker, so budgeted callers are
 * never held in "building" by a build that already died; transport and
 * cancellation errors pass through unrecorded and stay retryable.
 *
 * Concurrent cold builds of one key are NOT deduped across isolates: they
 * converge on one content-addressed, idempotent artifact write — redundant
 * work, never wrong output.
 */
async function runBuild(
  store: KvWorkerBuildArtifactStore,
  context: ResolveContext,
  buildKey: string,
): Promise<ResolvedWorkerSource> {
  let marked = false;
  try {
    const files = await resolvedSourceFiles(context.projectId, context.resolved);
    // Best-effort duplicate suppression for budgeted callers (the building
    // page's poll loop would otherwise dispatch a fresh build per refresh);
    // the artifact write below always supersedes it.
    await store.markBuildInFlight(buildKey).then(
      () => {
        marked = true;
      },
      () => {},
    );
    const built = await executeWorkerBuild({
      buildKey,
      files,
      options: context.options,
    });
    const artifact: WorkerBuildArtifact = {
      buildKey,
      mainModule: built.mainModule,
      modules: built.modules,
    };
    await store.put(artifact);
    const resolvedSource = memoizeArtifact(artifact);
    await noteLastGoodBuild(store, context, buildKey);
    return resolvedSource;
  } catch (error) {
    // This attempt's build is dead, so clear the marker it set (a stranded
    // marker holds budgeted callers in "building" until its TTL) — but only
    // when it actually MARKED: a failure before that point must not wipe a
    // marker a concurrent sibling is relying on. The marker is per-key, so a
    // failed attempt clearing while a sibling still runs remains possible —
    // that costs duplicate (idempotent) builds, deliberately preferred over
    // the TTL-long wedge a stranded marker causes. Only GENUINE failures are
    // additionally recorded; transport errors stay retryable.
    const bookkeeping = marked ? [store.clearBuildInFlight(buildKey).catch(() => {})] : [];
    if (isWorkerBuildFailedError(error)) {
      bookkeeping.push(recordBuildFailure(store, buildKey, context.resolved, error));
    }
    await Promise.all(bookkeeping);
    throw error;
  }
}

function freshServe(
  artifact: ResolvedWorkerSource,
  resolved: ResolvedWorkerFileSource,
): ServedWorkerSource {
  if (resolved.type !== "repo") return artifact;
  return { ...artifact, serveInfo: { commitOid: resolved.commitOid, status: "fresh" } };
}

function staleServe(
  lastGood: { artifact: ResolvedWorkerSource; record: WorkerLastGoodBuild },
  reason: "build-failed" | "building",
  failure?: WorkerBuildFailure,
): ServedWorkerSource {
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
 *
 * Only live branch-head resolves participate: a pinned-commit ref names a
 * frozen build, and letting it read or move the pointer would regress the
 * branch worker's fallback to (or serve in place of) an arbitrary older
 * commit. Head-cache resolves are exactly the ones carrying a contentHash
 * (see build-key.ts).
 */
async function workerLastGoodKey(context: ResolveContext): Promise<string | null> {
  if (context.resolved.type !== "repo" || context.resolved.contentHash === undefined) return null;
  return await stableSha256({
    branch: context.resolved.branch,
    exclude:
      context.resolved.exclude === undefined ? undefined : [...context.resolved.exclude].sort(),
    include:
      context.resolved.include === undefined ? undefined : [...context.resolved.include].sort(),
    options: context.options,
    projectId: context.projectId,
    repoPath: context.resolved.repoPath,
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
  context: ResolveContext,
  buildKey: string,
): Promise<void> {
  const workerKey = await workerLastGoodKey(context);
  if (workerKey === null) return;
  const noteKey = `${workerKey}:${buildKey}`;
  if (lastGoodNoted.has(noteKey)) return;
  if (lastGoodNoted.size >= 512) lastGoodNoted.clear();
  lastGoodNoted.add(noteKey);
  const commitOid = context.resolved.type === "repo" ? context.resolved.commitOid : undefined;
  await store
    .putLastGood(workerKey, {
      at: new Date().toISOString(),
      buildKey,
      ...(commitOid !== undefined ? { commitOid } : {}),
    })
    .catch(() => {
      // A failed write must stay retryable by this isolate's next request.
      lastGoodNoted.delete(noteKey);
    });
}

/** The previous good build for this worker, loadable — or null (inline or
 * pinned source, no pointer yet, pointer at the current key, or artifact
 * expired). */
async function lastGoodArtifact(
  store: KvWorkerBuildArtifactStore,
  context: ResolveContext,
  currentBuildKey: string,
): Promise<{ artifact: ResolvedWorkerSource; record: WorkerLastGoodBuild } | null> {
  const workerKey = await workerLastGoodKey(context);
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
      // Already bounded by the builder's named wrap; message extraction here
      // keeps locally-thrown failures (none today) equally safe.
      message: error instanceof Error ? error.message : String(error),
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
  context: ResolveContext;
  store: KvWorkerBuildArtifactStore;
  waitUntil: (promise: Promise<unknown>) => void;
}): void {
  const { buildKey, context, store } = input;
  if (backgroundBuilds.has(buildKey)) return;
  backgroundBuilds.add(buildKey);
  input.waitUntil(
    (async () => {
      try {
        // Another isolate's builder run marked in-flight; its artifact write
        // will land — do not pile a duplicate npm build on top.
        if (await store.isBuildInFlight(buildKey)) return;
        await runBuild(store, context, buildKey);
      } catch (error) {
        // Genuine build failures were recorded inside runBuild; anything
        // else (transport, cancellation) just ends this attempt — the next
        // request redispatches.
        if (!isWorkerBuildFailedError(error)) {
          console.warn(
            `background worker build attempt failed for ${buildKey.slice(0, 12)}`,
            error,
          );
        }
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
 * and artifact are immutable and auditable. Repo sources that omit `exclude`
 * get the canonical default masks HERE — before the key is computed — so a
 * bare `{ type: "repo", repoPath }` ref (the template's app refs, most
 * userland refs) and defaultProjectWorkerRef hash to the same build key and
 * share one artifact, the deploy-time template seed included. */
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
  const exclude = source.files.exclude ?? DEFAULT_REPO_WORKER_SOURCE_EXCLUDE;

  if (source.files.ref !== undefined && "commitOid" in source.files.ref) {
    return {
      branch: source.files.ref.branch,
      commitOid: source.files.ref.commitOid,
      exclude,
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
    exclude,
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
    // ITERATE_WORKER_VERSION is the worker's own build identity — the same
    // content-addressed key this loader caches by. Its one job is to change
    // exactly when the worker's source does: the SDK's processor registry
    // uses it as the deploy version whose change resets a crash-looping
    // keepalive's backoff budget (the "antidote deploy" lane).
    env: { ...bindings, ITERATE_WORKER_VERSION: resolved.cacheKey },
    globalOutbound,
    mainModule: resolved.mainModule,
    modules: resolved.modules,
  }));
}

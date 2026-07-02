import { itxEnv as env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import type { DynamicWorkerRef, DynamicWorkerSource, WorkerBuildOptions } from "../../types.ts";
import { KvWorkerBuildArtifactStore, type WorkerBuildArtifact } from "./artifact-store.ts";
import { workerBuildKey, type ResolvedWorkerFileSource } from "./build-key.ts";
import { stableSha256 } from "./utils.ts";

const WORKER_COMPATIBILITY_DATE = "2026-05-01";
const WORKER_COMPATIBILITY_FLAGS = ["nodejs_compat"];

/**
 * How long a cold caller blocks on `worker-build/completed` before failing the
 * load. Generous on purpose: a first build can install npm dependencies from
 * the registry inside the bundler.
 */
const BUILD_WAIT_TIMEOUT_MS = 120_000;

/**
 * Fully materialized Worker Loader input plus a cache key for the built bytes.
 * The cache key is build identity only; runtime scope and exported symbol are
 * added by `loadResolvedWorker` so the same artifact can be used in multiple
 * ITX paths without leaking bindings or entrypoint props across scopes.
 */
export type ResolvedWorkerSource = {
  cacheKey: string;
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  mainModule: string;
  modules: Record<string, string>;
};

export type WorkerBindings = Record<string, unknown>;

// Artifacts are immutable (content-addressed by build key), so a small
// per-isolate memo removes the KV manifest+module reads from warm loads.
const resolvedArtifactMemo = new Map<string, ResolvedWorkerSource>();
const RESOLVED_ARTIFACT_MEMO_LIMIT = 64;

// Concurrent cold loads of the same build key share ONE request/wait cycle
// instead of stampeding the stream with duplicate build requests.
const inFlightResolutions = new Map<string, Promise<ResolvedWorkerSource>>();

export async function resolveWorkerSource({
  path,
  projectId,
  source,
}: {
  /** ITX scope path of the worker ref — the stream that owns build lifecycle. */
  path: string;
  projectId: string;
  source: DynamicWorkerSource;
}): Promise<ResolvedWorkerSource> {
  const options = source.options ?? {};

  // Loader-ready degenerate case: inline JavaScript with bundling explicitly
  // off is exactly what the Worker Loader consumes, so materialization is the
  // identity function. Taking it without stream events keeps run-script (which
  // executes on every agent turn) at direct-load latency instead of paying a
  // build round trip per script.
  const loaderReady = await loaderReadyInlineSource(source, options);
  if (loaderReady !== null) return loaderReady;

  const resolved = await resolveFileSource({ projectId, source });
  const buildKey = await workerBuildKey({
    compatibilityDate: WORKER_COMPATIBILITY_DATE,
    compatibilityFlags: WORKER_COMPATIBILITY_FLAGS,
    options,
    source: resolved,
  });

  const memoized = resolvedArtifactMemo.get(buildKey);
  if (memoized !== undefined) return memoized;

  const inFlight = inFlightResolutions.get(buildKey);
  if (inFlight !== undefined) return await inFlight;
  const resolution = resolveThroughBuildPipeline({
    buildKey,
    options,
    path,
    projectId,
    source: resolved,
  }).finally(() => inFlightResolutions.delete(buildKey));
  inFlightResolutions.set(buildKey, resolution);
  return await resolution;
}

async function resolveThroughBuildPipeline(input: {
  buildKey: string;
  options: WorkerBuildOptions;
  path: string;
  projectId: string;
  source: ResolvedWorkerFileSource;
}): Promise<ResolvedWorkerSource> {
  const store = new KvWorkerBuildArtifactStore(env.WORKER_BUILD_CACHE);

  const cached = await store.get(input.buildKey);
  if (cached !== null) return memoizeArtifact(cached);

  // Cache miss: ask the worker-build processor on this ref's scope stream to
  // build, then block on the terminal fact. Blocking during resolution keeps
  // errors attributable to the call that needed the worker and keeps the
  // loader path below dumb.
  const stream = env.STREAM.getByName(
    DurableObjectNameCodec.stringify({ path: input.path, projectId: input.projectId }),
  );
  const [requested] = await stream.append({
    type: "events.iterate.com/worker-build/requested",
    payload: {
      buildKey: input.buildKey,
      compatibilityDate: WORKER_COMPATIBILITY_DATE,
      compatibilityFlags: WORKER_COMPATIBILITY_FLAGS,
      options: input.options as Record<string, unknown>,
      source: input.source,
    },
  });

  // A build that completed between the cache check and the append emitted its
  // terminal event BEFORE our requested offset, so waiting forward would hang;
  // one re-check closes that window (the processor also re-announces
  // completion for cache hits, so this is belt and braces).
  const raced = await store.get(input.buildKey);
  if (raced !== null) return memoizeArtifact(raced);

  const terminal = await stream.waitForEvent({
    afterOffset: requested.offset,
    eventTypes: [
      "events.iterate.com/worker-build/completed",
      "events.iterate.com/worker-build/failed",
    ],
    predicate: (event) => event.payload?.buildKey === input.buildKey,
    timeoutMs: BUILD_WAIT_TIMEOUT_MS,
  });

  if (terminal.type === "events.iterate.com/worker-build/failed") {
    throw new Error(
      `Worker build failed (${String(terminal.payload?.phase)}): ${String(terminal.payload?.message)}`,
    );
  }

  const artifact = await store.get(input.buildKey);
  if (artifact === null) {
    throw new Error(
      `Worker build ${input.buildKey} reported completion but the artifact store has no artifact.`,
    );
  }
  return memoizeArtifact(artifact);
}

function memoizeArtifact(artifact: WorkerBuildArtifact): ResolvedWorkerSource {
  const resolved: ResolvedWorkerSource = {
    cacheKey: artifact.buildKey,
    compatibilityDate: artifact.compatibilityDate,
    compatibilityFlags: artifact.compatibilityFlags,
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
  loader,
  projectId,
  ref,
  resolved,
  workerScopeKey,
}: {
  bindings: WorkerBindings;
  globalOutbound: Fetcher;
  loader: WorkerLoader;
  projectId: string;
  ref: DynamicWorkerRef;
  resolved: ResolvedWorkerSource;
  workerScopeKey: string;
}): WorkerStub {
  // The Worker Loader cache must separate all runtime-relevant dimensions. In
  // particular `workerScopeKey` prevents a worker loaded for an agent path from
  // reusing a project-root `env.ITX` binding, even if the module bytes match.
  const exportKey =
    ref.type === "stateless"
      ? `entrypoint:${ref.entrypoint ?? "default"}`
      : `durable-object:${ref.className}`;
  const cacheKey = [
    "worker-loader",
    projectId,
    ref.path,
    workerScopeKey,
    ref.type,
    exportKey,
    resolved.cacheKey,
  ].join(":");
  return loader.get(cacheKey, () => ({
    compatibilityDate: resolved.compatibilityDate ?? WORKER_COMPATIBILITY_DATE,
    compatibilityFlags: resolved.compatibilityFlags ?? WORKER_COMPATIBILITY_FLAGS,
    env: bindings,
    globalOutbound,
    mainModule: resolved.mainModule,
    modules: resolved.modules,
  }));
}

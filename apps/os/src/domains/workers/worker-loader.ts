import { disposeIgnoredRpcResult } from "iterate/sdk/capnweb";
import { itxEnv as env, workerVersion } from "../../env.ts";
import { parseIterateRepoPkgSpecOverridesEnv } from "../../pkg-pr-new.ts";
import { StreamContext } from "../projects/stream-context.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import type { DynamicWorkerSource, WorkerFileSource } from "./schemas.ts";
import {
  KvWorkerBuildArtifactStore,
  type WorkerBuildArtifact,
  type WorkerBuildFailure,
  type WorkerBuildModule,
} from "./artifact-store.ts";
import { workerBuildKey, type ResolvedWorkerFileSource } from "./build-key.ts";
import { WORKER_COMPATIBILITY_DATE, WORKER_COMPATIBILITY_FLAGS } from "./build-backend.ts";
import { coordinateWorkerBuild, type WorkerBuildRequest } from "./worker-build-capability.ts";

/** Name-based because the error crosses Workers RPC. */
export function isWorkerBuildInProgressError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === "WorkerBuildInProgressError";
}

export type ResolvedWorkerSource = {
  /** Browser assets stay in OS and never enter Worker Loader. */
  assetConfig: WorkerBuildArtifact["assetConfig"];
  assetManifest: WorkerBuildArtifact["assetManifest"];
  assets: Record<string, string>;
  cacheKey: string;
  commitOid?: string;
  mainModule: string;
  modules: Record<string, WorkerBuildModule>;
  wranglerConfig: WorkerBuildArtifact["wranglerConfig"];
};
export type ResolvedWorkerSourceResult =
  | { ok: true; source: ResolvedWorkerSource }
  | { failure: WorkerBuildFailure; ok: false };
export type WorkerBindings = Record<string, unknown>;

const resolvedArtifactMemo = new Map<string, ResolvedWorkerSource>();
const RESOLVED_ARTIFACT_MEMO_LIMIT = 64;

export async function resolveWorkerSource({
  buildBudgetMs,
  projectId,
  source,
}: {
  /** Stop waiting on a cache-missed build after this long; the coordinator continues it. */
  buildBudgetMs?: number;
  projectId: string;
  source: DynamicWorkerSource;
}): Promise<ResolvedWorkerSourceResult> {
  return await resolveThroughBuild({ buildBudgetMs, projectId, source });
}

async function resolveThroughBuild(input: {
  buildBudgetMs?: number;
  projectId: string;
  source: DynamicWorkerSource;
}): Promise<ResolvedWorkerSourceResult> {
  const iterateRepoPkgRef = env.APP_CONFIG_ITERATE_REPO_PKG_REF?.trim() || undefined;
  const iterateRepoPkgSpecOverrides = parseIterateRepoPkgSpecOverridesEnv(
    env.APP_CONFIG_ITERATE_REPO_PKG_SPEC_OVERRIDES,
  );
  const resolved = await resolveFileSource({
    files:
      "createApp" in input.source ? input.source.createApp.files : input.source.createWorker.files,
    projectId: input.projectId,
  });
  const buildKey = await workerBuildKey({
    compatibilityDate: WORKER_COMPATIBILITY_DATE,
    compatibilityFlags: WORKER_COMPATIBILITY_FLAGS,
    files: resolved,
    iterateRepoPkgRef,
    iterateRepoPkgSpecOverrides,
    source: input.source,
  });
  const memoized = resolvedArtifactMemo.get(buildKey);
  const built =
    memoized === undefined
      ? await resolveArtifact(buildKey, {
          buildBudgetMs: input.buildBudgetMs,
          projectId: input.projectId,
          resolved,
          iterateRepoPkgRef,
          iterateRepoPkgSpecOverrides,
          source: input.source,
        })
      : { ok: true as const, source: memoized };
  if (!built.ok) return built;
  return {
    ok: true,
    source:
      resolved.type === "repo" ? { ...built.source, commitOid: resolved.commitOid } : built.source,
  };
}

async function resolveArtifact(
  buildKey: string,
  context: {
    buildBudgetMs?: number;
    projectId: string;
    resolved: ResolvedWorkerFileSource;
    iterateRepoPkgRef?: string;
    iterateRepoPkgSpecOverrides?: Record<string, string>;
    source: DynamicWorkerSource;
  },
): Promise<ResolvedWorkerSourceResult> {
  const store = new KvWorkerBuildArtifactStore(env.WORKER_BUILD_CACHE);
  const artifact = await store.get(buildKey);
  if (artifact !== null) return { ok: true, source: memoizeArtifact(artifact) };

  const request: WorkerBuildRequest = {
    buildKey,
    iterateRepoPkgRef: context.iterateRepoPkgRef,
    iterateRepoPkgSpecOverrides: context.iterateRepoPkgSpecOverrides,
    projectId: context.projectId,
    resolved: context.resolved,
    source: context.source,
  };
  const operation = coordinateWorkerBuild(request, context.buildBudgetMs);
  let built: Awaited<typeof operation> | undefined;
  try {
    built = await operation;
    return built.ok
      ? { ok: true, source: memoizeArtifact(built.artifact) }
      : { failure: built.failure, ok: false };
  } finally {
    // RPC adds a disposal group to object results even when they contain only
    // data today. Memoization copied the fields we retain, so release it now.
    disposeIgnoredRpcResult(built);
  }
}

function memoizeArtifact(artifact: WorkerBuildArtifact): ResolvedWorkerSource {
  const resolved: ResolvedWorkerSource = {
    assetConfig: artifact.assetConfig,
    assetManifest: artifact.assetManifest,
    assets: artifact.assets,
    cacheKey: artifact.buildKey,
    mainModule: artifact.mainModule,
    modules: artifact.modules,
    wranglerConfig: artifact.wranglerConfig,
  };
  if (resolvedArtifactMemo.size >= RESOLVED_ARTIFACT_MEMO_LIMIT) {
    const oldest = resolvedArtifactMemo.keys().next().value;
    if (oldest !== undefined) resolvedArtifactMemo.delete(oldest);
  }
  resolvedArtifactMemo.set(artifact.buildKey, resolved);
  return resolved;
}

/** Pin a branch to a commit before hashing or reading its file snapshot. */
async function resolveFileSource({
  files,
  projectId,
}: {
  files: WorkerFileSource;
  projectId: string;
}): Promise<ResolvedWorkerFileSource> {
  if (files.type === "inline") {
    return { files: files.files, type: "inline" };
  }
  if (files.ref !== undefined && "commitOid" in files.ref) {
    return {
      branch: files.ref.branch,
      commitOid: files.ref.commitOid,
      exclude: files.exclude,
      include: files.include,
      repoPath: files.repoPath,
      type: "repo",
    };
  }

  const repo = env.REPO.getByName(
    DurableObjectNameCodec.stringify({ path: files.repoPath, projectId }),
  );
  try {
    const head = await repo.getHead(files.ref === undefined ? {} : { branch: files.ref.branch });
    try {
      return {
        branch: head.branch,
        commitOid: head.commitOid,
        contentHash: head.contentHash,
        exclude: files.exclude,
        include: files.include,
        repoPath: files.repoPath,
        type: "repo",
      };
    } finally {
      disposeIgnoredRpcResult(head);
    }
  } finally {
    try {
      disposeIgnoredRpcResult(repo);
    } catch (error) {
      console.warn("worker source repo Durable Object stub dispose failed", {
        error,
        projectId,
        repoPath: files.repoPath,
      });
    }
  }
}

export function loadResolvedWorker({
  bindings,
  globalOutbound,
  loaderInstanceNonce,
  mode,
  projectId,
  resolved,
  scopePath,
  streamContext,
}: {
  bindings: WorkerBindings;
  globalOutbound: Fetcher;
  /** Extra key component partitioning the loader cache by binding lifetime.
   * Undefined loads under the bare identity — the cheap steady state. */
  loaderInstanceNonce: string | undefined;
  /** Reusable apps keep a content-addressed isolate warm; one-off code-mode
   * executions must not leave a cache entry behind after every unique run. */
  mode: "cached" | "one-off";
  projectId: string;
  resolved: ResolvedWorkerSource;
  scopePath: string;
  streamContext: StreamContext;
}): WorkerStub {
  const workerCode: WorkerLoaderWorkerCode = {
    compatibilityDate: resolved.wranglerConfig?.compatibilityDate || WORKER_COMPATIBILITY_DATE,
    compatibilityFlags: resolved.wranglerConfig?.compatibilityFlags || WORKER_COMPATIBILITY_FLAGS,
    env: { ...bindings, ITERATE_WORKER_VERSION: resolved.cacheKey },
    globalOutbound,
    mainModule: resolved.mainModule,
    modules: resolved.modules,
  };
  if (mode === "one-off") return env.LOADER.load(workerCode);

  // THIS KEY IS UNBELIEVABLY EXPENSIVE TO GET WRONG. Cloudflare bills every
  // distinct value ever passed to LOADER.get as a Dynamic Worker per day, so
  // the key's cardinality is a direct dollar amount: a per-request component
  // here turned ordinary traffic into ~3.9M billable identities (~$7.8k) in
  // three weeks (2026-08), while also forcing a cold isolate build on every
  // request and every stream delivery. Never add a key component without
  // pricing its cardinality first.
  //
  // Loader isolates capture loopback RPC bindings minted by whoever loaded
  // them first; using those from a mismatched lifetime fails with "Unable to
  // deserialize cloned data due to invalid or unsupported version". The
  // request-scoped lanes AND the stream facet lane load under the bare
  // identity below and recover from that skew reactively (see
  // DynamicWorkerRunner's loaderScope: the retry, and the stream DO's
  // facet-call recovery, supply a recovery nonce). Reuse across DO
  // incarnations is sanctioned: the baked env is loopback stubs with
  // serializable props, valid for the deployment's life. Build artifacts
  // remain content-addressed and shared. The deployment id keeps identities
  // easy to attribute and guarantees separation across a rollout.
  const loaderIdentity = [
    "worker-loader",
    env.WORKER_SELF,
    workerVersion(env),
    projectId,
    scopePath,
    JSON.stringify(StreamContext.parse(streamContext)),
    resolved.cacheKey,
  ].join(":");
  const cacheKey =
    loaderInstanceNonce === undefined
      ? loaderIdentity
      : [loaderIdentity, loaderInstanceNonce].join(":");
  return env.LOADER.get(cacheKey, () => workerCode);
}

import { disposeIgnoredRpcResult } from "iterate/sdk/capnweb";
import { itxEnv as env, workerVersion } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import type { DynamicWorkerSource, WorkerFileSource } from "./schemas.ts";
import {
  KvWorkerBuildArtifactStore,
  type WorkerBuildArtifact,
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
}): Promise<ResolvedWorkerSource> {
  return await resolveThroughBuild({ buildBudgetMs, projectId, source });
}

async function resolveThroughBuild(input: {
  buildBudgetMs?: number;
  projectId: string;
  source: DynamicWorkerSource;
}): Promise<ResolvedWorkerSource> {
  const iteratePackageSpec = env.APP_CONFIG_ITERATE_SDK_PACKAGE_SPEC?.trim() || undefined;
  const resolved = await resolveFileSource({
    files:
      "createApp" in input.source ? input.source.createApp.files : input.source.createWorker.files,
    projectId: input.projectId,
  });
  const buildKey = await workerBuildKey({
    compatibilityDate: WORKER_COMPATIBILITY_DATE,
    compatibilityFlags: WORKER_COMPATIBILITY_FLAGS,
    files: resolved,
    iteratePackageSpec,
    source: input.source,
  });
  const artifact =
    resolvedArtifactMemo.get(buildKey) ??
    (await resolveArtifact(buildKey, {
      buildBudgetMs: input.buildBudgetMs,
      projectId: input.projectId,
      resolved,
      iteratePackageSpec,
      source: input.source,
    }));
  return resolved.type === "repo" ? { ...artifact, commitOid: resolved.commitOid } : artifact;
}

async function resolveArtifact(
  buildKey: string,
  context: {
    buildBudgetMs?: number;
    projectId: string;
    resolved: ResolvedWorkerFileSource;
    iteratePackageSpec?: string;
    source: DynamicWorkerSource;
  },
): Promise<ResolvedWorkerSource> {
  const store = new KvWorkerBuildArtifactStore(env.WORKER_BUILD_CACHE);
  const artifact = await store.get(buildKey);
  if (artifact !== null) return memoizeArtifact(artifact);

  const request: WorkerBuildRequest = {
    buildKey,
    iteratePackageSpec: context.iteratePackageSpec,
    projectId: context.projectId,
    resolved: context.resolved,
    source: context.source,
  };
  const operation = coordinateWorkerBuild(request, context.buildBudgetMs);
  let built: WorkerBuildArtifact | undefined;
  try {
    built = await operation;
    return memoizeArtifact(built);
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
}

export function loadResolvedWorker({
  bindings,
  globalOutbound,
  projectId,
  resolved,
  scopePath,
}: {
  bindings: WorkerBindings;
  globalOutbound: Fetcher;
  projectId: string;
  resolved: ResolvedWorkerSource;
  scopePath: string;
}): WorkerStub {
  // Loader isolates capture the parent deployment's loopback RPC bindings.
  // They must not survive an OS rollout: a hit created by the previous
  // version can only speak that version of workerd's cloned-data protocol,
  // and crossing it from the new parent fails with
  // "Unable to deserialize cloned data due to invalid or unsupported version".
  // Build artifacts remain content-addressed and shared; only the cheap
  // loaded isolate is deployment-scoped.
  const cacheKey = [
    "worker-loader",
    env.WORKER_SELF,
    workerVersion(env),
    projectId,
    scopePath,
    resolved.cacheKey,
  ].join(":");
  return env.LOADER.get(cacheKey, () => ({
    compatibilityDate: resolved.wranglerConfig?.compatibilityDate ?? WORKER_COMPATIBILITY_DATE,
    compatibilityFlags: resolved.wranglerConfig?.compatibilityFlags ?? WORKER_COMPATIBILITY_FLAGS,
    env: { ...bindings, ITERATE_WORKER_VERSION: resolved.cacheKey },
    globalOutbound,
    mainModule: resolved.mainModule,
    modules: resolved.modules,
  }));
}

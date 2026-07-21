import { itxEnv as env, workerVersion } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import type { DynamicWorkerSource, WorkerFileSource } from "./schemas.ts";
import {
  KvWorkerBuildArtifactStore,
  type WorkerBuildArtifact,
  type WorkerBuildModule,
} from "./artifact-store.ts";
import { workerBuildKey, type ResolvedWorkerFileSource } from "./build-key.ts";
import {
  WORKER_COMPATIBILITY_DATE,
  WORKER_COMPATIBILITY_FLAGS,
  executeWorkerBuild,
} from "./build-backend.ts";

class WorkerBuildInProgressError extends Error {
  override readonly name = "WorkerBuildInProgressError";
}

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
  waitUntil,
}: {
  /** Give up on a cold resolve after this long; the build continues. */
  buildBudgetMs?: number;
  projectId: string;
  source: DynamicWorkerSource;
  waitUntil: (promise: Promise<unknown>) => void;
}): Promise<ResolvedWorkerSource> {
  const resolution = resolveThroughBuild({ projectId, source });
  return await withBuildBudget(resolution, buildBudgetMs, waitUntil);
}

/** Race a cold resolve against the browser budget without cancelling it. */
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
          waitUntil(
            resolution.catch((error: unknown) => {
              console.error("background dynamic worker build failed", error);
            }),
          );
          reject(new WorkerBuildInProgressError("This worker is still building."));
        }, budgetMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function resolveThroughBuild(input: {
  projectId: string;
  source: DynamicWorkerSource;
}): Promise<ResolvedWorkerSource> {
  const resolved = await resolveFileSource({
    files:
      "createApp" in input.source ? input.source.createApp.files : input.source.createWorker.files,
    projectId: input.projectId,
  });
  const buildKey = await workerBuildKey({
    compatibilityDate: WORKER_COMPATIBILITY_DATE,
    compatibilityFlags: WORKER_COMPATIBILITY_FLAGS,
    files: resolved,
    source: input.source,
  });
  const artifact =
    resolvedArtifactMemo.get(buildKey) ??
    (await resolveArtifact(buildKey, {
      projectId: input.projectId,
      resolved,
      source: input.source,
    }));
  return resolved.type === "repo" ? { ...artifact, commitOid: resolved.commitOid } : artifact;
}

async function resolveArtifact(
  buildKey: string,
  context: {
    projectId: string;
    resolved: ResolvedWorkerFileSource;
    source: DynamicWorkerSource;
  },
): Promise<ResolvedWorkerSource> {
  const store = new KvWorkerBuildArtifactStore(env.WORKER_BUILD_CACHE);
  const artifact = await store.get(buildKey);
  return artifact === null ? await runBuild(store, context, buildKey) : memoizeArtifact(artifact);
}

/** Build one immutable source snapshot. */
async function runBuild(
  store: KvWorkerBuildArtifactStore,
  context: {
    projectId: string;
    resolved: ResolvedWorkerFileSource;
    source: DynamicWorkerSource;
  },
  buildKey: string,
): Promise<ResolvedWorkerSource> {
  const files = await resolvedSourceFiles(context.projectId, context.resolved);
  const built = await executeWorkerBuild({
    files,
    source: context.source,
    workerBundler: env.WORKER_BUNDLER,
  });
  if (built.warnings.length > 0) {
    console.warn("dynamic worker build completed with warnings", {
      buildKey,
      warnings: built.warnings,
    });
  }
  const artifact: WorkerBuildArtifact = {
    ...(built.assetConfig === undefined ? {} : { assetConfig: built.assetConfig }),
    assetManifest: built.assetManifest,
    assets: built.assets,
    buildKey,
    createdAt: new Date().toISOString(),
    mainModule: built.mainModule,
    modules: built.modules,
    ...(built.warnings.length === 0 ? {} : { warnings: built.warnings }),
    ...(built.wranglerConfig === undefined ? {} : { wranglerConfig: built.wranglerConfig }),
  };
  await store.put(artifact);
  return memoizeArtifact(artifact);
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
  return {
    branch: head.branch,
    commitOid: head.commitOid,
    contentHash: head.contentHash,
    exclude: files.exclude,
    include: files.include,
    repoPath: files.repoPath,
    type: "repo",
  };
}

/** Read source files only on an artifact-cache miss. */
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

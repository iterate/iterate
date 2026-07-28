import { disposeIgnoredRpcResult } from "iterate/sdk/capnweb";
import { itxEnv as env, workerDeploymentVersion, type Env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import {
  acquireDurableObjectDeploymentTarget,
  describeDeploymentVersion,
  type DurableObjectDeploymentTarget,
} from "../durable-object-deployment-readiness.ts";
import {
  KvWorkerBuildArtifactStore,
  type WorkerBuildArtifact,
  type WorkerBuildResult,
} from "./artifact-store.ts";
import { executeWorkerBuild } from "./build-backend.ts";
import type { ResolvedWorkerFileSource } from "./build-key.ts";
import type { DynamicWorkerSource } from "./schemas.ts";

export type WorkerBuildRequest = {
  buildKey: string;
  iterateRepoPkgRef?: string;
  iterateRepoPkgSpecOverrides?: Record<string, string>;
  projectId: string;
  resolved: ResolvedWorkerFileSource;
  source: DynamicWorkerSource;
};

/** A caller-owned wait on a build whose execution is anchored by the coordinator actor. */
type WorkerBuildOperation = Promise<WorkerBuildResult> & Partial<Disposable>;

type WorkerBuildCoordinatorTarget = DurableObjectDeploymentTarget & {
  build(request: WorkerBuildRequest, buildBudgetMs?: number): Promise<WorkerBuildResult>;
};

/** Route one immutable build to its globally keyed coordinator actor. */
export function coordinateWorkerBuild(
  request: WorkerBuildRequest,
  buildBudgetMs?: number,
): WorkerBuildOperation {
  return (async () => {
    const expectedVersion = workerDeploymentVersion(env);
    const { readiness, target } = await acquireDurableObjectDeploymentTarget({
      expectedVersion,
      getTarget: () =>
        env.WORKER_BUILD_COORDINATOR.getByName(
          request.buildKey,
        ) as unknown as WorkerBuildCoordinatorTarget,
      notReadyError: (detail, cause) => {
        const message =
          `Worker build coordinator for "${request.buildKey}" was not ready for deployment ` +
          `version ${describeDeploymentVersion(expectedVersion)} before the build was requested: ` +
          `${detail}. The build was not sent to the coordinator.`;
        return cause === undefined ? new Error(message) : new Error(message, { cause });
      },
    });
    if (readiness.probes > 1 || readiness.targetNewer) {
      console.info("worker build coordinator deployment version converged before build", {
        buildKey: request.buildKey,
        expectedDeploymentVersion: expectedVersion,
        lifecycleFailures: readiness.lifecycleFailures,
        mismatches: readiness.mismatches,
        observedDeploymentVersion: readiness.observedVersion,
        probeTimeouts: readiness.probeTimeouts,
        probes: readiness.probes,
        projectId: request.projectId,
        targetNewer: readiness.targetNewer,
        waitedMs: readiness.waitedMs,
      });
    }
    return await target.build(request, buildBudgetMs);
  })() as WorkerBuildOperation;
}

/**
 * Resolve and compile one immutable worker source snapshot.
 *
 * This is the coordinator's privileged authority adapter: it can read project
 * repos, invoke the compiler sidecar, and fill the artifact cache. Rechecking
 * KV closes the race between the caller's miss and arrival at the keyed
 * Durable Object; resolving repo files here means followers do not repeat the
 * snapshot read. KV is deliberately not a lease because its consistency model
 * has no atomic lock primitive:
 * https://developers.cloudflare.com/kv/concepts/how-kv-works/#consistency
 */
export async function executeCoordinatedWorkerBuild(
  request: WorkerBuildRequest,
  buildEnv: Pick<Env, "REPO" | "WORKER_BUILD_CACHE" | "WORKER_BUNDLER">,
): Promise<WorkerBuildResult> {
  const store = new KvWorkerBuildArtifactStore(buildEnv.WORKER_BUILD_CACHE);
  const cached = await store.get(request.buildKey);
  if (cached !== null) return { artifact: cached, ok: true };

  const files = await resolvedSourceFiles(buildEnv, request.projectId, request.resolved);
  const result = await executeWorkerBuild({
    files,
    iterateRepoPkgRef: request.iterateRepoPkgRef,
    iterateRepoPkgSpecOverrides: request.iterateRepoPkgSpecOverrides,
    source: request.source,
    workerBundler: buildEnv.WORKER_BUNDLER,
  });
  if (!result.ok) return result;
  const built = result.output;
  if (built.warnings.length > 0) {
    console.warn("dynamic worker build completed with warnings", {
      buildKey: request.buildKey,
      warnings: built.warnings,
    });
  }
  const artifact: WorkerBuildArtifact = {
    ...(built.assetConfig === undefined ? {} : { assetConfig: built.assetConfig }),
    assetManifest: built.assetManifest,
    assets: built.assets,
    buildKey: request.buildKey,
    createdAt: new Date().toISOString(),
    mainModule: built.mainModule,
    modules: built.modules,
    ...(built.warnings.length === 0 ? {} : { warnings: built.warnings }),
    ...(built.wranglerConfig === undefined ? {} : { wranglerConfig: built.wranglerConfig }),
  };
  await store.put(artifact);
  return { artifact, ok: true };
}

/** Read source files only after both artifact-cache checks miss. */
async function resolvedSourceFiles(
  buildEnv: Pick<Env, "REPO">,
  projectId: string,
  resolved: ResolvedWorkerFileSource,
) {
  if (resolved.type === "inline") return resolved.files;
  const repo = buildEnv.REPO.getByName(
    DurableObjectNameCodec.stringify({ path: resolved.repoPath, projectId }),
  );
  const snapshot = await repo.getFilesSnapshot({
    branch: resolved.branch,
    commitOid: resolved.commitOid,
    exclude: resolved.exclude,
    include: resolved.include,
  });
  try {
    return snapshot.files;
  } finally {
    disposeIgnoredRpcResult(snapshot);
  }
}

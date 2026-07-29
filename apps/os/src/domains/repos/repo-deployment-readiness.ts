import { disposeIgnoredRpcResult } from "iterate/sdk/capnweb";
import type { WorkerDeploymentVersionFormat } from "../../env.ts";
import {
  acquireDurableObjectDeploymentTarget,
  describeDeploymentVersion,
  type DeploymentVersionReadinessOptions,
  type WorkerDeploymentVersionLike,
} from "../durable-object-deployment-readiness.ts";
import type { CommitRepoFilesInput, CommitRepoFilesResult } from "./types.ts";

type RepoDeploymentTarget = {
  commitFiles(input: CommitRepoFilesInput): Promise<CommitRepoFilesResult>;
  deploymentVersion: (
    format: WorkerDeploymentVersionFormat,
  ) => PromiseLike<WorkerDeploymentVersionLike> | WorkerDeploymentVersionLike;
};

type CommitFilesOnDeploymentReadyRepoInput = {
  commit: CommitRepoFilesInput;
  expectedVersion: WorkerDeploymentVersionLike;
  getRepo: () => RepoDeploymentTarget;
  path: string;
  projectId: string | null;
};

function commitNotSentError(
  input: CommitFilesOnDeploymentReadyRepoInput,
  detail: string,
  cause?: unknown,
): Error {
  const message =
    `Repo at "${input.path}" was not ready for deployment version ` +
    `${describeDeploymentVersion(input.expectedVersion)} before commitFiles was requested: ` +
    `${detail}. No repo mutation was sent.`;
  return cause === undefined ? new Error(message) : new Error(message, { cause });
}

function disposeRepoRpcValue(
  value: unknown,
  kind: "commit RPC result" | "Durable Object stub",
  input: CommitFilesOnDeploymentReadyRepoInput,
): void {
  try {
    disposeIgnoredRpcResult(value);
  } catch (error) {
    // The mutation outcome is already authoritative. Keep cleanup failure
    // observable without replacing success or inviting an unsafe replay.
    console.warn(`repo ${kind} dispose failed`, {
      error,
      path: input.path,
      projectId: input.projectId,
    });
  }
}

function detachCommitResult(
  result: CommitRepoFilesResult,
  input: CommitFilesOnDeploymentReadyRepoInput,
): CommitRepoFilesResult {
  try {
    const detached = {
      ...result,
      changedPaths: [...result.changedPaths],
    };
    Reflect.deleteProperty(detached, Symbol.dispose);
    return detached;
  } finally {
    disposeRepoRpcValue(result, "commit RPC result", input);
  }
}

/**
 * Keep a repo mutation behind the last read-only rollout boundary and issue it
 * through that exact proven stub. A fresh stub can still route to the
 * incarnation Cloudflare is replacing even when a sibling stub just reported
 * the current deployment version; replaying commitFiles after a lifecycle
 * reset would cross an indeterminate push boundary.
 */
export async function commitFilesOnDeploymentReadyRepo(
  input: CommitFilesOnDeploymentReadyRepoInput,
  readinessOptions: DeploymentVersionReadinessOptions = {},
): Promise<CommitRepoFilesResult> {
  const { readiness, target: readyRepo } = await acquireDurableObjectDeploymentTarget({
    ...readinessOptions,
    expectedVersion: input.expectedVersion,
    getTarget: input.getRepo,
    notReadyError: (detail, cause) => commitNotSentError(input, detail, cause),
  });
  if (readiness.probes > 1 || readiness.targetNewer) {
    console.info("repo deployment version converged before commitFiles", {
      expectedDeploymentVersion: input.expectedVersion,
      lifecycleFailures: readiness.lifecycleFailures,
      mismatches: readiness.mismatches,
      observedDeploymentVersion: readiness.observedVersion,
      path: input.path,
      platformFailures: readiness.platformFailures,
      probeTimeouts: readiness.probeTimeouts,
      probes: readiness.probes,
      projectId: input.projectId,
      targetNewer: readiness.targetNewer,
      waitedMs: readiness.waitedMs,
    });
  }
  try {
    return detachCommitResult(await readyRepo.commitFiles(input.commit), input);
  } finally {
    disposeRepoRpcValue(readyRepo, "Durable Object stub", input);
  }
}

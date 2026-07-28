import {
  describeDeploymentVersion,
  waitForDurableObjectDeploymentVersion,
  type DeploymentVersionReadinessOptions,
  type WorkerDeploymentVersionLike,
} from "../durable-object-deployment-readiness.ts";
import {
  WORKER_DEPLOYMENT_VERSION_METADATA_FORMAT,
  type WorkerDeploymentVersionFormat,
} from "../../env.ts";

type ProjectDeploymentTarget = {
  deploymentVersion: (
    format: WorkerDeploymentVersionFormat,
  ) => PromiseLike<WorkerDeploymentVersionLike> | WorkerDeploymentVersionLike;
  fetch: (request: Request) => Promise<Response>;
};

type FetchFromDeploymentReadyProjectInput = {
  expectedVersion: WorkerDeploymentVersionLike;
  getProject: () => ProjectDeploymentTarget;
  projectId: string;
  request: Request;
};

function requestNotForwardedError(
  input: FetchFromDeploymentReadyProjectInput,
  detail: string,
  cause?: unknown,
): Error {
  const message =
    `Project "${input.projectId}" was not ready for deployment version ` +
    `${describeDeploymentVersion(input.expectedVersion)} before outbound egress was requested: ` +
    `${detail}. ` +
    "The request was not forwarded and no external side effect ran.";
  return cause === undefined ? new Error(message) : new Error(message, { cause });
}

/**
 * Keep outbound work behind the edge-to-Project rollout boundary. A stale
 * Project can be reset while awaiting a Secret request, which could cancel a
 * credential refresh after the provider accepted it. The Project must
 * therefore run the edge's immutable Worker version or a provably newer one
 * before egress starts.
 */
export async function fetchFromDeploymentReadyProject(
  input: FetchFromDeploymentReadyProjectInput,
  readinessOptions: DeploymentVersionReadinessOptions = {},
): Promise<Response> {
  let readyProject: ProjectDeploymentTarget | undefined;
  const readiness = await waitForDurableObjectDeploymentVersion({
    ...readinessOptions,
    expectedVersion: input.expectedVersion,
    notReadyError: (detail, cause) => requestNotForwardedError(input, detail, cause),
    readVersion: () => {
      // Never poll a stub that may still be attached to the incarnation which
      // just reset. The eventual fetch uses the same freshly acquired stub
      // whose deployment probe established readiness.
      readyProject = input.getProject();
      return Promise.resolve(
        readyProject.deploymentVersion(WORKER_DEPLOYMENT_VERSION_METADATA_FORMAT),
      );
    },
  });
  if (readiness.probes > 1 || readiness.targetNewer) {
    console.info("project deployment version converged before outbound egress", {
      expectedDeploymentVersion: input.expectedVersion,
      lifecycleFailures: readiness.lifecycleFailures,
      mismatches: readiness.mismatches,
      observedDeploymentVersion: readiness.observedVersion,
      probeTimeouts: readiness.probeTimeouts,
      probes: readiness.probes,
      projectId: input.projectId,
      targetNewer: readiness.targetNewer,
      waitedMs: readiness.waitedMs,
    });
  }
  if (readyProject === undefined) {
    throw requestNotForwardedError(input, "the version probe returned no target");
  }
  return await readyProject.fetch(input.request);
}

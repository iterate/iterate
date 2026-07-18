import {
  UNVERSIONED_WORKER_BUILD_DEPLOYMENT_ID,
  type WorkerBuildDeployment,
} from "./worker-build-contract.ts";

const workerVersionHeader = "x-iterate-worker-version";

type WorkerBuildReadinessOptions = {
  expectedDeploymentId: string;
  readDeployment(): Promise<WorkerBuildDeployment>;
  version: string;
};

/** Combine main-worker and route-less builder identity into one readiness response. */
export async function workerBuildReadinessResponse(
  options: WorkerBuildReadinessOptions,
): Promise<Response> {
  let deploymentId = UNVERSIONED_WORKER_BUILD_DEPLOYMENT_ID;

  if (options.expectedDeploymentId !== UNVERSIONED_WORKER_BUILD_DEPLOYMENT_ID) {
    try {
      deploymentId = (await options.readDeployment()).deploymentId;
    } catch (error) {
      console.error("worker-build sidecar readiness RPC failed", error);
      return readinessResponse(options, null, false);
    }
  }

  return readinessResponse(options, deploymentId, deploymentId === options.expectedDeploymentId);
}

function readinessResponse(
  options: WorkerBuildReadinessOptions,
  deploymentId: string | null,
  ready: boolean,
): Response {
  return Response.json(
    {
      ok: ready,
      app: "os",
      version: options.version,
      workerBuildDeploymentId: deploymentId,
      ...(ready ? {} : { expectedWorkerBuildDeploymentId: options.expectedDeploymentId }),
    },
    {
      status: ready ? 200 : 503,
      headers: {
        "cache-control": "no-store",
        [workerVersionHeader]: options.version,
      },
    },
  );
}

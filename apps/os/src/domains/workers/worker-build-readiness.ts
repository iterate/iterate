import {
  UNVERSIONED_WORKER_BUILD_DEPLOYMENT_ID,
  type WorkerBuildDeployment,
} from "./worker-build-contract.ts";

const workerVersionHeader = "x-iterate-worker-version";

type WorkerBuildReadinessOptions = {
  expectedDeploymentId: string;
  readDeployment(): Promise<WorkerBuildDeployment>;
  readDurableObjectVersion(): Promise<string>;
  version: string;
};

/** Combine edge, Durable Object, and route-less builder identity into one readiness response. */
export async function workerBuildReadinessResponse(
  options: WorkerBuildReadinessOptions,
): Promise<Response> {
  const deploymentPromise =
    options.expectedDeploymentId === UNVERSIONED_WORKER_BUILD_DEPLOYMENT_ID
      ? Promise.resolve({ deploymentId: UNVERSIONED_WORKER_BUILD_DEPLOYMENT_ID })
      : options.readDeployment();
  const [deploymentResult, durableObjectVersionResult] = await Promise.allSettled([
    deploymentPromise,
    options.readDurableObjectVersion(),
  ]);

  if (deploymentResult.status === "rejected") {
    console.error("worker-build sidecar readiness RPC failed", deploymentResult.reason);
  }
  if (durableObjectVersionResult.status === "rejected") {
    // An old incarnation can legitimately lack this method while a new Worker
    // version is propagating. Keep that expected settling state out of error
    // telemetry; the 503 response remains the bounded readiness signal.
    console.info(
      "capability-host deployment readiness RPC is still settling",
      durableObjectVersionResult.reason,
    );
  }

  const deploymentId =
    deploymentResult.status === "fulfilled" ? deploymentResult.value.deploymentId : null;
  const durableObjectVersion =
    durableObjectVersionResult.status === "fulfilled" ? durableObjectVersionResult.value : null;

  return readinessResponse(
    options,
    deploymentId,
    durableObjectVersion,
    deploymentId === options.expectedDeploymentId && durableObjectVersion === options.version,
  );
}

function readinessResponse(
  options: WorkerBuildReadinessOptions,
  deploymentId: string | null,
  durableObjectVersion: string | null,
  ready: boolean,
): Response {
  return Response.json(
    {
      ok: ready,
      app: "os",
      version: options.version,
      durableObjectVersion,
      workerBuildDeploymentId: deploymentId,
      ...(deploymentId === options.expectedDeploymentId
        ? {}
        : { expectedWorkerBuildDeploymentId: options.expectedDeploymentId }),
      ...(durableObjectVersion === options.version
        ? {}
        : { expectedDurableObjectVersion: options.version }),
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

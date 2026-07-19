import {
  UNVERSIONED_WORKER_BUILD_DEPLOYMENT_ID,
  type WorkerBuildDeployment,
} from "./worker-build-contract.ts";

const workerVersionHeader = "x-iterate-worker-version";

/**
 * The deploy orchestrator increments this query parameter on each readiness
 * request. The health route folds it into the finite wave count below, so a
 * caller can make us exercise placements over time without being able to mint
 * an unbounded number of Durable Object names.
 */
export const deploymentReadinessProbeQueryParam = "deployment-probe";
const deploymentReadinessProbeWaveCount = 10;
const deploymentReadinessProbesPerWave = 8;

/** Select one of the bounded rollout-probe waves from an untrusted query value. */
export function deploymentReadinessProbeWave(value: string | null): number {
  if (value === null || !/^\d+$/.test(value)) return 0;
  const sequence = Number(value);
  return Number.isSafeInteger(sequence) ? sequence % deploymentReadinessProbeWaveCount : 0;
}

/** Eight distinct placements per wave; ten waves bounds each deploy to 80 names. */
export function deploymentReadinessProbeIndexes(wave: number): number[] {
  const normalizedWave =
    Number.isSafeInteger(wave) && wave >= 0 ? wave % deploymentReadinessProbeWaveCount : 0;
  const first = normalizedWave * deploymentReadinessProbesPerWave;
  return Array.from({ length: deploymentReadinessProbesPerWave }, (_, index) => first + index);
}

type WorkerBuildReadinessOptions = {
  expectedDeploymentId: string;
  sandboxContainerDeploymentId: string;
  readDeployment(): Promise<WorkerBuildDeployment>;
  readDurableObjectVersions(): Promise<readonly string[]>;
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
  const [deploymentResult, durableObjectVersionsResult] = await Promise.allSettled([
    deploymentPromise,
    options.readDurableObjectVersions(),
  ]);

  if (deploymentResult.status === "rejected") {
    console.error("worker-build sidecar readiness RPC failed", deploymentResult.reason);
  }
  if (durableObjectVersionsResult.status === "rejected") {
    // An old incarnation can legitimately lack this method while a new Worker
    // version is propagating. Keep that expected settling state out of error
    // telemetry; the 503 response remains the bounded readiness signal.
    console.info(
      "capability-host deployment readiness RPC is still settling",
      durableObjectVersionsResult.reason,
    );
  }

  const deploymentId =
    deploymentResult.status === "fulfilled" ? deploymentResult.value.deploymentId : null;
  const durableObjectVersions =
    durableObjectVersionsResult.status === "fulfilled"
      ? [...durableObjectVersionsResult.value]
      : null;
  const durableObjectsReady =
    durableObjectVersions !== null &&
    durableObjectVersions.length > 0 &&
    durableObjectVersions.every((version) => version === options.version);

  return readinessResponse(
    options,
    deploymentId,
    durableObjectVersions,
    deploymentId === options.expectedDeploymentId && durableObjectsReady,
  );
}

function readinessResponse(
  options: WorkerBuildReadinessOptions,
  deploymentId: string | null,
  durableObjectVersions: string[] | null,
  ready: boolean,
): Response {
  const uniqueDurableObjectVersions =
    durableObjectVersions === null ? [] : [...new Set(durableObjectVersions)];
  const durableObjectsReady =
    durableObjectVersions !== null &&
    durableObjectVersions.length > 0 &&
    uniqueDurableObjectVersions.length === 1 &&
    uniqueDurableObjectVersions[0] === options.version;

  return Response.json(
    {
      ok: ready,
      app: "os",
      version: options.version,
      // Keep the singular field for operators and scripts that already read
      // it; the plural field is the full rollout proof for this wave.
      durableObjectVersion:
        uniqueDurableObjectVersions.length === 1 ? uniqueDurableObjectVersions[0] : null,
      durableObjectVersions,
      durableObjectProbeCount: durableObjectVersions?.length ?? 0,
      workerBuildDeploymentId: deploymentId,
      sandboxContainerDeploymentId: options.sandboxContainerDeploymentId,
      ...(deploymentId === options.expectedDeploymentId
        ? {}
        : { expectedWorkerBuildDeploymentId: options.expectedDeploymentId }),
      ...(durableObjectsReady ? {} : { expectedDurableObjectVersion: options.version }),
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

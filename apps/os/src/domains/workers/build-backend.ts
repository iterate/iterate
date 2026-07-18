import { itxEnv as env } from "../../env.ts";
import { buildFailureMessageFromError, WorkerBuildFailedError } from "./artifact-store.ts";
import { coordinateWorkerBuild } from "./worker-build-capability.ts";
import { type WorkerBuildOutput, type WorkerBuildRequest } from "./worker-build-contract.ts";

/**
 * Technology-independent client for one dynamic-worker build.
 *
 * Deployed workers make one RPC to the deployment-global build coordinator.
 * They do not know whether its backend is Cloudflare Containers, Depot, or
 * something else. Local development keeps the same public function but runs
 * the shared recipe through Vite's host-toolchain endpoint.
 */
export async function executeWorkerBuild(input: WorkerBuildRequest): Promise<WorkerBuildOutput> {
  const devEndpoint = env.WORKER_BUILD_DEV_ENDPOINT;
  if (devEndpoint !== undefined && devEndpoint.length > 0) {
    return await buildAtDevEndpoint(devEndpoint, input);
  }

  const outcome = await coordinateWorkerBuild(input);
  if (outcome.status === "build-failed") {
    throw new WorkerBuildFailedError(outcome.message);
  }
  return outcome.output;
}

async function buildAtDevEndpoint(
  endpoint: string,
  input: WorkerBuildRequest,
): Promise<WorkerBuildOutput> {
  const response = await fetch(endpoint, {
    body: JSON.stringify({ files: input.files, options: input.options }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (response.status === 422) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new WorkerBuildFailedError(
      buildFailureMessageFromError(body.message ?? "worker build failed"),
    );
  }
  if (!response.ok) {
    throw new Error(`worker build dev endpoint answered ${response.status}`);
  }
  return (await response.json()) as WorkerBuildOutput;
}

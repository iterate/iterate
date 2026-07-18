import { itxEnv as env } from "../../env.ts";
import {
  WORKER_BUILD_COORDINATOR_NAME,
  type WorkerBuildDeployment,
  type WorkerBuildOutcome,
  type WorkerBuildRequest,
} from "./worker-build-contract.ts";

/**
 * The authority adapter for the deployment build service. Keeping the raw
 * namespace lookup here means callers receive an answered operation, never a
 * Durable Object stub they could retain or route under another identity.
 */
export async function coordinateWorkerBuild(
  request: WorkerBuildRequest,
): Promise<WorkerBuildOutcome> {
  return await env.WORKER_BUILDER.getByName(WORKER_BUILD_COORDINATOR_NAME).build(request);
}

/** Readiness identity of the deployment-global build service. */
export async function workerBuildDeployment(): Promise<WorkerBuildDeployment> {
  return await env.WORKER_BUILDER.getByName(WORKER_BUILD_COORDINATOR_NAME).deployment();
}

import type { WorkerBuildOptions } from "./schemas.ts";

/** The one deployment-scoped coordinator instance. The name is an internal
 * routing detail; callers see only the technology-neutral
 * {@link WorkerBuildService} capability. */
export const WORKER_BUILD_COORDINATOR_NAME = "deployment";

/** Marker used when a deploy was not launched from an immutable git revision. */
export const UNVERSIONED_WORKER_BUILD_DEPLOYMENT_ID = "unversioned";

/** Technology-neutral request sent from the OS worker to its build service. */
export type WorkerBuildRequest = {
  buildKey: string;
  files: Record<string, string>;
  options: WorkerBuildOptions;
};

/** Loader-ready output from any worker-build implementation. */
export type WorkerBuildOutput = {
  mainModule: string;
  modules: Record<string, string>;
};

/**
 * A source build has exactly two answered outcomes. Infrastructure failures
 * throw instead: they are retryable delivery failures, not evidence that the
 * immutable source is broken.
 */
export type WorkerBuildOutcome =
  | { status: "built"; output: WorkerBuildOutput }
  | { status: "build-failed"; message: string };

/** Identity of the worker-build service revision currently answering RPC. */
export type WorkerBuildDeployment = { deploymentId: string };

/** The deployment-global RPC capability consumed by the main OS worker. */
export interface WorkerBuildService {
  build(request: WorkerBuildRequest): Promise<WorkerBuildOutcome>;
  deployment(): Promise<WorkerBuildDeployment>;
}

/**
 * Backend port owned by the coordinator. Cloudflare Containers implement it
 * today; a Depot (or other remote build) adapter can replace that class
 * without changing the service binding, request, outcome, or caller.
 */
export interface WorkerBuildBackend {
  build(request: WorkerBuildRequest): Promise<WorkerBuildOutcome>;
}

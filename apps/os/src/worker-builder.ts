/**
 * Route-less host for the deployment-wide dynamic-worker build service.
 *
 * The main OS worker binds the singleton coordinator. The coordinator's
 * private backend binds the fixed Cloudflare Sandbox pool; neither the RPC
 * contract nor its callers know which container technology implements it.
 */
export { WorkerBuildCoordinatorDurableObject } from "./domains/workers/worker-build-coordinator-durable-object.ts";
export { WorkerBuilderDurableObject } from "./domains/workers/builder-pool-sandbox.ts";

export default {
  fetch() {
    return new Response("Not found", { status: 404 });
  },
};

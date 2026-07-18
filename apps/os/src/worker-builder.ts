/**
 * Route-less host for the deployment-wide dynamic-worker builder pool.
 *
 * Keeping this container class on its own script lets existing OS workers
 * remain on Cloudflare's one-way declarative-exports flow unchanged. The OS
 * worker reaches the namespace through an external Durable Object binding.
 */
export { WorkerBuilderDurableObject } from "./domains/workers/builder-pool-sandbox.ts";

export default {
  fetch() {
    return new Response("Not found", { status: 404 });
  },
};

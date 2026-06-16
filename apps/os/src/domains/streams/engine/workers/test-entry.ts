// Worker entry used only by the vitest-pool-workers harness
// (vitest.workers.config.ts). It exports the Stream + StreamProcessorRunner
// Durable Objects so miniflare can bind them, and a default fetch so the worker
// is valid. Tests reach the DOs through `env.STREAM` from `cloudflare:test`.

export { Stream } from "./durable-objects/stream.ts";
export { StreamProcessorRunner } from "./test-support/stream-processor-runner.ts";

export default {
  fetch(): Response {
    return new Response("stream test worker", { status: 200 });
  },
};

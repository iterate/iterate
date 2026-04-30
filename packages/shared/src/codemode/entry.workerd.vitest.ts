/**
 * Vitest workerd entrypoint for codemode integration tests.
 * Provides a LOADER binding for the DynamicWorkerExecutor.
 */
export default {
  async fetch() {
    return new Response("codemode test worker");
  },
};

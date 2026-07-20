import { defineConfig } from "vitest/config";
import { E2E_CI_RETRIES, E2E_TEST_TIMEOUT_MS } from "@iterate-com/shared/test-support/e2e-policy";

export default defineConfig({
  test: {
    environment: "node",
    // Both files generate unique resource types and clean up their own rows.
    fileParallelism: process.env.CI === "true",
    hookTimeout: E2E_TEST_TIMEOUT_MS,
    include: ["./e2e/vitest/**/*.test.ts"],
    testTimeout: E2E_TEST_TIMEOUT_MS,
    // Fleet-wide CI retry policy (docs/testing.md#retries-and-timeouts): one
    // retry re-rolls an isolated platform blip; a real regression still fails
    // both attempts fast.
    // Plain count, no delay: this app pins vitest 4.0.15, which predates the
    // object retry form (delay landed in 4.1). Fine here — the delay exists
    // for the deploy-adjacent websocket lanes (os, streams-example-app);
    // semaphore's e2e is a plain HTTP contract check.
    retry: process.env.CI ? E2E_CI_RETRIES : 0,
  },
});

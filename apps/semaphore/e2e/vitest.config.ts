import { defineConfig } from "vitest/config";
import { E2E_CI_RETRIES, E2E_TEST_TIMEOUT_MS } from "@iterate-com/shared/test-support/e2e-policy";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    hookTimeout: E2E_TEST_TIMEOUT_MS,
    include: ["./e2e/vitest/**/*.test.ts"],
    testTimeout: E2E_TEST_TIMEOUT_MS,
    // Fleet-wide CI retry policy (docs/testing.md#retries-and-timeouts): one
    // retry re-rolls an isolated platform blip; a real regression still fails
    // both attempts fast.
    retry: process.env.CI ? E2E_CI_RETRIES : 0,
  },
});

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { E2E_CI_RETRIES, E2E_CI_RETRY_DELAY_MS } from "@iterate-com/shared/test-support/e2e-policy";

export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("../os/src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["e2e/vitest/**/*.test.ts"],
    testTimeout: 30_000,
    // Fleet-wide CI retry policy (docs/testing.md#retries-and-timeouts):
    // each test opens its own fresh connection, so one retry re-rolls a
    // transient edge/platform fault ("Network connection lost." killed a
    // marathon run here on a 392ms-old socket); a real regression still
    // fails both attempts fast.
    retry: process.env.CI ? { count: E2E_CI_RETRIES, delay: E2E_CI_RETRY_DELAY_MS } : 0,
  },
});

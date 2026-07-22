import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import {
  E2E_CI_RETRIES,
  E2E_CI_RETRY_DELAY_MS,
  RetryTelemetryReporter,
} from "@iterate-com/shared/test-support/e2e-policy";

export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("../os/src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["e2e/vitest/**/*.test.ts"],
    // Fail fast and loud when the target playground is down — the whole
    // suite runs unconditionally (no env-var gate that could silently skip).
    globalSetup: ["./e2e/vitest-global-setup.ts"],
    testTimeout: 30_000,
    // Fleet-wide CI retry policy (docs/testing.md#retries-and-timeouts):
    // each test opens its own fresh connection, so one retry re-rolls a
    // transient edge/platform fault ("Network connection lost." killed a
    // marathon run here on a 392ms-old socket); a real regression still
    // fails both attempts fast.
    retry: process.env.CI ? { count: E2E_CI_RETRIES, delay: E2E_CI_RETRY_DELAY_MS } : 0,
    // Retry telemetry (policy rule 5): absorbed retries surface in the run
    // log and, via TEST_TELEMETRY_ARTIFACT_FILE, in the preview PR-body table.
    reporters: ["default", new RetryTelemetryReporter({ testKind: "e2e", lane: "vitest" })],
  },
});

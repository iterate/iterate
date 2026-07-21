import { defineConfig } from "vitest/config";
import {
  E2E_CI_RETRIES,
  RetryTelemetryReporter,
} from "@iterate-com/shared/test-support/e2e-policy";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    include: ["./e2e/**/*.e2e.test.ts"],
    hookTimeout: 60_000,
    testTimeout: 60_000,
    retry: process.env.CI ? E2E_CI_RETRIES : 0,
    reporters: ["default", new RetryTelemetryReporter()],
  },
});

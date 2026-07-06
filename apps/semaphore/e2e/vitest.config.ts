import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    hookTimeout: 120_000,
    include: ["./e2e/vitest/**/*.test.ts"],
    testTimeout: 120_000,
    // Fleet-wide CI retry policy (see apps/os/e2e/vitest.config.ts):
    // platform-fault bursts need re-rolls; real regressions still fail all
    // three attempts fast.
    retry: process.env.CI ? 2 : 0,
  },
});

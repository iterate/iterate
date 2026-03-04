import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.e2e.ts", "tests/**/*.e2e.test.ts", "tests/**/*.test.ts"],
    exclude: ["tests/old/**"],
    maxWorkers: 2,
    maxConcurrency: 2,
    testTimeout: 120_000,
  },
});

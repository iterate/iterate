import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.e2e.ts"],
    exclude: ["tests/old/**"],
    maxWorkers: 2,
    maxConcurrency: 2,
    testTimeout: 120_000,
  },
});

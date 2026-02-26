import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.e2e.ts"],
    maxWorkers: 1,
    testTimeout: 120_000,
  },
});

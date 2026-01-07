import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.test.ts"],
    testTimeout: 120_000,
    passWithNoTests: true,
    provide: {
      vitestBatchId: `batch-${Date.now()}`,
    },
  },
});

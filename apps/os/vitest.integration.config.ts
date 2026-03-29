import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "backend/**/*.integration.test.ts",
      "app/**/*.integration.test.ts",
      "backend/**/*.integration.test.tsx",
      "app/**/*.integration.test.tsx",
    ],
    testTimeout: 120_000,
    passWithNoTests: true,
    provide: {
      vitestBatchId: `batch-${Date.now()}`,
    },
  },
});

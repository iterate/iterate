import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.integration.test.ts", "**/*.integration.test.tsx"],
    exclude: ["**/node_modules/**"],
    testTimeout: 120_000,
    passWithNoTests: true,
    provide: {
      vitestBatchId: `batch-${Date.now()}`,
    },
  },
});

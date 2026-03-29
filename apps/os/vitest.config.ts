import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "backend/**/*.test.ts",
      "app/**/*.test.ts",
      "backend/**/*.test.tsx",
      "app/**/*.test.tsx",
    ],
    exclude: ["**/*.integration.test.ts"],
    testTimeout: 120_000,
    passWithNoTests: true,
    provide: {
      vitestBatchId: `batch-${Date.now()}`,
    },
  },
});

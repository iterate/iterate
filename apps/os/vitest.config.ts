import { defineConfig } from "vitest/config";

const maxConcurrencyRaw = process.env.VITEST_MAX_CONCURRENCY;
const maxConcurrency =
  maxConcurrencyRaw && !Number.isNaN(Number(maxConcurrencyRaw))
    ? Number(maxConcurrencyRaw)
    : undefined;

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.test.ts"],
    testTimeout: 120_000,
    maxConcurrency,
    passWithNoTests: true,
    provide: {
      vitestBatchId: `batch-${Date.now()}`,
    },
  },
});

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/subscriptions.benchmark.test.ts"],
    exclude: configDefaults.exclude,
    testTimeout: 300_000,
  },
});

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    includeSource: ["src/**/*.ts"],
    exclude: [...configDefaults.exclude, "src/subscriptions.benchmark.test.ts"],
    testTimeout: 20_000,
  },
});

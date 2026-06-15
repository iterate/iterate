import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: [
      "e2e/**",
      "scripts/**/*.test.ts",
      "**/node_modules/**",
      // Stream DO tests run in workerd via vitest.workers.config.ts.
      "**/*.workers.test.ts",
    ],
    testTimeout: 30_000,
  },
});

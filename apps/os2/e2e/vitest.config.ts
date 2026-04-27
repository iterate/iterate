import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    hookTimeout: 120_000,
    include: ["./e2e/vitest/**/*.test.ts"],
    passWithNoTests: true,
    testTimeout: 120_000,
  },
});

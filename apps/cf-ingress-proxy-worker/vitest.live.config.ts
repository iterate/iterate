import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["./live-e2e.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});

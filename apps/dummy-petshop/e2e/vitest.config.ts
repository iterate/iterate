import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    include: ["./e2e/**/*.e2e.test.ts"],
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});

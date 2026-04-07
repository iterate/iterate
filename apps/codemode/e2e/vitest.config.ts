import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    include: ["./e2e/vitest/**/*.test.ts"],
    testTimeout: 30_000,
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.e2e.ts"],
    sequence: {
      concurrent: false,
    },
    testTimeout: 120_000,
  },
});

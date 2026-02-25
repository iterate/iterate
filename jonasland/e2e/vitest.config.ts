import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.e2e.ts"],
    sequence: {
      concurrent: true,
    },
    testTimeout: 120_000,
  },
});

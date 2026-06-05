import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["e2e/vitest/**/*.test.ts"],
    testTimeout: 30_000,
  },
});

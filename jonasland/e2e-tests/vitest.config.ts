import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.e2e.ts"],
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 90_000,
  },
});

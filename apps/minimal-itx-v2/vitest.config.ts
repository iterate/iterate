import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: process.env.ITX_E2E_FILE_PARALLELISM === "true",
    hookTimeout: 45_000,
    include: ["./src/**/*.test.ts", "./itx.e2e.test.ts"],
    testTimeout: 45_000,
  },
});

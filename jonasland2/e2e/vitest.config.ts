import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["smoke.e2e.test.ts"],
    testTimeout: 120_000,
  },
});

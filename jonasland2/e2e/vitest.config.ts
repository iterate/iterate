import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["smoke.e2e.test.ts"],
    // IMPORTANT: Keep tests concurrent. This suite validates fixture isolation under parallel load.
    sequence: {
      concurrent: true,
    },
    testTimeout: 120_000,
  },
});

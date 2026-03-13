import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["./client.e2e.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});

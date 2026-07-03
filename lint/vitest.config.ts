import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // These tests spawn the real oxlint binary and run the TypeScript native
    // type-checker; a cold run (the first test in a file pays the warmup) can
    // take well over the 5s vitest default under CI runner load. Give them room
    // so they don't flake on Depot's `Test` workflow.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

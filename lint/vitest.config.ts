import { defineConfig } from "vitest/config";
import { vitestReporters } from "../packages/shared/src/test-support/e2e-policy/vitest-reporters.ts";

export default defineConfig({
  test: {
    reporters: vitestReporters,
    environment: "node",
    // These tests spawn the real oxlint binary and run the TypeScript native
    // type-checker; a cold run (the first test in a file pays the warmup) can
    // take well over the 5s vitest default under CI runner load. Give them room
    // so they don't flake on Depot's `Test` workflow.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    silent: "passed-only",
  },
});

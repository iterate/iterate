import { defineConfig } from "vitest/config";
import { vitestReporters } from "../../packages/shared/src/test-support/e2e-policy/vitest-reporters.ts";

export default defineConfig({
  test: {
    reporters: vitestReporters,
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    silent: "passed-only",
  },
});

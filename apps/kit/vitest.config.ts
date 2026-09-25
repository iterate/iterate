import { defineConfig } from "vitest/config";
import { vitestReporters } from "../../packages/shared/src/test-support/e2e-policy/vitest-reporters.ts";

export default defineConfig({
  test: {
    reporters: vitestReporters,
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    // the tests stub `window` and spy on `console` without lifecycle hooks (lint/test-style-rules.md)
    unstubGlobals: true,
    restoreMocks: true,
  },
});

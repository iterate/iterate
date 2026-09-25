import { defineConfig } from "vitest/config";
import { vitestReporters } from "../shared/src/test-support/e2e-policy/vitest-reporters.ts";

export default defineConfig({
  test: {
    reporters: vitestReporters,
  },
});

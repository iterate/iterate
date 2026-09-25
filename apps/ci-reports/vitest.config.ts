import { defineConfig } from "vitest/config";
import { vitestReporters } from "../../packages/shared/src/test-support/e2e-policy/vitest-reporters.ts";

// Its own config so Vitest does not load vite.config.ts, whose Cloudflare plugin would start a Worker.
export default defineConfig({
  test: { reporters: vitestReporters, include: ["src/**/*.test.ts"] },
});

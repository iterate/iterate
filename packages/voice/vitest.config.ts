import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { vitestReporters } from "../shared/src/test-support/e2e-policy/vitest-reporters.ts";

export default defineConfig({
  resolve: {
    alias: {
      // voice-agent.ts's only platform import is the SDK's Durable Object base class.
      "cloudflare:workers": fileURLToPath(
        new URL("../../core/lib/src/test-support/cloudflare-workers-shim.ts", import.meta.url),
      ),
    },
  },
  test: {
    reporters: vitestReporters,
    environment: "node",
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    chaiConfig: { truncateThreshold: 0 },
    silent: "passed-only",
  },
});

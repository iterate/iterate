import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { vitestReporters } from "../shared/src/test-support/e2e-policy/vitest-reporters.ts";

export default defineConfig({
  resolve: {
    alias: {
      // catalog.ts's only platform imports are base classes (the SDK's hosts, RpcTarget).
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

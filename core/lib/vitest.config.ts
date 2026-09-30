import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // app-session.ts's only platform import is the DurableObject base class.
      "cloudflare:workers": fileURLToPath(
        new URL("./src/test-support/cloudflare-workers-shim.ts", import.meta.url),
      ),
    },
  },
  test: {
    // The console's reporter, and whichever others the environment names by path: iterate's CI
    // adds its telemetry reporter (.depot/workflows/test.yml), which lives outside core/lib.
    reporters: [
      "default",
      ...(process.env.VITEST_EXTRA_REPORTERS || "").split(",").filter(Boolean),
    ],
    include: ["src/**/*.test.{ts,tsx}"],
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    chaiConfig: { truncateThreshold: 0 },
    silent: "passed-only",
  },
});

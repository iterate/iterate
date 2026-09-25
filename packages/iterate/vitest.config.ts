import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { vitestReporters } from "../shared/src/test-support/e2e-policy/vitest-reporters.ts";

export default defineConfig({
  resolve: {
    alias: {
      // app-session.ts's only platform import is the DurableObject base class.
      "cloudflare:workers": fileURLToPath(
        new URL("../shared/src/test-support/cloudflare-workers-shim.ts", import.meta.url),
      ),
    },
  },
  test: {
    reporters: vitestReporters,
    include: ["src/**/*.test.{ts,tsx}"],
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    silent: "passed-only",
  },
});

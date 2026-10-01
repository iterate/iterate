// THE vitest config for core/os's own tests: simple in-process unit tests (src/**/*.test.ts,
// scripts/*.test.ts). Every test that stages the platform (workerd, the Workers pool, a running
// worker, a browser) is test/'s, outside core/os. The global setup refreshes the generated modules
// the tests import.

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "scripts/*.test.ts"],
    // The console's reporter, and whichever others the environment names by path: iterate's CI
    // adds its telemetry reporter (.depot/workflows/test.yml), which lives outside core/os.
    reporters: [
      "default",
      ...(process.env.VITEST_EXTRA_REPORTERS || "").split(",").filter(Boolean),
    ],
    globalSetup: ["./vitest.global-setup.ts"],
    maxWorkers: process.env.CI ? 7 : undefined,
    // Each test starts with the last one's spies, stubbed globals and env restored
    // (lint/test-style-rules.md), as in every workspace's config.
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    // `$name` titles print whole (docs/vitest-patterns.md).
    chaiConfig: { truncateThreshold: 0 },
    // The edge and DO modules reach the control plane, whose OAuth provider imports
    // cloudflare:workers; inlined so the alias below covers it.
    server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
  },
  // Node stand-ins: core/lib/src/test-support/cloudflare-workers-shim.ts and
  // src/test/start-server-entry-shim.ts say why.
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("../lib/src/test-support/cloudflare-workers-shim.ts", import.meta.url),
      ),
      "@tanstack/react-start/server-entry": fileURLToPath(
        new URL("./src/test/start-server-entry-shim.ts", import.meta.url),
      ),
    },
  },
});

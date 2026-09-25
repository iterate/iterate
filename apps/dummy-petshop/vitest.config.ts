import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { vitestReporters } from "../../packages/shared/src/test-support/e2e-policy/vitest-reporters.ts";

export default defineConfig({
  resolve: {
    alias: {
      // The state Durable Object's only platform import is the DurableObject
      // base class; the shim lets unit tests run the real class in plain Node.
      "cloudflare:workers": fileURLToPath(
        new URL("./src/test/cloudflare-workers-shim.ts", import.meta.url),
      ),
    },
  },
  test: {
    reporters: vitestReporters,
    include: ["src/**/*.test.ts"],
  },
});

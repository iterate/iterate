import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Mirror tsconfig.json paths — vitest does not read tsconfig paths.
      "@iterate-com/ui": fileURLToPath(new URL("../ui/src", import.meta.url)),
      // Node stand-in for the Workers runtime module, so tests can import
      // worker-layer modules (e.g. the flake dashboard's all-in-one
      // worker.ts) — same shim apps/os aliases for its own unit tests.
      "cloudflare:workers": fileURLToPath(
        new URL("../../apps/os/src/test/cloudflare-workers-shim.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
  },
});

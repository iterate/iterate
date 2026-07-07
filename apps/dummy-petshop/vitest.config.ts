import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

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
    include: ["src/**/*.test.ts"],
  },
});

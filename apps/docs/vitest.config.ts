import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Standalone on purpose: vite.config.ts wires the Cloudflare workerd runner,
// which these pure unit tests neither need nor survive.
export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./src/test/cloudflare-workers-shim.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});

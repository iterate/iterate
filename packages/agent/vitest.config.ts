import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  ssr: {
    noExternal: ["@cloudflare/codemode"],
  },
  test: {
    environment: "node",
    pool: "forks",
    isolate: true,
    clearMocks: true,
    restoreMocks: true,
  },
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./src/test-cloudflare-workers.ts", import.meta.url),
      ),
    },
  },
});

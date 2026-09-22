import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./src/next/test-support/cloudflare-workers.ts", import.meta.url),
      ),
    },
  },
  test: { include: ["src/next/**/*.test.{ts,tsx}"] },
});

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { vitestReporters } from "../shared/src/test-support/e2e-policy/vitest-reporters.ts";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./src/test-support/cloudflare-workers.ts", import.meta.url),
      ),
    },
  },
  test: { reporters: vitestReporters, include: ["src/**/*.test.{ts,tsx}"] },
});

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defaultExclude, defineConfig } from "vitest/config";

const callableRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: callableRoot,
  plugins: [
    cloudflareTest({
      main: "./entry.workerd.vitest.ts",
      wrangler: {
        configPath: resolve(callableRoot, "wrangler.vitest.jsonc"),
      },
    }),
  ],
  test: {
    globals: true,
    include: ["./runtime.test.ts"],
    exclude: defaultExclude,
    hookTimeout: 60_000,
    testTimeout: 45_000,
  },
});

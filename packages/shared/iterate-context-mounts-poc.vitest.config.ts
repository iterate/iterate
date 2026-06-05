import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defaultExclude, defineConfig } from "vitest/config";

const sharedRoot = fileURLToPath(new URL(".", import.meta.url));
const pocRoot = resolve(sharedRoot, "iterate-context-mounts-poc");

export default defineConfig({
  root: sharedRoot,
  plugins: [
    cloudflareTest({
      main: resolve(pocRoot, "src/host-entry.ts"),
      wrangler: {
        configPath: resolve(pocRoot, "wrangler.vitest.jsonc"),
      },
    }),
  ],
  test: {
    globals: true,
    include: [resolve(pocRoot, "test/**/*.test.ts")],
    exclude: defaultExclude,
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});

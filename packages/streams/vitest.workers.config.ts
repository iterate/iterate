import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defaultExclude, defineConfig } from "vitest/config";

// Runs the Stream Durable Object tests inside workerd via vitest-pool-workers.
// Node-runtime tests stay in vitest.config.ts; these are split out by the
// `*.workers.test.ts` suffix because they import `cloudflare:workers` /
// `cloudflare:test` and cannot run in the node pool.
const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: resolve(root, "src/workers/test-entry.ts"),
      wrangler: { configPath: resolve(root, "vitest.workers.jsonc") },
    }),
  ],
  test: {
    include: ["src/**/*.workers.test.ts"],
    exclude: [...defaultExclude],
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});

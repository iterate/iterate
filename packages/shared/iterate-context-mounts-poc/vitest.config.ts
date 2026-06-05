import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultExclude, defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = "/Users/jonastemplestein/.superset/worktrees/iterate/broken-sodalite";
const cloudflareVitestPath = resolve(
  repoRoot,
  "packages/shared/node_modules/@cloudflare/vitest-pool-workers/dist/pool/index.mjs",
);
const cloudflareVitest = await import(pathToFileURL(cloudflareVitestPath).href);

export default defineConfig({
  root,
  plugins: [
    cloudflareVitest.cloudflareTest({
      main: resolve(root, "src/host-entry.ts"),
      wrangler: {
        configPath: resolve(root, "wrangler.vitest.jsonc"),
      },
    }),
  ],
  test: {
    globals: true,
    include: [resolve(root, "test/**/*.test.ts")],
    exclude: defaultExclude,
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});

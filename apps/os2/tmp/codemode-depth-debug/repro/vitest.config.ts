import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultExclude, defineConfig } from "vitest/config";

const reproRoot = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(reproRoot, "../../../../..");
const sharedRoot = resolve(repoRoot, "packages/shared");
const cloudflareVitest = await import(
  pathToFileURL(
    resolve(sharedRoot, "node_modules/@cloudflare/vitest-pool-workers/dist/pool/index.mjs"),
  ).href
);

export default defineConfig({
  root: sharedRoot,
  plugins: [
    cloudflareVitest.cloudflareTest({
      main: resolve(reproRoot, "entry.workerd.vitest.ts"),
      wrangler: {
        configPath: resolve(reproRoot, "wrangler.vitest.jsonc"),
      },
    }),
  ],
  test: {
    globals: true,
    include: [resolve(reproRoot, "*.workerd.test.ts")],
    exclude: defaultExclude,
    experimental: {
      importDurations: {
        limit: 0,
      },
    } as never,
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});

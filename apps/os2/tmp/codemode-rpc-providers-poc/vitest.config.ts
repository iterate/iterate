import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultExclude, defineConfig } from "vitest/config";

const pocRoot = fileURLToPath(new URL(".", import.meta.url));
const sharedRoot = resolve(pocRoot, "../../../../packages/shared");
const cloudflareVitest = await import(
  pathToFileURL(
    resolve(
      pocRoot,
      "../../../../packages/shared/node_modules/@cloudflare/vitest-pool-workers/dist/pool/index.mjs",
    ),
  ).href
);

export default defineConfig({
  root: sharedRoot,
  plugins: [
    cloudflareVitest.cloudflareTest({
      main: resolve(pocRoot, "entry.workerd.vitest.ts"),
      wrangler: {
        configPath: resolve(pocRoot, "wrangler.vitest.jsonc"),
      },
    }),
  ],
  test: {
    globals: true,
    include: [resolve(pocRoot, "*.workerd.test.ts")],
    exclude: defaultExclude,
    hookTimeout: 60_000,
    testTimeout: 45_000,
  },
});

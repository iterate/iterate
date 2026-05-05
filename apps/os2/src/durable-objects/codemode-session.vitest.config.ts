import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultExclude, defineConfig } from "vitest/config";

const appRoot = process.env.OS2_CODEMODE_SESSION_TEST_APP_ROOT ?? process.cwd();
const repoRoot = resolve(appRoot, "../..");
const testRoot = fileURLToPath(new URL(".", import.meta.url));
const cloudflareVitestPath = resolve(
  repoRoot,
  "packages/shared/node_modules/@cloudflare/vitest-pool-workers/dist/pool/index.mjs",
);
const cloudflareVitest = await import(pathToFileURL(cloudflareVitestPath).href);
const requireFromCloudflareVitest = createRequire(cloudflareVitestPath);
const miniflare = await import(
  pathToFileURL(requireFromCloudflareVitest.resolve("miniflare")).href
);

export default defineConfig({
  root: resolve(repoRoot, "packages/shared"),
  resolve: {
    alias: {
      "~": resolve(appRoot, "src"),
    },
  },
  plugins: [
    cloudflareVitest.cloudflareTest({
      main: resolve(testRoot, "codemode-session-test-entry.ts"),
      miniflare: {
        serviceBindings: {
          PROVIDER_A: {
            entrypoint: "ProviderA",
            name: miniflare.kCurrentWorker,
          },
          PROVIDER_B: {
            entrypoint: "ProviderB",
            name: miniflare.kCurrentWorker,
          },
        },
      },
      wrangler: {
        configPath: resolve(testRoot, "codemode-session.wrangler.vitest.jsonc"),
      },
    }),
  ],
  test: {
    exclude: defaultExclude,
    hookTimeout: 60_000,
    include: [resolve(testRoot, "codemode-session.test.ts")],
    testTimeout: 60_000,
  },
});

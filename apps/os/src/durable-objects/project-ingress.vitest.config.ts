import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultExclude, defineConfig } from "vitest/config";

const appRoot = process.env.OS_PROJECT_INGRESS_TEST_APP_ROOT ?? process.cwd();
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
      capnweb: resolve(
        repoRoot,
        "node_modules/.pnpm/capnweb@0.8.0/node_modules/capnweb/dist/index-workers.js",
      ),
      "~": resolve(appRoot, "src"),
    },
  },
  plugins: [
    cloudflareVitest.cloudflareTest({
      main: resolve(testRoot, "project-ingress-test-entry.ts"),
      miniflare: {
        serviceBindings: {
          ARTIFACTS: {
            entrypoint: "MockArtifactsBinding",
            name: miniflare.kCurrentWorker,
          },
          PROJECT_ENTRYPOINT: {
            entrypoint: "ProjectIngressEntrypoint",
            name: miniflare.kCurrentWorker,
          },
          PROJECT_MCP_ENTRYPOINT: {
            entrypoint: "ProjectMcpServerEntrypoint",
            name: miniflare.kCurrentWorker,
          },
        },
      },
      wrangler: {
        configPath: resolve(testRoot, "project-ingress.wrangler.vitest.jsonc"),
      },
    }),
  ],
  test: {
    exclude: defaultExclude,
    hookTimeout: 60_000,
    include: [resolve(testRoot, "project-ingress.test.ts")],
    testTimeout: 60_000,
  },
});

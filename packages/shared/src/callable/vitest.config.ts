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
      miniflare: {
        /**
         * Cloudflare's Workers Vitest pool supports auxiliary Workers through
         * Miniflare's `workers` option. This fixture gives us a real service
         * binding, not a hand-written `{ fetch() {} }` mock, so fetch and RPC
         * tests exercise the platform binding shape we expect in production.
         * https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/#workerspooloptions
         */
        serviceBindings: {
          CALLABLE_TEST_SERVICE: "callable-test-service",
        },
        workers: [
          {
            name: "callable-test-service",
            modules: true,
            scriptPath: resolve(callableRoot, "service.workerd.vitest.js"),
          },
        ],
      },
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

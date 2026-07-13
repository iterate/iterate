import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultExclude, defineConfig } from "vitest/config";

const appRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    // Vitest does not apply tsconfig `paths` for `~/` reliably; mirror `~/*` -> `./src/*`.
    alias: {
      "~": resolve(appRoot, "src"),
      // Production resolves Cap'n Web's `workerd` export. Exercise that same
      // runtime in unit tests so Workers-only RPC hooks cannot pass via the
      // unpatched generic build.
      capnweb: resolve(appRoot, "node_modules/capnweb/dist/index-workers.js"),
      // The pure itx core's only platform import is RpcTarget; the shim lets
      // its no-workerd unit test (src/itx/itx.test.ts) run in plain Node.
      "cloudflare:workers": resolve(appRoot, "src/test/cloudflare-workers-shim.ts"),
    },
  },
  test: {
    server: {
      deps: {
        // Ships ESM with extensionless relative imports — fine for the vite
        // bundle, but Node's ESM resolver (vitest's default for deps) rejects
        // them; inlining lets vite resolve the package instead.
        inline: ["codemirror-json-schema", /capnweb/],
      },
    },
    // Route `/api2/test` is implemented as `api2.test.ts` — not a Vitest file.
    exclude: [...defaultExclude, "e2e/**", "**/src/routes/**/*.test.ts", "**/*.workerd.test.ts"],
    fileParallelism: false,
    pool: "forks",
    hookTimeout: 60_000,
    testTimeout: 45_000,
  },
});

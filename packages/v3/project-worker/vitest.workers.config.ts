// The POOL-WORKERS lane: tests run INSIDE workerd next to the real worker (same isolate), so
// they can hold live capnweb sessions over WebSocket upgrades on SELF.fetch AND reach
// cloudflare:test's DO controls (evictDurableObject, runInDurableObject) — the lane that can
// prove the hibernation property without a deployment. Run with `pnpm test:workers`.
// Wiring = the cloudflare-os vitest.integration.config.ts pattern: capnwebValidate() first (the
// pool imports src through Vite, so @validateRpc classes exercise the TRANSFORMED code), then
// cloudflareTest against wrangler.test.jsonc (see that file's header for why it diverges).
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { transform as esbuildTransform } from "esbuild";
import { defineConfig, type Plugin } from "vitest/config";

/** Vite 8's oxc transform passes 2023-11 STANDARD decorators through UNLOWERED (its
 *  DecoratorOptions supports `legacy` only), and workerd's V8 has not shipped them — so
 *  `@__cw.__validateRpcClass(...)`, capnweb-validate's rewrite of `@validateRpc()`, reaches the
 *  runtime verbatim and dies as `SyntaxError: Invalid or unexpected token` at import time.
 *  (cloudflare-os never hits this because its pipeline lowers decorators with esbuild.) This
 *  plugin lowers them with esbuild BEFORE oxc sees the file. It must sit AFTER capnwebValidate()
 *  in the plugin array: the validator generator needs the ORIGINAL decorator to find its
 *  classes; this pass then consumes the rewritten one. */
function lowerStandardDecoratorsWithEsbuild(): Plugin {
  return {
    name: "lower-standard-decorators-with-esbuild",
    enforce: "pre",
    async transform(code, id) {
      const cleanId = id.split("?", 1)[0].split("#", 1)[0];
      if (!/\.(?:ts|tsx|mts|cts)$/.test(cleanId) || cleanId.includes("/node_modules/")) return null;
      if (!/^\s*(?:export\s+)?@/m.test(code)) return null; // no decorator syntax — oxc is fine
      const out = await esbuildTransform(code, {
        loader: cleanId.endsWith("x") ? "tsx" : "ts",
        target: "es2022",
        sourcemap: true,
        sourcefile: cleanId,
      });
      return { code: out.code, map: out.map };
    },
  };
}

export default defineConfig({
  plugins: [
    capnwebValidate(),
    lowerStandardDecoratorsWithEsbuild(),
    cloudflareTest({
      main: "./src/worker.ts",
      remoteBindings: false,
      wrangler: {
        configPath: "./wrangler.test.jsonc",
      },
    }),
  ],
  test: {
    include: ["__workers-tests__/**/*.test.ts"],
    // Whichever test runs first pays for workerd booting + the 200-client attach storm; the
    // timeout has to clear that cold start plus a full-scale page-in fan-out, not the
    // steady-state cost (the cloudflare-os cold-start lesson, scaled up).
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Teardown noise only: disposing a capnweb session with pager sockets still parked rethrows
    // the peer close as an unhandled rejection (the prove_hibernate.mjs "nonfatal socket error"
    // family). Everything else stays fatal.
    onUnhandledError(error) {
      if (/RPC session|WebSocket|CONNECTION_OFFLINE|disposed/i.test(error.message ?? ""))
        return false;
    },
  },
});

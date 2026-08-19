// THE ONE test config. Three PROJECTS (vitest's own word), one command (`pnpm test`) — the
// cook-down of what used to be three configs + three scripts. Each project is a genuinely
// different execution context, not a taste split:
//   • unit    — in-process node, the fast lane (src/**/*.test.ts)
//   • harness — real worker booted locally via wrangler createTestHarness, driven over capnweb
//               exactly like production (__tests__/**/*.test.ts)
//   • workers — tests run INSIDE workerd next to the worker, reaching cloudflare:test DO
//               controls (evictDurableObject) — the hibernation lane (__workers-tests__/**)
// capnwebValidate() rides every project so @validateRpc() classes exercise the TRANSFORMED code
// (an untransformed decorator throws at class-definition time by design).

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { transform as esbuildTransform } from "esbuild";
import { defineConfig, type Plugin } from "vitest/config";

/** Vite 8's oxc passes 2023-11 STANDARD decorators through UNLOWERED (its DecoratorOptions is
 *  `legacy` only) and workerd's V8 has not shipped them, so capnweb-validate's rewritten
 *  `@__cw.__validateRpcClass(...)` dies as `SyntaxError` at import. This lowers them with esbuild
 *  BEFORE oxc — AFTER capnwebValidate() (which needs the original decorator to find its classes).
 *  cloudflare-os never hits this because its pipeline already lowers with esbuild. */
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
  test: {
    projects: [
      {
        plugins: [capnwebValidate()],
        test: {
          name: "unit",
          // src only — the .wrangler/validate mirror carries byte-copies of the tests too.
          include: ["src/**/*.test.ts"],
        },
      },
      {
        plugins: [capnwebValidate()],
        test: {
          name: "harness",
          include: ["__tests__/**/*.test.ts"],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          // one worker + sequential files: each file boots its own workerd and reruns the build
          // hook; parallel boots thrash the port and race .wrangler/validate (ENOTEMPTY).
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          fileParallelism: false,
        },
      },
      {
        plugins: [
          capnwebValidate(),
          lowerStandardDecoratorsWithEsbuild(),
          cloudflareTest({
            main: "./src/worker.ts",
            remoteBindings: false,
            wrangler: { configPath: "./wrangler.test.jsonc" },
          }),
        ],
        test: {
          name: "workers",
          include: ["__workers-tests__/**/*.test.ts"],
          // First test pays workerd boot + the 200-client attach storm (the cloudflare-os
          // cold-start lesson, scaled up).
          testTimeout: 120_000,
          hookTimeout: 120_000,
          // Teardown noise only: disposing a capnweb session with pager sockets still parked
          // rethrows the peer close as an unhandled rejection. Everything else stays fatal.
          onUnhandledError(error) {
            if (/RPC session|WebSocket|CONNECTION_OFFLINE|disposed/i.test(error.message ?? ""))
              return false;
          },
        },
      },
    ],
  },
});

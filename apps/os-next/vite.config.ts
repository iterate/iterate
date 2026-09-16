// vite.config.ts — THE BUILD (apps/auth's shape, minus Tailwind): Vite + the Cloudflare plugin (the
// worker — src/worker.ts, wrangler.jsonc's `main` — bundled for workerd, the client assets beside it)
// + TanStack Start (the console: src/routes/** file routes, SSR'd by the worker, their server
// functions compiled into it) + React. `vite build` emits dist/client (the console's bundle) and dist/server (index.js + wrangler.json, the
// config `wrangler deploy` and both local lanes consume — vitest.global-setup.ts, e2e/support/worker-config.ts).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { writeWranglerConfig } from "./scripts/generate-wrangler-config.ts";
import { processorSdkModules } from "./scripts/vite-plugin-processor-sdk.ts";

// The wrangler config is written at config load, as apps/auth writes its own; the injected SDK is a
// virtual module (scripts/vite-plugin-processor-sdk.ts), built by this same build.
writeWranglerConfig();

/** dist/server/wrangler.json as this package's wrangler (4.131.1 — `pnpm dev`, `pnpm deploy`, the e2e
 *  harness) reads it: the Cloudflare plugin's own wrangler (4.107.0, pinned inside it) writes
 *  `legacy_env: true` into it, and the newer one refuses the field — removed since, as the default it
 *  always was. Dropped after the build, so the emitted config is one every reader here accepts. */
const emittedWranglerConfig = (): Plugin => ({
  name: "os-next:emitted-wrangler-config",
  closeBundle() {
    const path = "dist/server/wrangler.json";
    if (!existsSync(path)) return;
    const { legacy_env: _removed, ...config } = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify(config));
  },
});

export default defineConfig({
  plugins: [
    processorSdkModules(),
    // The worker runs in workerd during `vite dev` — where the plugin's own workerd (1.20260701) is
    // new enough for the compatibility date; today it is not, so `pnpm dev` is `vite build` + this
    // package's `wrangler dev` on the emitted config. wrangler.jsonc declares the bindings, and the
    // `assets` block (run_worker_first: true — src/worker.ts serves them on the platform host only).
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    emittedWranglerConfig(),
    tanstackStart({
      // SPA mode (spa: { enabled: true }) is the intended shape but is BLOCKED by the toolchain: it
      // build-time-prerenders the shell by running THIS worker in @cloudflare/vite-plugin's bundled
      // workerd, which supports compat date 2026-07-08 < the worker's 2026-09-01 (the same reason
      // `pnpm dev` uses the package's own wrangler). Re-enable once the plugin's workerd is bumped, or
      // switch to a manually-served shell + client-side auth. Tracked in the design docs (docs/).
      router: { addExtensions: true, semicolons: true, quoteStyle: "double" },
      importProtection: { behavior: "error" },
    }),
    viteReact(),
  ],
  clearScreen: false,
});

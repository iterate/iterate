import tanstackStartServerEntry from "@tanstack/react-start/server-entry";
import { fetchExampleCloudflareApi } from "./cloudflare/entrypoint.ts";
import type { Env } from "./cloudflare/worker-env.ts";

/**
 * Custom Cloudflare entrypoint for TanStack Start in SPA mode.
 *
 * Why this file exists:
 * - TanStack Start SPA mode still does a build-time prerender pass to generate
 *   the shell HTML document:
 *   https://tanstack.com/start/latest/docs/framework/react/guide/spa-mode
 * - Cloudflare supports custom TanStack Start entrypoints via `src/server.ts`:
 *   https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/#custom-entrypoints
 *
 * Runtime intent:
 * - `/api/*` requests are handled by our Hono/oRPC worker code.
 * - All non-API document and asset requests are served by Cloudflare's asset
 *   pipeline at runtime, because `assets.run_worker_first` only matches `/api/*`.
 * - During the build-time shell prerender pass, however, TanStack needs a real
 *   server entrypoint for `/`, so non-API requests fall through to Start's
 *   default server entry here.
 *
 * Primary Cloudflare asset routing docs:
 * - SPA fallback behavior:
 *   https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/
 * - Selective worker execution with `run_worker_first`:
 *   https://developers.cloudflare.com/workers/static-assets/binding/#run_worker_first
 */
export default {
  async fetch(request: Request, env: Env, context: ExecutionContext) {
    const pathname = new URL(request.url).pathname;

    if (pathname.startsWith("/api/")) {
      return fetchExampleCloudflareApi(request, env, context);
    }

    return tanstackStartServerEntry.fetch(request);
  },
};

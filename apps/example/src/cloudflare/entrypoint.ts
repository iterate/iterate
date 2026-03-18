/// <reference types="@cloudflare/workers-types" />

import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/cloudflare-workers";
import { ExampleAppEnv } from "../env.ts";
import * as schema from "../api/db/schema.ts";
import { exampleApp } from "../api/app.ts";
import { createNotImplementedTerminalDep } from "../api/terminal.ts";
import type { Env } from "./worker-env.ts";

/**
 * API-only Cloudflare app wiring.
 *
 * The deployed SPA shell and other frontend assets are intentionally served by
 * Cloudflare's asset layer, not by Hono. At runtime the worker should only run
 * first for `/api/*` requests via `assets.run_worker_first`.
 *
 * Primary docs:
 * - TanStack Start SPA mode still generates a shell at build time:
 *   https://tanstack.com/start/latest/docs/framework/react/guide/spa-mode
 * - Cloudflare static asset routing for SPAs:
 *   https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/
 * - `run_worker_first` for selected paths:
 *   https://developers.cloudflare.com/workers/static-assets/binding/#run_worker_first
 */
export async function fetchExampleCloudflareApi(
  request: Request,
  env: Env,
  context: ExecutionContext,
) {
  const parsedEnv = ExampleAppEnv.parse(env);
  const db = drizzle(env.DB, { schema });
  const app = new Hono();

  await exampleApp.mount({
    app,
    getDeps: () => ({
      env: parsedEnv,
      db,
      terminal: createNotImplementedTerminalDep(
        "Terminal is not implemented in the Cloudflare worker runtime.",
      ),
    }),
    // Workers upgrade websocket requests inline at the route level, so there
    // is no separate Node-style injection step after server creation.
    upgradeWebSocket,
  });

  return app.fetch(request, env, context);
}

export default {
  fetch: fetchExampleCloudflareApi,
};

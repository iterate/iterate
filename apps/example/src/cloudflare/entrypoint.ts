/// <reference types="@cloudflare/workers-types" />

import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/cloudflare-workers";
import { initializeServiceEvlog } from "@iterate-com/shared/jonasland";
import { ExampleAppEnv } from "../env.ts";
import * as schema from "../api/db/schema.ts";
import { exampleApp } from "../api/app.ts";
import { createNotImplementedTerminalDep } from "../api/terminal.ts";
import type { Env } from "./worker-env.ts";

let didInitializeServiceEvlog = false;

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext) {
    if (!didInitializeServiceEvlog) {
      // Workers surface console output in local dev and tail logs too, so reuse
      // the same evlog formatter here when node compatibility is enabled:
      // https://developers.cloudflare.com/workers/runtime-apis/console
      // https://developers.cloudflare.com/workers/runtime-apis/nodejs/
      initializeServiceEvlog(exampleApp.manifest.slug);
      didInitializeServiceEvlog = true;
    }

    const parsedEnv = ExampleAppEnv.parse(env);
    const db = drizzle(env.DB, { schema });
    const pathname = new URL(request.url).pathname;
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

    const response = await app.fetch(request, env, context);
    if (response.status !== 404 || pathname.startsWith("/api/")) {
      return response;
    }

    return env.ASSETS.fetch(request);
  },
};

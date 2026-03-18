/// <reference types="@cloudflare/workers-types" />

import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/cloudflare-workers";
import { ExampleAppEnv } from "../env.ts";
import * as schema from "../api/db/schema.ts";
import { exampleApp } from "../api/app.ts";
import type { Env } from "./worker-env.ts";

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext) {
    const parsedEnv = ExampleAppEnv.parse(env);
    const db = drizzle(env.DB, { schema });
    const pathname = new URL(request.url).pathname;
    const app = new Hono();

    await exampleApp.mount({
      app,
      getDeps: () => ({
        env: parsedEnv,
        db,
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

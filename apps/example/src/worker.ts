/// <reference types="@cloudflare/workers-types" />

import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/cloudflare-workers";
import tanstackStartServerEntry from "@tanstack/react-start/server-entry";
import { ExampleAppEnv } from "./env.ts";
import * as schema from "./api/db/schema.ts";
import { exampleApp } from "./api/app.ts";
import { createNotImplementedTerminalDep } from "./api/terminal.ts";
import type { Env } from "./worker-env.ts";

let workerAppPromise: Promise<Hono> | undefined;

async function createExampleWorkerApp(env: Env) {
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
    upgradeWebSocket,
  });

  app.all("*", (c) => tanstackStartServerEntry.fetch(c.req.raw));

  return app;
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext) {
    workerAppPromise ??= createExampleWorkerApp(env);
    const app = await workerAppPromise;
    return app.fetch(request, env, context);
  },
};

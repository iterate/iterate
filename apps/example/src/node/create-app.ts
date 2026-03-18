import type { RequestListener } from "node:http";
import { createNodeWebSocket } from "@hono/node-ws";
import { getRequestListener } from "@hono/node-server";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { Hono } from "hono";
import type { ExampleDeps } from "../api/context.ts";
import { ExampleAppEnv, ExampleNodeEnv } from "../env.ts";
import * as schema from "../api/db/schema.ts";
import { exampleApp } from "../api/app.ts";
import { createNodeTerminalDep } from "./node.ts";

export async function createExampleNodeRuntime(options?: { env?: ExampleNodeEnv }) {
  const env = options?.env ?? ExampleNodeEnv.parse(process.env);
  const appEnv = ExampleAppEnv.parse(env);

  const db = drizzle(env.EXAMPLE_DB_PATH, { schema });
  db.$client.pragma("journal_mode = WAL");
  migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });

  const deps: ExampleDeps = {
    env: appEnv,
    db,
    terminal: createNodeTerminalDep(),
  };

  return {
    appEnv,
    db,
    deps,
    env,
  };
}

/**
 * Build the concrete Node version of the example app.
 *
 * This is the single Node runtime composition boundary for the example API.
 * The Vite dev adapter reuses this helper so Hono setup, websocket wiring, env
 * parsing, and runtime deps stay in one place.
 */
export async function createExampleNodeApp(options?: { env?: ExampleNodeEnv }) {
  const runtime = await createExampleNodeRuntime(options);

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  await exampleApp.mount({
    app,
    getDeps: () => runtime.deps,
    upgradeWebSocket,
  });

  const requestListener: RequestListener = getRequestListener((request) => app.fetch(request), {
    overrideGlobalObjects: false,
    errorHandler: (error) => {
      throw toError(error);
    },
  });

  return {
    app,
    ...runtime,
    injectWebSocket,
    requestListener,
  };
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

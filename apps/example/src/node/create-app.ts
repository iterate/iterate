import { createNodeWebSocket } from "@hono/node-ws";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { Hono } from "hono";
import { initializeServiceEvlog } from "@iterate-com/shared/jonasland";
import type { ExampleDeps } from "../api/context.ts";
import { ExampleAppEnv, ExampleNodeEnv } from "../env.ts";
import * as schema from "../api/db/schema.ts";
import { exampleApp } from "../api/app.ts";
import { createNodeTerminalDep } from "./terminal.ts";

let didInitializeServiceEvlog = false;

export async function createExampleNodeRuntime(options?: { env?: ExampleNodeEnv }) {
  const env = options?.env ?? ExampleNodeEnv.parse(process.env);
  const appEnv = ExampleAppEnv.parse(env);

  if (!didInitializeServiceEvlog) {
    initializeServiceEvlog(exampleApp.manifest.slug);
    didInitializeServiceEvlog = true;
  }

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

export async function createExampleNodeApp(options?: { env?: ExampleNodeEnv }) {
  const runtime = await createExampleNodeRuntime(options);

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  await exampleApp.mount({
    app,
    getDeps: () => runtime.deps,
    upgradeWebSocket,
  });

  return {
    app,
    ...runtime,
    injectWebSocket,
  };
}

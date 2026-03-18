import { createAdaptorServer } from "@hono/node-server";
import crossws, { type NodeAdapter } from "crossws/adapters/node";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { Hono } from "hono";
import { ExampleAppEnv, ExampleNodeEnv } from "../env.ts";
import * as schema from "../api/db/schema.ts";
import { exampleApp } from "../api/app.ts";

const env = ExampleNodeEnv.parse(process.env);
const appEnv = ExampleAppEnv.parse(env);

const db = drizzle(env.EXAMPLE_DB_PATH, { schema });
db.$client.pragma("journal_mode = WAL");
migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });

const { honoApp, crossws: nodeCrossws } = await exampleApp.attachRuntime({
  honoApp: new Hono(),
  createRuntimeOrpcContext: () => ({
    env: appEnv,
    db,
  }),
  crosswsAdapter: (options): NodeAdapter => crossws(options),
});

const server = createAdaptorServer({ fetch: honoApp.fetch });

server.on("upgrade", (request, socket, head) => {
  void nodeCrossws.handleUpgrade(request, socket, head).catch((error: unknown) => {
    console.error(error);
    socket.destroy();
  });
});

server.listen(env.PORT, env.HOST, () => {
  console.log(`example backend listening on http://${env.HOST}:${env.PORT}`);
});

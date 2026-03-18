import { createAdaptorServer } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
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

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

await exampleApp.mount({
  app,
  getDeps: () => ({
    env: appEnv,
    db,
  }),
  upgradeWebSocket,
});

const server = createAdaptorServer({ fetch: app.fetch });

// Node registers websocket routes on the Hono app, then wires upgrade handling
// into the underlying HTTP server once it actually exists.
injectWebSocket(server);

server.listen(env.PORT, env.HOST, () => {
  console.log(`example backend listening on http://${env.HOST}:${env.PORT}`);
});

import type { Server as HttpServer } from "node:http";
import { createAdaptorServer } from "@hono/node-server";
import app from "./server/app.ts";
import { attachOrpcWebSocketServer } from "./server/orpc.ts";

const host = process.env.HOST?.trim() || "0.0.0.0";
const port = process.env.PORT?.trim() ? Number(process.env.PORT) : 3000;

const server = createAdaptorServer({ fetch: app.fetch });
attachOrpcWebSocketServer(server as HttpServer);

server.listen(port, host, () => {
  console.log(`ws-test listening on http://${host}:${port}`);
});

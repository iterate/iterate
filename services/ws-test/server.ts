import { createAdaptorServer } from "@hono/node-server";
import app, { injectWebSocket } from "./src/server/app.ts";

const host = process.env.HOST?.trim() || "0.0.0.0";
const port = process.env.PORT?.trim() ? Number(process.env.PORT) : 3000;

const server = createAdaptorServer({ fetch: app.fetch });
injectWebSocket(server);

server.listen(port, host, () => {
  console.log(`ws-test listening on http://${host}:${port}`);
});

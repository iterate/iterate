import { createAdaptorServer } from "@hono/node-server";
import { createExampleNodeApp } from "./create-app.ts";

const { app, env, injectWebSocket } = await createExampleNodeApp();

const server = createAdaptorServer({ fetch: app.fetch });

// Node registers websocket routes on the Hono app, then wires upgrade handling
// into the underlying HTTP server once it actually exists.
injectWebSocket(server);

server.listen(env.PORT, env.HOST, () => {
  console.log(`example backend listening on http://${env.HOST}:${env.PORT}`);
});

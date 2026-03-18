import { createAdaptorServer } from "@hono/node-server";
import type { HttpBindings } from "@hono/node-server";
import crossws, { type NodeAdapter } from "crossws/adapters/node";
import { getWsTest2ServiceEnv, wsTest2ServiceManifest } from "@iterate-com/ws-test-2-contract";
import { createApp } from "./api/app.ts";
import { createNodePtyHooks } from "./api/pty-node.ts";

const env = getWsTest2ServiceEnv();
const { app, ws } = await createApp<HttpBindings, NodeAdapter>({
  env,
  // This import stays in the Node entrypoint on purpose. If the shared
  // `app.ts` file references `./pty-node.ts`, workerd sees the import and tries
  // to bundle `node:crypto`, `node:os`, and `@lydell/node-pty`.
  ptyHooks: createNodePtyHooks(),
  createWebSocketServer: (options) => crossws(options),
});

const server = createAdaptorServer({ fetch: app.fetch });
const host = env.HOST ?? "0.0.0.0";
const port = env.PORT ?? 3000;

server.on("upgrade", (request, socket, head) => {
  // Let CrossWS decide whether the request maps to a websocket route. Node's
  // job here is just to hand upgrade requests over to the adapter.
  void ws.handleUpgrade(request, socket, head).catch((error: unknown) => {
    console.error(error);
    socket.destroy();
  });
});

server.listen(port, host, () => {
  console.log(`${wsTest2ServiceManifest.displayName} backend listening on http://${host}:${port}`);
});

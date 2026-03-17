import { createAdaptorServer } from "@hono/node-server";
import type { HttpBindings } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { onError } from "@orpc/server";
import { RPCHandler as WebSocketRPCHandler } from "@orpc/server/ws";
import type { WebSocket } from "ws";
import { configureApp } from "./api/app.ts";
import { createContext } from "./api/context.ts";
import { createPtyRouter } from "./api/pty.ts";
import { router } from "./api/router.ts";
import { getWsTest2ServiceEnv, wsTest2ServiceManifest } from "./manifest.ts";

const env = getWsTest2ServiceEnv();
const app = new Hono<{ Bindings: HttpBindings }>();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
const wsHandler = new WebSocketRPCHandler(router, {
  interceptors: [
    onError((error) => {
      console.error(error);
    }),
  ],
});

configureApp(app, {
  upgradeWebSocket,
  getContext: () => createContext(process.env),
  createPtyApp: createPtyRouter,
  createOrpcWebSocketHandlers: () => ({
    onOpen(_event: unknown, ws: { raw?: WebSocket }) {
      if (!ws.raw) return;
      void wsHandler.upgrade(ws.raw, {
        context: createContext(process.env),
      });
    },
  }),
});

const server = createAdaptorServer({ fetch: app.fetch });
const host = env.HOST ?? "0.0.0.0";
const port = env.PORT ?? 3000;

injectWebSocket(server);

server.listen(port, host, () => {
  console.log(`${wsTest2ServiceManifest.displayName} backend listening on http://${host}:${port}`);
});

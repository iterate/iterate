import type { HttpBindings } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { onError } from "@orpc/server";
import { RPCHandler as WebSocketRPCHandler } from "@orpc/server/ws";
import type { WebSocket } from "ws";
import { createContext } from "./context.ts";
import { createConfettiSocketHandlers } from "./confetti.ts";
import { applySharedHttpRoutes } from "./http-app.ts";
import { createPtyRouter } from "./pty.ts";
import { router } from "./router.ts";

const app = new Hono<{ Bindings: HttpBindings }>();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
const wsHandler = new WebSocketRPCHandler(router, {
  interceptors: [
    onError((error) => {
      console.error(error);
    }),
  ],
});

app.get(
  "/api/orpc/ws",
  upgradeWebSocket(() => ({
    onOpen(_event, ws) {
      void wsHandler.upgrade(ws.raw as WebSocket, {
        context: createContext(),
      });
    },
  })),
);

app.get(
  "/api/confetti/ws",
  upgradeWebSocket(() => createConfettiSocketHandlers()),
);

app.route("/api/pty", createPtyRouter({ upgradeWebSocket }));

applySharedHttpRoutes(app, {
  getContext: () => createContext(),
});

export default app;
export { injectWebSocket };

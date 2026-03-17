/// <reference types="@cloudflare/workers-types" />

import { Hono } from "hono";
import { upgradeWebSocket } from "hono/cloudflare-workers";
import { onError } from "@orpc/server";
import { RPCHandler as WorkerWebSocketRPCHandler } from "@orpc/server/websocket";
import { createContext } from "./api/context.ts";
import { createConfettiSocketHandlers } from "./api/confetti.ts";
import { applySharedHttpRoutes } from "./api/http-app.ts";
import { createUnavailablePtyRouter } from "./api/pty-unavailable.ts";
import { router } from "./api/router.ts";
import { Env } from "../env.ts";

const app = new Hono<{ Bindings: Env }>();
const wsHandler = new WorkerWebSocketRPCHandler(router, {
  interceptors: [
    onError((error) => {
      console.error(error);
    }),
  ],
});

app.get(
  "/api/orpc/ws",
  upgradeWebSocket(() => ({
    onMessage(event, ws) {
      const rawWebSocket = ws.raw;
      if (!rawWebSocket) return;
      const payload =
        event.data instanceof SharedArrayBuffer
          ? new Uint8Array(event.data).slice().buffer
          : event.data;
      void wsHandler.message(rawWebSocket, payload, {
        context: createContext({}),
      });
    },
    onClose(_event, ws) {
      const rawWebSocket = ws.raw;
      if (!rawWebSocket) return;
      wsHandler.close(rawWebSocket);
    },
  })),
);

app.get(
  "/api/confetti/ws",
  upgradeWebSocket(() => createConfettiSocketHandlers()),
);
app.route("/api/pty", createUnavailablePtyRouter({ upgradeWebSocket }));

applySharedHttpRoutes(app, {
  getContext: () => createContext({}),
});

app.get("*", async (c) => {
  const assetResponse = await c.env.ASSETS.fetch(c.req.raw);
  if (assetResponse.status !== 404) {
    return assetResponse;
  }

  const shellRequest = new Request(new URL("/_shell.html", c.req.url), c.req.raw);
  return await c.env.ASSETS.fetch(shellRequest);
});

export default app;

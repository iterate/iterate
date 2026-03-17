/// <reference types="@cloudflare/workers-types" />

import { Hono } from "hono";
import { upgradeWebSocket } from "hono/cloudflare-workers";
import { configureApp } from "./api/app.ts";
import { createContext } from "./api/context.ts";
import { createUnavailablePtyRouter } from "./api/pty-unavailable.ts";
import { Env } from "../env.ts";

const app = new Hono<{ Bindings: Env }>();

configureApp(app, {
  upgradeWebSocket,
  getContext: () => createContext({}),
  createPtyApp: createUnavailablePtyRouter,
  createOrpcWebSocketHandlers: () => ({
    onOpen(
      _event: unknown,
      ws: { send: (value: string) => void; close: (code?: number, reason?: string) => void },
    ) {
      ws.send(
        JSON.stringify({
          type: "error",
          message: "oRPC websocket is not implemented in Cloudflare Workers yet.",
        }),
      );
      ws.close(1013, "oRPC websocket not implemented");
    },
  }),
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

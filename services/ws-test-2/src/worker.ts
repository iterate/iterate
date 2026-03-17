/// <reference types="@cloudflare/workers-types" />

import { Hono } from "hono";
import { upgradeWebSocket } from "hono/cloudflare-workers";
import { createContext } from "./api/context.ts";
import { createConfettiSocketHandlers } from "./api/confetti.ts";
import { applySharedHttpRoutes } from "./api/http-app.ts";
import { createUnavailablePtyRouter } from "./api/pty-unavailable.ts";
import { Env } from "../env.ts";

const app = new Hono<{ Bindings: Env }>();

applySharedHttpRoutes(app, {
  getContext: () => createContext({}),
});

app.get(
  "/api/confetti/ws",
  upgradeWebSocket(() => createConfettiSocketHandlers()),
);
app.route("/api/pty", createUnavailablePtyRouter({ upgradeWebSocket }));

app.get("*", async (c) => {
  const assetResponse = await c.env.ASSETS.fetch(c.req.raw);
  if (assetResponse.status !== 404) {
    return assetResponse;
  }

  const shellRequest = new Request(new URL("/_shell.html", c.req.url), c.req.raw);
  return await c.env.ASSETS.fetch(shellRequest);
});

export default app;

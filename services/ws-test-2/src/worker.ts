/// <reference types="@cloudflare/workers-types" />

import { Hono } from "hono";
import { upgradeWebSocket } from "hono/cloudflare-workers";
import { configureApp } from "./api/app.ts";
import { createContext } from "./api/context.ts";
import { Env } from "../env.ts";

declare const ENABLE_PTY: boolean;

function createWorkerPtyUnavailableApp() {
  const app = new Hono();

  app.get("/ws", (c) => {
    if (c.req.header("upgrade") !== "websocket") {
      return c.text("Expected websocket", 426);
    }

    // Hono's Cloudflare websocket helper does not support `onOpen`, so the
    // worker-only PTY fallback uses a manual WebSocketPair to emit the initial
    // "not implemented" message immediately on connect.
    // https://hono.dev/docs/helpers/websocket
    // https://developers.cloudflare.com/workers/runtime-apis/websockets/
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();
    server.send("\r\nPTY is not implemented in Cloudflare Workers.\r\n");
    server.close(4000, "PTY not implemented");

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  });

  return app;
}

const app = new Hono<{ Bindings: Env }>();

// Alchemy forwards Worker `bundle.define` values to esbuild, so this dead branch
// keeps the node-pty import out of the Cloudflare bundle while preserving the
// same mount point as the Node runtime.
// https://alchemy.run/providers/cloudflare/worker
// https://raw.githubusercontent.com/alchemy-run/alchemy/main/examples/cloudflare-worker/alchemy.run.ts
const ptyApp = ENABLE_PTY
  ? (await import("./api/pty.ts")).createPtyRouter({ upgradeWebSocket })
  : createWorkerPtyUnavailableApp();

configureApp(app, {
  upgradeWebSocket,
  getContext: () => createContext({}),
  ptyApp,
  orpcWebSocketHandlers: {
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
  },
});

app.get("*", async (c) => {
  const assetResponse = await c.env.ASSETS.fetch(c.req.raw);
  if (assetResponse.status !== 404) {
    return assetResponse;
  }

  if (new URL(c.req.url).pathname.startsWith("/assets/")) {
    return assetResponse;
  }

  const shellRequest = new Request(new URL("/_shell", c.req.url), c.req.raw);
  return await c.env.ASSETS.fetch(shellRequest);
});

export default app;

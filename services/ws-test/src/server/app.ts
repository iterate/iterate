import type { HttpBindings } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import { RPCHandler as WebSocketRPCHandler } from "@orpc/server/ws";
import { Hono } from "hono";
import { httpRpcHandler, router } from "./orpc.ts";

const app = new Hono<{ Bindings: HttpBindings }>();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

function shouldServeClientBundle() {
  return process.env.HONO_SERVE_CLIENT_BUNDLE?.trim().toLowerCase() === "true";
}

app.use("/api/rpc/*", async (c, next) => {
  const { matched, response } = await httpRpcHandler.handle(c.req.raw, {
    prefix: "/api/rpc",
    context: {},
  });

  if (matched) {
    return c.newResponse(response.body, response);
  }

  await next();
});

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    service: "ws-test",
  }),
);

const wsHandler = new WebSocketRPCHandler(router);

app.get(
  "/orpc/ws",
  upgradeWebSocket(() => ({
    onOpen: (_event, ws) => {
      void wsHandler.upgrade(ws.raw as import("./orpc.ts").OrpcWebSocket, {
        context: {},
      });
    },
  })),
);

if (shouldServeClientBundle()) {
  app.use(
    "/assets/*",
    serveStatic({
      root: "./dist/client",
    }),
  );
  app.get("*", serveStatic({ root: "./dist/client", path: "_shell.html" }));
}

export default app;
export { injectWebSocket };

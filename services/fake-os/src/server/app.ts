import { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { RPCHandler } from "@orpc/server/fetch";
import { onError } from "@orpc/server";
import { createNodeWebSocket } from "@hono/node-ws";
import { router } from "./router.ts";

const app = new Hono<{ Bindings: HttpBindings }>();

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

const rpcHandler = new RPCHandler(router, {
  interceptors: [
    onError((error) => {
      console.error(error);
    }),
  ],
});

app.all("/api/rpc/*", async (c) => {
  const { response } = await rpcHandler.handle(c.req.raw, {
    prefix: "/api/rpc",
    context: {},
  });
  return response ?? c.json({ error: "not_found" }, 404);
});

app.get("/api/health", (c) => c.json({ status: "ok" }));

app.get(
  "/api/ws",
  upgradeWebSocket(() => ({
    onMessage: (evt, ws) => {
      ws.send(`echo: ${evt.data}`);
    },
  })),
);

export default app;
export { injectWebSocket };

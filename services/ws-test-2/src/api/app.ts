import type { HttpBindings } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { getEnv, serviceName } from "./context.ts";
import { createPtyRouter } from "./pty.ts";
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
  const { matched, response } = await rpcHandler.handle(c.req.raw, {
    prefix: "/api/rpc",
    context: {
      env: getEnv(),
    },
  });

  if (!matched || !response) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.newResponse(response.body, response);
});

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    service: serviceName,
  }),
);

app.route("/api/pty", createPtyRouter({ upgradeWebSocket }));

export default app;
export { injectWebSocket };

import type { HttpBindings } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { createPtyRouter } from "./pty.ts";
import { httpRpcHandler } from "./orpc.ts";

const app = new Hono<{ Bindings: HttpBindings }>();
const nodeWebSocket = createNodeWebSocket({ app });
const { upgradeWebSocket } = nodeWebSocket;

function shouldHandleWebSocketUpgrade(url: string | undefined) {
  const pathname = new URL(url ?? "/", "http://localhost").pathname;
  return pathname === "/api/pty/ws";
}

function injectWebSocket(server: Parameters<typeof nodeWebSocket.injectWebSocket>[0]) {
  nodeWebSocket.injectWebSocket({
    on(event, listener) {
      if (event !== "upgrade") {
        server.on(event as never, listener as never);
        return this;
      }

      server.on("upgrade", (request, socket, head) => {
        if (!shouldHandleWebSocketUpgrade(request.url)) {
          return;
        }

        listener(request, socket, head);
      });
      return this;
    },
  } as Parameters<typeof nodeWebSocket.injectWebSocket>[0]);
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

app.route("/api/pty", createPtyRouter({ upgradeWebSocket }));

export default app;
export { injectWebSocket };

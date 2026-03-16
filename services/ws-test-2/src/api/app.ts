import type { HttpBindings } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { z } from "zod";
import { getEnv, serviceName } from "./context.ts";
import { createPtyRouter } from "./pty.ts";
import { router } from "./router.ts";

const app = new Hono<{ Bindings: HttpBindings }>();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

const confettiMessageSchema = z.object({
  type: z.literal("launch"),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

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

app.get(
  "/api/confetti/ws",
  upgradeWebSocket(() => {
    let interval: ReturnType<typeof setInterval> | null = null;

    return {
      onOpen(_event, ws) {
        interval = setInterval(() => {
          ws.send(
            JSON.stringify({
              type: "boom",
              x: Math.random(),
              y: Math.random() * 0.6 + 0.1,
            }),
          );
        }, 1300);
      },
      onMessage(event, ws) {
        try {
          const message = confettiMessageSchema.parse(JSON.parse(String(event.data)));
          ws.send(
            JSON.stringify({
              type: "boom",
              x: message.x,
              y: message.y,
            }),
          );
        } catch {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Invalid confetti payload",
            }),
          );
        }
      },
      onClose() {
        if (interval) clearInterval(interval);
      },
      onError() {
        if (interval) clearInterval(interval);
      },
    };
  }),
);

app.route("/api/pty", createPtyRouter({ upgradeWebSocket }));

export default app;
export { injectWebSocket };

import { Hono } from "hono";

const ptyUnavailableMessage = "\r\nPTY is not implemented in Cloudflare Workers.\r\n";
const NO_RECONNECT_CODE = 4000;

export function createUnavailablePtyRouter(_params: { upgradeWebSocket: any }) {
  const router = new Hono();

  router.get("/ws", (c) => {
    if (c.req.header("upgrade") !== "websocket") {
      return c.text("Expected websocket", 426);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();
    server.send(ptyUnavailableMessage);
    server.close(NO_RECONNECT_CODE, "PTY not implemented");

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  });

  return router;
}

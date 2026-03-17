import { Hono } from "hono";

const ptyUnavailableMessage = "\r\nPTY is not implemented in Cloudflare Workers.\r\n";

export function createUnavailablePtyRouter(params: { upgradeWebSocket: any }) {
  const router = new Hono();

  router.get(
    "/ws",
    params.upgradeWebSocket(() => ({
      onOpen(
        _event: unknown,
        ws: { send: (value: string) => void; close: (code?: number, reason?: string) => void },
      ) {
        ws.send(ptyUnavailableMessage);
        ws.close(1013, "PTY not implemented");
      },
    })),
  );

  return router;
}

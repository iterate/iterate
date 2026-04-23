/**
 * Custom server entry — handles WebSocket upgrades for oRPC,
 * delegates everything else to TanStack Start.
 */
import handler from "@tanstack/react-start/server-entry";
import { wsRpcHandler } from "./orpc/ws-handler";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade for oRPC
    if (request.headers.get("Upgrade") === "websocket" && url.pathname === "/api/rpc-ws") {
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      server.accept();

      server.addEventListener("message", (event) => {
        const data = event.data;
        const peer = { send: (d: string) => server.send(d) };
        const message =
          typeof data === "string"
            ? { rawData: data, uint8Array: () => new TextEncoder().encode(data) }
            : { rawData: data, uint8Array: () => new Uint8Array(data as ArrayBuffer) };

        wsRpcHandler.message(peer, message, { context: {} });
      });

      server.addEventListener("close", () => {
        const peer = { send: (d: string) => server.send(d) };
        wsRpcHandler.close(peer);
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    // Everything else: TanStack Start
    return handler.fetch(request);
  },
};

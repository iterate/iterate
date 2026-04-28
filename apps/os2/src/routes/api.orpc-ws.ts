import { createFileRoute } from "@tanstack/react-router";
import { NitroWebSocketResponse } from "@iterate-com/shared/nitro-ws-response";
import { orpcWebSocketHandler } from "~/orpc/handler.ts";

export const Route = createFileRoute("/api/orpc-ws")({
  server: {
    handlers: {
      GET: ({ context, request }) =>
        new NitroWebSocketResponse({
          message(peer, message) {
            return orpcWebSocketHandler.message(peer, message, {
              context: {
                ...context,
                rawRequest: request,
              },
            });
          },
          close(peer) {
            orpcWebSocketHandler.close(peer);
          },
          error(peer) {
            orpcWebSocketHandler.close(peer);
          },
        }),
    },
  },
});

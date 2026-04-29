import { createFileRoute } from "@tanstack/react-router";
import { auth } from "@clerk/tanstack-react-start/server";
import { NitroWebSocketResponse } from "@iterate-com/shared/nitro-ws-response";
import { orpcWebSocketHandler } from "~/orpc/handler.ts";

export const Route = createFileRoute("/api/orpc-ws")({
  server: {
    handlers: {
      GET: async ({ context, request }) => {
        const clerkAuth = await auth();
        return new NitroWebSocketResponse({
          message(peer, message) {
            return orpcWebSocketHandler.message(peer, message, {
              context: {
                ...context,
                auth: clerkAuth,
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
        });
      },
    },
  },
});

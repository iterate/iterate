import { createFileRoute } from "@tanstack/react-router";
import { auth } from "@clerk/tanstack-react-start/server";
import { NitroWebSocketResponse } from "@iterate-com/shared/nitro-ws-response";
import { orpcWebSocketHandler } from "~/orpc/handler.ts";

export const Route = createFileRoute("/api/orpc-ws")({
  server: {
    handlers: {
      GET: async ({ context, request }) => {
        const clerkAuth = await auth();
        const requestedOrganizationSlug = new URL(request.url).searchParams.get("organizationSlug");
        if (
          requestedOrganizationSlug &&
          (!clerkAuth.isAuthenticated || clerkAuth.orgSlug !== requestedOrganizationSlug)
        ) {
          return new Response("WebSocket organization mismatch", { status: 403 });
        }

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

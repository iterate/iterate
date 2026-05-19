import { createFileRoute } from "@tanstack/react-router";
import { NitroWebSocketResponse } from "@iterate-com/shared/nitro-ws-response";
import { orpcWebSocketHandler } from "~/orpc/handler.ts";

export const Route = createFileRoute("/api/orpc-ws")({
  server: {
    handlers: {
      GET: async ({ context, request }) => {
        const requestedOrganizationSlug = new URL(request.url).searchParams.get("organizationSlug");
        const principal = context.principal;
        if (
          requestedOrganizationSlug &&
          (principal?.type !== "user" ||
            !principal.organizations.some((org) => org.slug === requestedOrganizationSlug))
        ) {
          return new Response("WebSocket organization mismatch", { status: 403 });
        }

        return new NitroWebSocketResponse({
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
        });
      },
    },
  },
});

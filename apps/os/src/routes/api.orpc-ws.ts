import { createFileRoute } from "@tanstack/react-router";
import { NitroWebSocketResponse } from "@iterate-com/shared/nitro-ws-response";
import { orpcWebSocketHandler } from "~/orpc/handler.ts";
import { requireRequestContext } from "~/request-context.ts";

export const Route = createFileRoute("/api/orpc-ws")({
  server: {
    handlers: {
      GET: async ({ context, request }) => {
        const requestContext = requireRequestContext(context);
        const requestedOrganizationSlug = new URL(request.url).searchParams.get("organizationSlug");
        const principal = requestContext.principal;
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
                ...requestContext,
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

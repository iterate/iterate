import { createFileRoute } from "@tanstack/react-router";
import { auth } from "@clerk/tanstack-react-start/server";
import { handleIntegrationApiRequest } from "~/domains/secrets/integration-api.ts";
import { orpcOpenApiHandler } from "~/orpc/handler.ts";

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      ANY: async ({ context, request }) => {
        const clerkAuth = await auth();
        const integrationResponse = await handleIntegrationApiRequest({
          auth: clerkAuth,
          context: {
            ...context,
            auth: clerkAuth,
            rawRequest: request,
          },
          request,
        });
        if (integrationResponse) return integrationResponse;

        const { matched, response } = await orpcOpenApiHandler.handle(request, {
          prefix: "/api",
          context: {
            ...context,
            auth: clerkAuth,
            rawRequest: request,
          },
        });

        if (matched) return response;
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    },
  },
});

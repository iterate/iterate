import { createFileRoute } from "@tanstack/react-router";
import { handleIntegrationApiRequest } from "~/domains/secrets/integration-api.ts";
import { orpcOpenApiHandler } from "~/orpc/handler.ts";

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      ANY: async ({ context, request }) => {
        const requestContext = { ...context, rawRequest: request };
        const integrationResponse = await handleIntegrationApiRequest({
          auth: context.principal,
          context: requestContext,
          request,
        });
        if (integrationResponse) return integrationResponse;

        const { matched, response } = await orpcOpenApiHandler.handle(request, {
          prefix: "/api",
          context: requestContext,
        });

        if (matched) return response;
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    },
  },
});

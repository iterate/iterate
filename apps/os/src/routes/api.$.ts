import { createFileRoute } from "@tanstack/react-router";
import { requireRequestContext } from "~/request-context.ts";
import { handleIntegrationIngress } from "~/domains/integrations/ingress.ts";
import { orpcOpenApiHandler } from "~/orpc/handler.ts";

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      ANY: async ({ context, request }) => {
        const requestContext = { ...requireRequestContext(context), rawRequest: request };
        const integrationResponse = await handleIntegrationIngress({
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

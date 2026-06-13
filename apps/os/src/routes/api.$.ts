import { createFileRoute } from "@tanstack/react-router";
import { requireRequestContext } from "~/request-context.ts";
import { handleIntegrationApiRequest } from "~/domains/secrets/integration-api.ts";

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      ANY: async ({ context, request }) => {
        const requestContext = { ...requireRequestContext(context), rawRequest: request };
        const integrationResponse = await handleIntegrationApiRequest({
          auth: requestContext.principal,
          context: requestContext,
          request,
        });
        if (integrationResponse) return integrationResponse;

        return Response.json({ error: "not_found" }, { status: 404 });
      },
    },
  },
});

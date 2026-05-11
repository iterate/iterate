import { createFileRoute } from "@tanstack/react-router";
import { orpcOpenApiHandler } from "~/orpc/handler.ts";

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      ANY: async ({ context, request }) => {
        const { matched, response } = await orpcOpenApiHandler.handle(request, {
          prefix: "/api",
          context: {
            ...context,
            rawRequest: request,
          },
        });

        if (matched && response) return response;
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    },
  },
});

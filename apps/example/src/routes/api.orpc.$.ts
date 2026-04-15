import { createFileRoute } from "@tanstack/react-router";
import { orpcRpcHandler } from "~/orpc/handler.ts";

export const Route = createFileRoute("/api/orpc/$")({
  server: {
    handlers: {
      ANY: async ({ context, request }) => {
        const { matched, response } = await orpcRpcHandler.handle(request, {
          prefix: "/api/orpc",
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

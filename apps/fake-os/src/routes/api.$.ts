import { createFileRoute } from "@tanstack/react-router";
import { orpcOpenApiHandler } from "~/orpc/handler.ts";

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      ANY: async ({ context, request }) => {
        try {
          const { matched, response } = await orpcOpenApiHandler.handle(request, {
            prefix: "/api",
            context,
          });

          if (matched) return response;
          return Response.json({ error: "not_found" }, { status: 404 });
        } catch (error) {
          console.error(error);
          return Response.json({ error: "internal_server_error" }, { status: 500 });
        }
      },
    },
  },
});

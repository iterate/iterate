import { createFileRoute } from "@tanstack/react-router";
import { orpcOpenApiHandler } from "~/orpc/handler.ts";
import { handleEventsForwardedPost } from "~/server/events-forwarded-post.ts";

function normalizePathname(pathname: string) {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      ANY: async ({ context, request }) => {
        const pathname = normalizePathname(new URL(request.url).pathname);
        if (pathname === "/api/events-forwarded" && request.method === "POST") {
          return handleEventsForwardedPost({ context, request });
        }

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

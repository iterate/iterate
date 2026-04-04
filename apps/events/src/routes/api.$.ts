import { createFileRoute } from "@tanstack/react-router";
import { getRequestUrl } from "@tanstack/react-start/server";
import { orpcOpenApiHandler } from "~/orpc/handler.ts";

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      ANY: async ({ context, request }) => {
        const rewrittenRequest = await rewriteStreamsRequest({
          request,
          url: getRequestUrl(),
        });

        const { matched, response } = await orpcOpenApiHandler.handle(rewrittenRequest, {
          prefix: "/api",
          context: {
            ...context,
            rawRequest: rewrittenRequest,
          },
        });

        if (matched && response) return response;
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    },
  },
});

/*
 * For curl ergonomics, we rewrite /api/streams/ to /api/streams/%2F
 * so GET /api/streams/ or POST /api/streams/ works
 *
 * Simiarly, we allow raw events (not nested in `{ event: ... }`) to be appended via
 * POST /api/streams/ . It's a bit janky but makes our curl intro much nicer
 */
async function rewriteStreamsRequest(args: { request: Request; url: URL }) {
  const rewrittenUrl = new URL(args.url);

  if (/^\/api\/streams\/+$/.test(rewrittenUrl.pathname)) {
    rewrittenUrl.pathname = "/api/streams/%2F";
  }

  const pathRewrittenRequest =
    rewrittenUrl.pathname === args.url.pathname
      ? args.request
      : new Request(rewrittenUrl, args.request);

  if (
    pathRewrittenRequest.method !== "POST" ||
    !rewrittenUrl.pathname.startsWith("/api/streams/")
  ) {
    return pathRewrittenRequest;
  }

  const contentType = pathRewrittenRequest.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return pathRewrittenRequest;
  }

  const parsedBody = await pathRewrittenRequest
    .clone()
    .json()
    .catch(() => null);

  if (parsedBody == null || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
    return pathRewrittenRequest;
  }

  if ("event" in parsedBody) {
    return pathRewrittenRequest;
  }

  return new Request(rewrittenUrl, {
    method: pathRewrittenRequest.method,
    headers: pathRewrittenRequest.headers,
    body: JSON.stringify({ event: parsedBody }),
  });
}

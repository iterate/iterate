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
 * For curl ergonomics:
 * - rewrite /api/streams/ to /api/streams/%2F so root stream requests stay short
 * - wrap a bare JSON event body into { event } so `curl -d '{"type":"..."}'` works
 */
async function rewriteStreamsRequest(args: { request: Request; url: URL }) {
  const rewrittenUrl = new URL(args.url);
  let rewrittenRequest = args.request;

  if (/^\/api\/streams\/+$/.test(rewrittenUrl.pathname)) {
    rewrittenUrl.pathname = "/api/streams/%2F";
  }

  if (rewrittenUrl.pathname !== args.url.pathname) {
    rewrittenRequest = new Request(rewrittenUrl, rewrittenRequest);
  }

  if (!shouldWrapBareStreamEvent(rewrittenRequest, rewrittenUrl)) {
    return rewrittenRequest;
  }

  const parsedBody = await tryParseJsonBody(rewrittenRequest);
  if (!isBareStreamEventBody(parsedBody)) {
    return rewrittenRequest;
  }

  return new Request(rewrittenUrl, {
    method: rewrittenRequest.method,
    headers: rewrittenRequest.headers,
    body: JSON.stringify({ event: parsedBody }),
  });
}

function shouldWrapBareStreamEvent(request: Request, url: URL) {
  return (
    request.method === "POST" &&
    /^\/api\/streams\/.+/.test(url.pathname) &&
    request.headers.get("content-type")?.includes("application/json") === true
  );
}

async function tryParseJsonBody(request: Request) {
  try {
    return await request.clone().json();
  } catch {
    return undefined;
  }
}

function isBareStreamEventBody(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    return false;
  }

  const objectValue = value as Record<string, unknown>;

  if ("event" in objectValue) {
    return false;
  }

  return typeof objectValue.type === "string";
}

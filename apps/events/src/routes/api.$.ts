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
 * - rewrite root stream URLs to their canonical %2F path form
 * - wrap a bare JSON event body into { event } so `curl -d '{"type":"..."}'` works
 */
async function rewriteStreamsRequest(args: { request: Request; url: URL }) {
  const rewrittenUrl = new URL(args.url);
  let rewrittenRequest = args.request;

  rewrittenUrl.pathname = rewriteRootStreamPath(rewrittenUrl.pathname);

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

function rewriteRootStreamPath(pathname: string) {
  if (/^\/api\/streams\/+$/.test(pathname)) {
    return "/api/streams/%2F";
  }

  if (/^\/api\/streams\/__state\/+$/.test(pathname)) {
    return "/api/streams/__state/%2F";
  }

  if (/^\/api\/streams\/__children\/+$/.test(pathname)) {
    return "/api/streams/__children/%2F";
  }

  return pathname;
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

  return true;
}

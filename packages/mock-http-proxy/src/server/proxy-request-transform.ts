import type { TransformRequest, TransformWebSocketUrl } from "./msw-server-adapter.ts";
import { parseForwardedHeader } from "@iterate-com/shared/forwarded-header";

const FORWARDED_HEADER = "forwarded";

const PROXY_HEADERS_TO_STRIP = new Set([FORWARDED_HEADER]);

function resolveTargetUrl(requestUrl: URL, headers: Headers, scheme: "http" | "ws"): URL | null {
  const parsedForwarded = parseForwardedHeader(headers.get(FORWARDED_HEADER) ?? "");
  const host = parsedForwarded.host ?? headers.get("host") ?? "";
  if (!host) return null;

  const proto = parsedForwarded.proto ?? "";

  let targetScheme: string;
  if (scheme === "ws") {
    targetScheme = proto === "http" || proto === "ws" ? "ws" : "wss";
  } else {
    targetScheme = proto === "https" || proto === "wss" ? "https" : "http";
  }

  const path = requestUrl.pathname + requestUrl.search;
  return new URL(`${targetScheme}://${host}${path}`);
}

function stripProxyHeaders(headers: Headers): Headers {
  const cleaned = new Headers(headers);
  for (const name of PROXY_HEADERS_TO_STRIP) {
    cleaned.delete(name);
  }
  return cleaned;
}

/**
 * Creates a TransformRequest that rewrites the incoming proxy request URL
 * to the original target URL using the standard `Forwarded` header.
 *
 * Also strips the proxy-specific headers from the outgoing Request so MSW
 * handlers see a clean request matching the original target.
 */
export function createProxyRequestTransform(): TransformRequest {
  return (request: Request): Request => {
    const requestUrl = new URL(request.url);
    const targetUrl = resolveTargetUrl(requestUrl, request.headers, "http");
    if (!targetUrl) return request;

    const cleanedHeaders = stripProxyHeaders(request.headers);
    cleanedHeaders.set("host", targetUrl.host);

    return new Request(targetUrl, {
      method: request.method,
      headers: cleanedHeaders,
      body: request.body,
      duplex: "half",
    } as RequestInit);
  };
}

/**
 * Creates a TransformWebSocketUrl that rewrites the incoming WebSocket upgrade
 * URL to the original target using the same iterate proxy headers.
 */
export function createProxyWebSocketUrlTransform(): TransformWebSocketUrl {
  return (url: URL, headers: Headers): URL => {
    return resolveTargetUrl(url, headers, "ws") ?? url;
  };
}

export { PROXY_HEADERS_TO_STRIP };

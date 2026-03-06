import type { TransformRequest, TransformWebSocketUrl } from "./msw-server-adapter.ts";

const X_FORWARDED_HOST_HEADER = "x-forwarded-host";
const X_FORWARDED_PROTO_HEADER = "x-forwarded-proto";

const PROXY_HEADERS_TO_STRIP: ReadonlySet<string> = new Set([
  X_FORWARDED_HOST_HEADER,
  X_FORWARDED_PROTO_HEADER,
]);

function isLoopbackHost(host: string): boolean {
  const trimmedHost = host.trim();
  let name = "";
  if (trimmedHost.startsWith("[")) {
    const closingBracket = trimmedHost.indexOf("]");
    name = (
      closingBracket > 0 ? trimmedHost.slice(1, closingBracket) : trimmedHost.slice(1)
    ).toLowerCase();
  } else {
    name = (trimmedHost.split(":")[0] ?? "").toLowerCase();
  }

  return name === "localhost" || name === "::1" || name === "127.0.0.1" || name.startsWith("127.");
}

function normalizeProto(value: string): string {
  return value.trim().toLowerCase().replace(/:$/, "");
}

function resolveTargetUrl(requestUrl: URL, headers: Headers, scheme: "http" | "ws"): URL | null {
  const host = headers.get(X_FORWARDED_HOST_HEADER) ?? headers.get("host") ?? "";
  if (!host) return null;

  const proto = normalizeProto(headers.get(X_FORWARDED_PROTO_HEADER) ?? "");

  let targetScheme: string;
  if (scheme === "ws") {
    if (proto === "https" || proto === "wss") {
      targetScheme = "wss";
    } else if (proto === "http" || proto === "ws") {
      targetScheme = "ws";
    } else {
      targetScheme = isLoopbackHost(host) ? "ws" : "wss";
    }
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
 * to the original target URL using `x-forwarded-host` + `x-forwarded-proto`.
 *
 * Also strips proxy-specific headers from the outgoing Request so MSW
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
 * URL to the original target using the same proxy headers.
 */
export function createProxyWebSocketUrlTransform(): TransformWebSocketUrl {
  return (url: URL, headers: Headers): URL => {
    return resolveTargetUrl(url, headers, "ws") ?? url;
  };
}

export { PROXY_HEADERS_TO_STRIP };

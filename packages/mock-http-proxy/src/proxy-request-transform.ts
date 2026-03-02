import type { TransformRequest, TransformWebSocketUrl } from "@iterate-com/msw-http-server";

const TARGET_URL_HEADER = "x-iterate-target-url";
const LEGACY_TARGET_URL_HEADER = "x-target-url";
const ORIGINAL_HOST_HEADER = "x-iterate-original-host";
const LEGACY_ORIGINAL_HOST_HEADER = "x-original-host";
const ORIGINAL_PROTO_HEADER = "x-iterate-original-proto";
const LEGACY_ORIGINAL_PROTO_SHORT_HEADER = "x-original-proto";
const LEGACY_ORIGINAL_PROTO_HEADER = "x-original-protocol";
const LEGACY_ORIGINAL_SCHEME_HEADER = "x-original-scheme";
const TARGET_PATH_PREFIX = "/__iterate_target__/";

const PROXY_HEADERS_TO_STRIP = new Set([
  TARGET_URL_HEADER,
  LEGACY_TARGET_URL_HEADER,
  ORIGINAL_HOST_HEADER,
  LEGACY_ORIGINAL_HOST_HEADER,
  ORIGINAL_PROTO_HEADER,
  LEGACY_ORIGINAL_PROTO_SHORT_HEADER,
  LEGACY_ORIGINAL_PROTO_HEADER,
  LEGACY_ORIGINAL_SCHEME_HEADER,
]);

function firstHeaderValue(headers: Headers, ...names: string[]): string {
  for (const name of names) {
    const value = headers.get(name);
    if (value) return value;
  }
  return "";
}

function targetFromEncodedPath(
  pathname: string,
  search: string,
  scheme: "http" | "ws",
): URL | null {
  if (!pathname.startsWith(TARGET_PATH_PREFIX)) return null;

  const rest = pathname.slice(TARGET_PATH_PREFIX.length);
  const slashIndex = rest.indexOf("/");
  if (slashIndex <= 0) return null;

  const encodedBase = rest.slice(0, slashIndex);
  const base = new URL(decodeURIComponent(encodedBase));
  normalizeProtocol(base, scheme);
  const relativePath = rest.slice(slashIndex);
  return new URL(`${relativePath}${search}`, base);
}

function normalizeProtocol(url: URL, scheme: "http" | "ws"): void {
  if (scheme === "ws") {
    if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol === "https:") url.protocol = "wss:";
  } else {
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
  }
}

function resolveTargetUrl(requestUrl: URL, headers: Headers, scheme: "http" | "ws"): URL | null {
  const pathTarget = targetFromEncodedPath(requestUrl.pathname, requestUrl.search, scheme);
  if (pathTarget) return pathTarget;

  const headerTarget = firstHeaderValue(headers, TARGET_URL_HEADER, LEGACY_TARGET_URL_HEADER);
  if (headerTarget) {
    const base = new URL(headerTarget);
    normalizeProtocol(base, scheme);
    const result = new URL(`${requestUrl.pathname}${requestUrl.search}`, base);
    normalizeProtocol(result, scheme);
    return result;
  }

  const host = firstHeaderValue(headers, ORIGINAL_HOST_HEADER, LEGACY_ORIGINAL_HOST_HEADER, "host");
  if (!host) return null;

  const proto = firstHeaderValue(
    headers,
    ORIGINAL_PROTO_HEADER,
    LEGACY_ORIGINAL_PROTO_SHORT_HEADER,
    LEGACY_ORIGINAL_PROTO_HEADER,
    LEGACY_ORIGINAL_SCHEME_HEADER,
    "x-forwarded-proto",
  ).toLowerCase();

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
 * to the original target URL using standard iterate proxy headers
 * (x-iterate-target-url, x-iterate-original-host, x-iterate-original-proto, etc.).
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

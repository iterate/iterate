import type { TransformRequest, TransformWebSocketUrl } from "@iterate-com/msw-http-server";

const FORWARDED_HEADER = "forwarded";
const ORIGINAL_HOST_HEADER = "x-iterate-original-host";
const LEGACY_ORIGINAL_HOST_HEADER = "x-original-host";
const ORIGINAL_PROTO_HEADER = "x-iterate-original-proto";
const LEGACY_ORIGINAL_PROTO_SHORT_HEADER = "x-original-proto";
const LEGACY_ORIGINAL_PROTO_HEADER = "x-original-protocol";
const LEGACY_ORIGINAL_SCHEME_HEADER = "x-original-scheme";

const PROXY_HEADERS_TO_STRIP = new Set([FORWARDED_HEADER]);

type ParsedForwarded = {
  host?: string;
  proto?: string;
};

function parseForwardedHeader(forwarded: string): ParsedForwarded {
  const firstEntry = forwarded.split(",")[0]?.trim() ?? "";
  if (!firstEntry) return {};

  const attributes = firstEntry.split(";");
  let host: string | undefined;
  let proto: string | undefined;

  for (const rawAttribute of attributes) {
    const [rawKey, ...rawValueParts] = rawAttribute.split("=");
    const key = rawKey?.trim().toLowerCase();
    const rawValue = rawValueParts.join("=").trim();
    const value = rawValue.replace(/^"|"$/g, "");

    if (!key || !value) continue;
    if (key === "host") host = value;
    if (key === "proto") proto = value.toLowerCase();
  }

  return { host, proto };
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
  const parsedForwarded = parseForwardedHeader(headers.get(FORWARDED_HEADER) ?? "");
  const host =
    parsedForwarded.host ??
    headers.get(ORIGINAL_HOST_HEADER) ??
    headers.get(LEGACY_ORIGINAL_HOST_HEADER) ??
    headers.get("host") ??
    "";
  if (!host) return null;

  const proto = (
    parsedForwarded.proto ??
    headers.get(ORIGINAL_PROTO_HEADER) ??
    headers.get(LEGACY_ORIGINAL_PROTO_SHORT_HEADER) ??
    headers.get(LEGACY_ORIGINAL_PROTO_HEADER) ??
    headers.get(LEGACY_ORIGINAL_SCHEME_HEADER) ??
    headers.get("x-forwarded-proto") ??
    ""
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

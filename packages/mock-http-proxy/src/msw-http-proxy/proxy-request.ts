import type { MockMswHttpProxyRequestRewrite } from "./types.ts";

const TARGET_URL_HEADER = "x-iterate-target-url";
const LEGACY_TARGET_URL_HEADER = "x-target-url";
const ORIGINAL_HOST_HEADER = "x-iterate-original-host";
const LEGACY_ORIGINAL_HOST_HEADER = "x-original-host";
const ORIGINAL_PROTO_HEADER = "x-iterate-original-proto";
const LEGACY_ORIGINAL_PROTO_SHORT_HEADER = "x-original-proto";
const LEGACY_ORIGINAL_PROTO_HEADER = "x-original-protocol";
const LEGACY_ORIGINAL_SCHEME_HEADER = "x-original-scheme";
const TARGET_PATH_PREFIX = "/__iterate_target__/";

const EXCLUDED_UPSTREAM_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  TARGET_URL_HEADER,
  LEGACY_TARGET_URL_HEADER,
  ORIGINAL_HOST_HEADER,
  LEGACY_ORIGINAL_HOST_HEADER,
  ORIGINAL_PROTO_HEADER,
  LEGACY_ORIGINAL_PROTO_SHORT_HEADER,
  LEGACY_ORIGINAL_PROTO_HEADER,
  LEGACY_ORIGINAL_SCHEME_HEADER,
]);

export type PreparedProxyRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
};

export type SerializedHarBody = {
  text: string;
  encoding?: "base64";
  size: number;
};

function normalizeHeaders(input: Headers): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of input.entries()) {
    normalized[name.toLowerCase()] = value;
  }
  return normalized;
}

function targetFromEncodedPath(rawUrl: string): URL | null {
  const parsed = new URL(rawUrl, "http://mock-http-proxy.local");
  if (!parsed.pathname.startsWith(TARGET_PATH_PREFIX)) return null;

  const rest = parsed.pathname.slice(TARGET_PATH_PREFIX.length);
  const slashIndex = rest.indexOf("/");
  if (slashIndex <= 0) return null;

  const encodedBase = rest.slice(0, slashIndex);
  const base = new URL(decodeURIComponent(encodedBase));
  const relativePath = rest.slice(slashIndex);
  return new URL(`${relativePath}${parsed.search}`, base);
}

function ensurePath(rawUrl: string): string {
  if (/^https?:\/\//i.test(rawUrl)) {
    const parsed = new URL(rawUrl);
    return `${parsed.pathname}${parsed.search}`;
  }

  if (rawUrl.startsWith("/")) return rawUrl;
  return `/${rawUrl}`;
}

export function prepareProxyRequest(
  request: Request,
  rewriteRequest: MockMswHttpProxyRequestRewrite | undefined,
): PreparedProxyRequest {
  const requestUrl = new URL(request.url);
  const prepared: PreparedProxyRequest = {
    method: request.method,
    url: `${requestUrl.pathname}${requestUrl.search}`,
    headers: normalizeHeaders(request.headers),
  };

  if (!rewriteRequest) return prepared;

  const rewritten = rewriteRequest({
    method: prepared.method,
    url: prepared.url,
    headers: { ...prepared.headers },
  });

  if (!rewritten) return prepared;

  if (rewritten.url !== undefined) {
    prepared.url = rewritten.url;
  }

  if (!rewritten.headers) return prepared;

  for (const [name, value] of Object.entries(rewritten.headers)) {
    const normalizedName = name.toLowerCase();
    if (value === undefined) {
      delete prepared.headers[normalizedName];
      continue;
    }
    prepared.headers[normalizedName] = value;
  }

  return prepared;
}

export function resolveHttpTargetUrl(prepared: PreparedProxyRequest): URL | null {
  const pathTarget = targetFromEncodedPath(prepared.url);
  if (pathTarget) return pathTarget;

  const headerTarget =
    prepared.headers[TARGET_URL_HEADER] ?? prepared.headers[LEGACY_TARGET_URL_HEADER] ?? "";
  if (headerTarget) {
    const base = new URL(headerTarget);
    return new URL(ensurePath(prepared.url), base);
  }

  if (/^https?:\/\//i.test(prepared.url)) {
    return new URL(prepared.url);
  }

  const host =
    prepared.headers[ORIGINAL_HOST_HEADER] ??
    prepared.headers[LEGACY_ORIGINAL_HOST_HEADER] ??
    prepared.headers.host;
  if (!host) return null;

  const proto = (
    prepared.headers[ORIGINAL_PROTO_HEADER] ??
    prepared.headers[LEGACY_ORIGINAL_PROTO_SHORT_HEADER] ??
    prepared.headers[LEGACY_ORIGINAL_PROTO_HEADER] ??
    prepared.headers[LEGACY_ORIGINAL_SCHEME_HEADER] ??
    prepared.headers["x-forwarded-proto"] ??
    "http"
  ).toLowerCase();

  const scheme = proto === "https" || proto === "wss" ? "https" : "http";
  return new URL(`${scheme}://${host}${ensurePath(prepared.url)}`);
}

export function createUpstreamRequestHeaders(headers: Record<string, string>): Headers {
  const upstreamHeaders = new Headers();

  for (const [name, value] of Object.entries(headers)) {
    if (EXCLUDED_UPSTREAM_HEADERS.has(name)) continue;
    upstreamHeaders.set(name, value);
  }

  return upstreamHeaders;
}

export async function readRequestBodyBytes(request: Request): Promise<Uint8Array | null> {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return null;

  const cloned = request.clone();
  const arrayBuffer = await cloned.arrayBuffer();
  if (arrayBuffer.byteLength === 0) return null;
  return new Uint8Array(arrayBuffer);
}

export function shouldTreatAsText(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return (
    normalized.startsWith("text/") ||
    normalized.includes("json") ||
    normalized.includes("xml") ||
    normalized.includes("javascript") ||
    normalized.includes("x-www-form-urlencoded") ||
    normalized.includes("multipart/form-data")
  );
}

export function serializeBodyForHar(
  bytes: Uint8Array | null,
  contentType: string,
): SerializedHarBody | null {
  if (!bytes || bytes.byteLength === 0) return null;

  const buffer = Buffer.from(bytes);
  if (shouldTreatAsText(contentType)) {
    return {
      text: buffer.toString("utf8"),
      size: buffer.byteLength,
    };
  }

  return {
    text: buffer.toString("base64"),
    encoding: "base64",
    size: buffer.byteLength,
  };
}

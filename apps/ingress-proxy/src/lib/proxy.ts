import {
  rootHostSchema,
  targetUrlSchema,
  type IngressProxyRoute,
} from "@iterate-com/ingress-proxy-contract";

const forwardingContextHeaderPrefixes = ["x-forwarded-"] as const;
const forwardingContextHeaderNames = new Set([
  "forwarded",
  "cf-connecting-ip",
  "true-client-ip",
  "x-real-ip",
]);

export class RouteInputError extends Error {}

function mapInputError(error: unknown, fallbackMessage: string): never {
  if (error instanceof Error) {
    throw new RouteInputError(error.message || fallbackMessage);
  }

  throw new RouteInputError(fallbackMessage);
}

export function normalizeInboundHost(rawHost: string | null): string | null {
  if (!rawHost) return null;
  const first = rawHost.split(",")[0]?.trim().toLowerCase() ?? "";
  if (!first) return null;

  let host: string;
  if (first.startsWith("[")) {
    const endBracket = first.indexOf("]");
    if (endBracket === -1) return null;
    host = first.slice(1, endBracket);
  } else {
    const lastColon = first.lastIndexOf(":");
    if (lastColon !== -1 && first.indexOf(":") === lastColon) {
      host = first.slice(0, lastColon);
    } else {
      host = first;
    }
  }

  return host.replace(/\.$/, "") || null;
}

export function normalizeRootHost(input: string): string {
  try {
    return rootHostSchema.parse(input);
  } catch (error) {
    return mapInputError(error, "rootHost is invalid");
  }
}

export function normalizeTargetUrl(input: string): string {
  try {
    return targetUrlSchema.parse(input);
  } catch (error) {
    return mapInputError(error, "targetUrl must be a valid URL");
  }
}

function firstHeaderToken(rawHeader: string | null | undefined): string | null {
  if (!rawHeader) return null;
  const token = rawHeader.split(",")[0]?.trim() ?? "";
  return token.length > 0 ? token : null;
}

function resolveOriginalRequestHost(request: Request): string {
  return firstHeaderToken(request.headers.get("host")) ?? new URL(request.url).host;
}

function resolveForwardingContext(request: Request) {
  return {
    host: resolveOriginalRequestHost(request),
  };
}

function isForwardingContextHeader(name: string): boolean {
  const lowered = name.toLowerCase();
  if (forwardingContextHeaderNames.has(lowered)) return true;
  if (forwardingContextHeaderPrefixes.some((prefix) => lowered.startsWith(prefix))) return true;
  return lowered.startsWith("x-") && lowered.includes("-original-");
}

function stripForwardingContextHeaders(headers: Headers): void {
  for (const headerName of [...headers.keys()]) {
    if (isForwardingContextHeader(headerName)) {
      headers.delete(headerName);
    }
  }
}

export function deriveCandidateRootHosts(rawHost: string | null): {
  exactRootHost: string;
  dunderRootHost: string | null;
  subhostRootHost: string | null;
} | null {
  const host = normalizeInboundHost(rawHost);
  if (!host) return null;

  const dunderSeparator = host.indexOf("__");
  const dotSeparator = host.indexOf(".");

  return {
    exactRootHost: host,
    dunderRootHost:
      dunderSeparator === -1 ? null : normalizeInboundHost(host.slice(dunderSeparator + 2)),
    subhostRootHost:
      dotSeparator === -1 ? null : normalizeInboundHost(host.slice(dotSeparator + 1)),
  };
}

export function buildUpstreamUrl(targetUrl: URL, requestUrl: URL): URL {
  const upstreamUrl = new URL(targetUrl.toString());
  const targetPathPrefix =
    upstreamUrl.pathname === "/" ? "" : upstreamUrl.pathname.replace(/\/$/, "");
  const inboundPath = requestUrl.pathname || "/";
  upstreamUrl.pathname = `${targetPathPrefix}${inboundPath}` || "/";
  upstreamUrl.search = requestUrl.search;
  upstreamUrl.hash = "";
  return upstreamUrl;
}

export function createUpstreamHeaders(request: Request, targetUrl: URL): Headers {
  const headers = new Headers(request.headers);
  const forwardingContext = resolveForwardingContext(request);
  stripForwardingContextHeaders(headers);
  headers.set("host", targetUrl.host);
  headers.set("x-forwarded-host", forwardingContext.host);
  return headers;
}

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function proxyRequestToRoute(
  request: Request,
  resolved: { route: IngressProxyRoute; targetUrl: URL },
): Promise<Response> {
  const inboundUrl = new URL(request.url);
  const upstreamUrl = buildUpstreamUrl(resolved.targetUrl, inboundUrl);
  let upstreamRequest: Request = new Request(upstreamUrl.toString(), request);
  const upstreamHeaders = createUpstreamHeaders(upstreamRequest, resolved.targetUrl);
  upstreamRequest = new Request(upstreamRequest, { headers: upstreamHeaders });

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamRequest, { redirect: "manual" });
  } catch {
    return jsonError(502, "proxy_error");
  }

  const responseHeaders = new Headers(upstreamResponse.headers);
  responseHeaders.set("x-cf-proxy-root-host", resolved.route.rootHost);
  responseHeaders.set("x-cf-proxy-route-id", resolved.route.id);

  if (upstreamResponse.status === 101) {
    return new Response(null, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
      webSocket: (upstreamResponse as Response & { webSocket?: WebSocket | null }).webSocket,
    } as ResponseInit);
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}

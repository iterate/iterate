import { rootHostSchema, targetUrlSchema } from "@iterate-com/ingress-proxy-contract";

type ForwardedProto = "http" | "https" | "ws" | "wss";

const forwardingContextHeaderPrefixes = ["x-forwarded-"] as const;
const forwardingContextHeaderNames = new Set([
  "forwarded",
  "cf-connecting-ip",
  "true-client-ip",
  "x-real-ip",
]);

export class RouteInputError extends Error {}

/**
 * The contract owns the canonical validation rules. These wrappers keep the
 * runtime proxy code using the same rules while translating schema failures
 * into a small local error type that the oRPC layer can map to BAD_REQUEST.
 */
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

function resolveClientIp(request: Request): string | null {
  return (
    firstHeaderToken(request.headers.get("cf-connecting-ip")) ??
    firstHeaderToken(request.headers.get("true-client-ip")) ??
    firstHeaderToken(request.headers.get("x-real-ip"))
  );
}

function normalizeForwardedProto(proto: string | undefined, request: Request): ForwardedProto {
  const normalized = proto?.trim().toLowerCase();
  const isWebsocket = request.headers.get("upgrade")?.toLowerCase() === "websocket";
  const requestProto = new URL(request.url).protocol === "https:" ? "https" : "http";

  if (isWebsocket) {
    if (normalized === "wss" || normalized === "https") return "wss";
    if (normalized === "ws" || normalized === "http") return "ws";
    return requestProto === "https" ? "wss" : "ws";
  }

  if (normalized === "https" || normalized === "wss") return "https";
  if (normalized === "http" || normalized === "ws") return "http";
  return requestProto;
}

function resolveForwardingContext(request: Request): {
  host: string;
  proto: ForwardedProto;
  forValue: string | null;
} {
  return {
    host: resolveOriginalRequestHost(request),
    proto: normalizeForwardedProto(undefined, request),
    forValue: resolveClientIp(request),
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

/**
 * Project deployments only persist one canonical root host in D1.
 *
 * Incoming public traffic may arrive as:
 * - the exact stored host
 * - `service__rootHost` when `ITERATE_INGRESS_ROUTING_TYPE=dunder-prefix`
 * - `service.rootHost` when `ITERATE_INGRESS_ROUTING_TYPE=subdomain-host`
 *
 * We derive those candidate roots before the SQL lookup so the query can stay
 * simple exact matching instead of carrying wildcard logic in D1.
 */
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

/**
 * The worker is the trust boundary for forwarded headers. We always discard
 * any inbound forwarding context and rebuild it from the actual request before
 * proxying upstream.
 */
export function createUpstreamHeaders(request: Request, targetUrl: URL): Headers {
  const headers = new Headers(request.headers);
  const forwardingContext = resolveForwardingContext(request);
  stripForwardingContextHeaders(headers);
  headers.set("host", targetUrl.host);
  headers.set("x-forwarded-host", forwardingContext.host);
  headers.set("x-forwarded-proto", forwardingContext.proto);
  if (forwardingContext.forValue) {
    headers.set("x-forwarded-for", forwardingContext.forValue);
    headers.set("x-real-ip", forwardingContext.forValue);
    headers.set("cf-connecting-ip", forwardingContext.forValue);
  }
  return headers;
}

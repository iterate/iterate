import { rootHostSchema, targetUrlSchema } from "@iterate-com/ingress-proxy-contract";

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

function resolveForwardingContext(request: Request): {
  host: string;
} {
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
 * any inbound forwarding context and rebuild only the fields we actually own
 * before proxying upstream.
 *
 * We intentionally do not set `X-Forwarded-For` or `X-Real-IP` here.
 *
 * What we confirmed:
 * - Cloudflare's documented downstream client IP header is `CF-Connecting-IP`
 * - Cloudflare treats classic proxy and visitor-context headers specially and
 *   may strip, overwrite, or re-add them in later pipeline stages
 * - in live tests against non-Cloudflare upstreams, `CF-Connecting-IP`
 *   survives, while `X-Forwarded-For`, `X-Real-IP`, and
 *   `X-Forwarded-Proto` did not reliably survive
 *
 * So downstream services should use `CF-Connecting-IP` for geolocation or
 * original-client-IP logic instead of relying on worker-authored proxy IP
 * headers.
 *
 * Sources:
 * - https://developers.cloudflare.com/fundamentals/reference/http-request-headers/
 * - https://developers.cloudflare.com/rules/transform/request-header-modification/
 */
export function createUpstreamHeaders(request: Request, targetUrl: URL): Headers {
  const headers = new Headers(request.headers);
  const forwardingContext = resolveForwardingContext(request);
  stripForwardingContextHeaders(headers);
  headers.set("host", targetUrl.host);
  headers.set("x-forwarded-host", forwardingContext.host);
  return headers;
}

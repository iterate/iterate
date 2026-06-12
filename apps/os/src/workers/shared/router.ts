/**
 * The ONE hostname-level routing decision for OS traffic.
 *
 * Deployed, this runs in the tiny ingress worker (workers/ingress.ts), which
 * owns every route and forwards whole requests over service bindings. In
 * local dev the browser talks straight to vite (the app worker), so the app
 * worker runs the same function first with its own service bindings — one
 * code path, no dev/prod fork. See docs/worker-topology.md.
 *
 * Lanes, in priority order (mirrors the old single-worker dispatch):
 *
 *  1. MCP host (config.mcp.baseUrl hostname)  → MCP worker
 *  2. Ingress-rule match (projects table, D1) → project-host worker
 *  3. Everything else                         → the app (caller handles)
 *
 * A matched ingress rule rides to the project worker on an internal header
 * so the lookup isn't repeated. The header is trustworthy because the
 * project worker has no routes of its own — it is reachable only via
 * service bindings from workers that just resolved the rule.
 */

import type { AppConfig } from "~/config.ts";
import {
  matchMcpRequestUrl,
  publicMcpRequestUrl,
} from "~/domains/inbound-mcp-server/mcp-url-routing.ts";
import { lookupIngressRule } from "~/ingress/lookup.ts";
import { ingressHostnameFromRequest, normalizeIngressHost } from "~/ingress/host-headers.ts";
import type { ExactHostIngressRule } from "~/ingress/types.ts";

/** Internal header carrying the resolved ingress rule across the service
 * binding hop. JSON: {@link ResolvedIngressHeader}. */
export const RESOLVED_INGRESS_HEADER = "x-iterate-resolved-ingress";

/** Set by the ingress worker when it has already classified the request
 * (value: the lane name). The app worker skips re-routing when present. */
export const ROUTED_LANE_HEADER = "x-iterate-routed-lane";

export type ResolvedIngressHeader = {
  requestHost: string;
  rule: ExactHostIngressRule;
};

type RouteTargets = {
  /** MCP worker service binding (handleMcpFetch lives there). */
  MCP?: Fetcher;
  /** Project worker service binding (project-host lane: itx connect + callable dispatch). */
  PROJECT_HOST?: Fetcher;
};

/**
 * Route a request to the MCP or project-host lane, or return null for the
 * app lane (the caller forwards to the app worker / falls through to the
 * local app pipeline).
 */
export async function routeOsRequest(input: {
  config: AppConfig;
  db: D1Database;
  request: Request;
  targets: RouteTargets;
}): Promise<Response | null> {
  const { config, request, targets } = input;

  // The same gate handleMcpFetch uses — covers both the dedicated MCP
  // hostname (config.mcp.baseUrl) and the localhost path-mounted endpoint
  // (/api/__mcp) used when no explicit MCP base URL is configured.
  const mcpMatch = matchMcpRequestUrl({
    appBaseUrl: config.baseUrl,
    mcpBaseUrl: config.mcp?.baseUrl,
    requestUrl: publicMcpRequestUrl(request),
  });
  if (mcpMatch) {
    if (!targets.MCP) return null; // no MCP lane wired (tests) — let the caller decide
    return await targets.MCP.fetch(request);
  }

  const requestHost = normalizeIngressHost(ingressHostnameFromRequest(request));

  // When baseUrl is not configured (dev tunnels, previews), the request
  // origin is the app's own URL — same fallback the app pipeline uses.
  const appHostname = new URL(config.baseUrl ?? request.url).hostname;

  const rule = await lookupIngressRule({
    appHostname,
    db: input.db,
    host: requestHost,
    projectHostnameBases: config.projectHostnameBases ?? [],
  });
  if (rule) {
    if (!targets.PROJECT_HOST) return null;
    const headers = new Headers(request.headers);
    headers.set(
      RESOLVED_INGRESS_HEADER,
      JSON.stringify({ requestHost, rule } satisfies ResolvedIngressHeader),
    );
    return await targets.PROJECT_HOST.fetch(new Request(request, { headers }));
  }

  return null;
}

/** Parse the resolved-rule header set by {@link routeOsRequest}; null when
 * the request arrived without one (direct invocation, tests). */
export function readResolvedIngressHeader(request: Request): ResolvedIngressHeader | null {
  const raw = request.headers.get(RESOLVED_INGRESS_HEADER);
  if (!raw) return null;
  return JSON.parse(raw) as ResolvedIngressHeader;
}

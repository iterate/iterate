/**
 * The ONE hostname-level routing decision for OS traffic.
 *
 * Deployed, this runs in the tiny ingress worker (workers/ingress.ts), which
 * owns every route and forwards whole requests over service bindings. In
 * local dev the browser talks straight to vite (the app worker), so the app
 * worker runs the same function first with its own service bindings — one
 * code path, no dev/prod fork. See docs/worker-topology.md.
 *
 * Lanes, in priority order:
 *
 *  1. Known OS hosts                          → app worker
 *  2. MCP host/path                           → MCP worker
 *  3. Project platform/custom host            → project-host worker
 *  4. Everything else                         → 404
 *
 * A matched project target rides to the project worker on an internal header
 * so the lookup isn't repeated. The header is trustworthy because the project
 * worker is reachable only through service bindings from workers that just
 * resolved the target.
 */

import type { AppConfig } from "~/config.ts";
import { matchMcpRequestUrl } from "~/domains/inbound-mcp-server/mcp-url-routing.ts";
import { normalizeIngressHost } from "~/ingress/host-headers.ts";
import { parseProjectPlatformHosts } from "~/ingress/project-platform-host-routing.ts";
import { eventDocsHostnameForAppBaseUrl } from "~/lib/event-docs-host.ts";
import { normalizeProjectHostnameBase } from "~/lib/project-host-routing.ts";

/** Internal header carrying the resolved project target across the service binding hop. */
export const RESOLVED_INGRESS_HEADER = "x-iterate-resolved-ingress";

/** Set by the ingress worker when it has already classified the request
 * (value: the lane name). The app worker skips re-routing when present. */
export const ROUTED_LANE_HEADER = "x-iterate-routed-lane";

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
  const { request, targets } = input;

  const decision = await decideIngressRoute({
    config: input.config,
    db: input.db,
    headers: request.headers,
    method: request.method,
    url: request.url,
  });

  if (decision.lane === "mcp") {
    if (!targets.MCP) return null; // no MCP lane wired (tests) — let the caller decide
    return await targets.MCP.fetch(request);
  }

  if (decision.lane === "project" || decision.lane === "itx") {
    if (!targets.PROJECT_HOST) return null;
    const headers = new Headers(request.headers);
    if ("headers" in decision && decision.headers) {
      for (const [name, value] of Object.entries(decision.headers)) headers.set(name, value);
    }
    headers.set(RESOLVED_INGRESS_HEADER, JSON.stringify(decision.resolved));
    return await targets.PROJECT_HOST.fetch(new Request(request, { headers }));
  }

  if (decision.lane === "notFound") return new Response("Not Found", { status: 404 });

  return null;
}

export async function decideIngressRoute(input: {
  config: {
    baseUrl?: string;
    mcp?: { baseUrl: string };
    projectHostnameBases?: readonly string[];
  };
  db: D1Database;
  headers?: HeadersInit;
  method: string;
  url: string;
}) {
  const headers = new Headers(input.headers);
  const publicUrl = new URL(input.url);
  const forwardedHost = headers.get("x-forwarded-host");
  const forwardedProto = headers.get("x-forwarded-proto")?.replace(/:$/, "");
  if (forwardedProto) publicUrl.protocol = `${forwardedProto}:`;
  if (forwardedHost) {
    publicUrl.host = forwardedHost;
    const trimmedForwardedHost = forwardedHost.trim();
    const hasPort = trimmedForwardedHost.startsWith("[")
      ? /\]:\d+$/.test(trimmedForwardedHost)
      : /:\d+$/.test(trimmedForwardedHost);
    if (!hasPort) publicUrl.port = "";
  }

  // The same gate handleMcpFetch uses — covers both the dedicated MCP
  // hostname (config.mcp.baseUrl) and the localhost path-mounted endpoint
  // (/api/__mcp) used when no explicit MCP base URL is configured.
  const mcpMatch = matchMcpRequestUrl({
    appBaseUrl: input.config.baseUrl,
    mcpBaseUrl: input.config.mcp?.baseUrl,
    requestUrl: publicUrl.toString(),
  });
  if (mcpMatch) return { lane: "mcp" } as const;

  const requestHost = normalizeIngressHost(
    headers.get("x-iterate-ingress-hostname") ??
      headers.get("x-forwarded-host")?.replace(/:\d+$/, "") ??
      new URL(input.url).hostname,
  );
  const appHostname = normalizeIngressHost(new URL(input.config.baseUrl ?? input.url).hostname);
  const eventDocsHostname = eventDocsHostnameForAppBaseUrl(input.config.baseUrl);
  if (
    requestHost === appHostname ||
    requestHost === eventDocsHostname ||
    isLoopbackAppHostAlias(requestHost, input.config.projectHostnameBases ?? [])
  ) {
    return { lane: "os" } as const;
  }

  const itx = parseItxCapabilityHost({
    bases: input.config.projectHostnameBases ?? [],
    host: requestHost,
  });
  if (itx) {
    const project = await lookupProject(input.db, itx.projectIdentifier);
    if (!project) return { lane: "notFound" } as const;
    return {
      lane: "itx",
      requestHost,
      resolved: {
        target: "itx",
        capability: itx.capability,
        projectId: project.id,
      },
    } as const;
  }

  const platformHosts = parseProjectPlatformHosts({
    bases: input.config.projectHostnameBases ?? [],
    host: requestHost,
  });
  for (const platformHost of platformHosts) {
    const project = await lookupProject(input.db, platformHost.projectIdentifier);
    if (!project) continue;
    return {
      lane: "project",
      ...(platformHost.appSlug ? { headers: { "x-iterate-app-slug": platformHost.appSlug } } : {}),
      requestHost,
      resolved: {
        target: "project",
        projectId: project.id,
        appSlug: platformHost.appSlug,
      },
    } as const;
  }

  const customHostnameProject = await lookupCustomHostnameProject(input.db, requestHost);
  if (customHostnameProject) {
    return {
      lane: "project",
      ...(customHostnameProject.appSlug
        ? { headers: { "x-iterate-app-slug": customHostnameProject.appSlug } }
        : {}),
      requestHost,
      resolved: {
        target: "project",
        projectId: customHostnameProject.id,
        appSlug: customHostnameProject.appSlug,
      },
    } as const;
  }

  return { lane: "notFound" } as const;
}

function isLoopbackAppHostAlias(requestHost: string, projectHostnameBases: readonly string[]) {
  return projectHostnameBases.some((rawBase) => {
    const base = normalizeIngressHost(normalizeProjectHostnameBase(rawBase));
    return requestHost === base && (base === "localhost" || base.endsWith(".localhost"));
  });
}

/** Parse the resolved-rule header set by {@link routeOsRequest}; null when
 * the request arrived without one (direct invocation, tests). */
export function readResolvedIngressHeader(request: Request) {
  const raw = request.headers.get(RESOLVED_INGRESS_HEADER);
  if (!raw) return null;
  return JSON.parse(raw) as
    | { target: "project"; projectId: string; appSlug?: string | null }
    | { target: "itx"; projectId: string; capability: string };
}

function parseItxCapabilityHost(input: { bases: readonly string[]; host: string }) {
  const host = normalizeIngressHost(input.host);
  for (const rawBase of input.bases) {
    const base = normalizeIngressHost(normalizeProjectHostnameBase(rawBase));
    if (host === base || !host.endsWith(`.${base}`)) continue;

    const prefix = host.slice(0, host.length - base.length - 1);
    if (prefix.includes(".")) continue;

    const parts = prefix.split("--");
    if (parts.length !== 2) continue;
    const [capability, projectIdentifier] = parts;
    if (!capability || !projectIdentifier) continue;
    return { capability, projectIdentifier };
  }
  return null;
}

async function lookupProject(db: D1Database, identifier: string) {
  return await db
    .prepare(`SELECT id, slug FROM projects WHERE slug = ? OR id = ? LIMIT 1`)
    .bind(identifier, identifier)
    .first<{ id: string; slug: string }>();
}

async function lookupCustomHostnameProject(db: D1Database, host: string) {
  const row = await db
    .prepare(
      `SELECT id, custom_hostname
       FROM projects
       WHERE custom_hostname IS NOT NULL
         AND custom_hostname != ''
         AND (custom_hostname = ? OR ? LIKE '%.' || custom_hostname)
       ORDER BY length(custom_hostname) DESC
       LIMIT 1`,
    )
    .bind(host, host)
    .first<{ id: string; custom_hostname: string | null }>();
  if (!row?.custom_hostname) return null;

  const customHostname = normalizeIngressHost(row.custom_hostname);
  if (host === customHostname) return { id: row.id, appSlug: null };
  if (!host.endsWith(`.${customHostname}`)) return null;

  const prefix = host.slice(0, host.length - customHostname.length - 1);
  if (!prefix || prefix.includes(".")) return null;
  return { id: row.id, appSlug: prefix };
}

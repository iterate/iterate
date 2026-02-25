import { and, eq, or, sql } from "drizzle-orm";
import { createMachineStub } from "@iterate-com/sandbox/providers/machine-stub";
import type { SandboxFetcher } from "@iterate-com/sandbox/providers/types";
import {
  isProjectIngressHostname,
  parseProjectIngressHostname,
  parseCustomDomainHostname,
  type IngressTarget,
  type ParsedIngressHostname,
} from "@iterate-com/shared/project-ingress";
import type { CloudflareEnv } from "../../env.ts";
import type { AuthSession } from "../auth/auth.ts";
import { getDb } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { logger } from "../tag-logger.ts";

const SANDBOX_INGRESS_PORT = 8080;
const DEFAULT_TARGET_PORT = 3000;
const TARGET_HOST_HEADER = "x-iterate-proxy-target-host";
export const PROJECT_INGRESS_PROXY_AUTH_BRIDGE_START_PATH =
  "/api/project-ingress-proxy-auth/bridge-start";
export const PROJECT_INGRESS_PROXY_AUTH_EXCHANGE_PATH = "/_/exchange-token";

const HOP_BY_HOP_HEADERS = [
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailers",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
];

const EXCLUDE_RESPONSE_HEADERS = ["transfer-encoding", "connection", "keep-alive"];

/**
 * Sentinel returned by handleCustomDomainRequest when the request is for a recognized
 * custom domain but needs to be handled by the control plane (Hono routes), not proxied.
 * The caller should fall through to `next()` instead of returning 404.
 */
export const FALL_THROUGH_TO_CONTROL_PLANE = Symbol.for("FALL_THROUGH_TO_CONTROL_PLANE");

function jsonError(status: number, error: string, details?: Record<string, unknown>): Response {
  return Response.json(details ? { error, details } : { error }, { status });
}

function parseHostnameFromHeader(rawHost: string | null): string | null {
  if (!rawHost) return null;
  const first = rawHost.split(",")[0]?.trim();
  if (!first) return null;
  if (first.startsWith("[")) {
    const endBracket = first.indexOf("]");
    if (endBracket === -1) return null;
    return first.slice(1, endBracket).toLowerCase();
  }
  const portSeparator = first.lastIndexOf(":");
  if (portSeparator !== -1 && first.indexOf(":") === portSeparator) {
    return first.slice(0, portSeparator).toLowerCase();
  }
  return first.toLowerCase();
}

export function getProjectIngressRequestHostname(request: Request): string {
  const forwardedHost = parseHostnameFromHeader(request.headers.get("x-forwarded-host"));
  if (forwardedHost) return forwardedHost;

  const hostHeader = parseHostnameFromHeader(request.headers.get("host"));
  if (hostHeader) return hostHeader;

  return new URL(request.url).hostname.toLowerCase();
}

/**
 * Check if a hostname should be handled as project ingress.
 * Checks both the standard PROJECT_INGRESS_DOMAIN and any custom domains in the DB.
 *
 * Returns the custom domain project if found (to avoid a duplicate DB query later),
 * `true` for standard ingress, or `false` if the hostname isn't ingress at all.
 */
export async function shouldHandleProjectIngressHostname(
  hostname: string,
  env: CloudflareEnv,
): Promise<typeof schema.project.$inferSelect | boolean> {
  if (isProjectIngressHostname(hostname, env.PROJECT_INGRESS_DOMAIN)) {
    return true;
  }

  // Short-circuit for the control plane's own hostname — never a custom domain
  const controlPlaneHostname = new URL(env.VITE_PUBLIC_URL).hostname.toLowerCase();
  if (hostname.toLowerCase() === controlPlaneHostname) {
    return false;
  }

  // Check if hostname matches any project's custom domain
  const customDomainProject = await findProjectByCustomDomainHostname(hostname);
  return customDomainProject ?? false;
}

/**
 * Find a project whose custom_domain matches the given hostname (or is a parent of it).
 *
 * Matches both exact (`templestein.com`) and subdomain (`4096.templestein.com`) hostnames
 * using a single SQL query instead of loading all custom domain projects.
 */
async function findProjectByCustomDomainHostname(
  hostname: string,
): Promise<typeof schema.project.$inferSelect | null> {
  const db = getDb();
  const normalizedHostname = hostname.toLowerCase();

  // hostname = custom_domain (exact) OR hostname LIKE '%.' || custom_domain (subdomain)
  // Order by domain length DESC so the longest (most specific) match wins.
  // e.g. `a.example.com` matches before `example.com` for hostname `4096.a.example.com`.
  const results = await db
    .select()
    .from(schema.project)
    .where(
      or(
        eq(schema.project.customDomain, normalizedHostname),
        sql`${normalizedHostname} LIKE '%.' || ${schema.project.customDomain}`,
      ),
    )
    .orderBy(sql`length(${schema.project.customDomain}) DESC`)
    .limit(1);

  return results[0] ?? null;
}

/**
 * Build the canonical hostname for a project ingress target.
 * E.g. `4096__my-proj.iterate.app` or `my-proj.iterate.app` (port 3000 default).
 */
export function buildCanonicalProjectIngressProxyHostname(params: {
  target: IngressTarget;
  projectIngressDomain: string;
}): string {
  const { target, projectIngressDomain } = params;
  const identifier = target.kind === "project" ? target.projectSlug : target.machineId;
  const hostToken =
    target.targetPort === DEFAULT_TARGET_PORT && !target.isPortExplicit
      ? identifier
      : `${target.targetPort}__${identifier}`;
  return `${hostToken}.${projectIngressDomain}`;
}

export function normalizeProjectIngressProxyRedirectPath(rawPath: string | undefined): string {
  if (!rawPath) return "/";
  try {
    const parsed = new URL(rawPath, "https://project-ingress-proxy.local");
    if (parsed.origin !== "https://project-ingress-proxy.local") return "/";
    const normalizedPath = `${parsed.pathname}${parsed.search}`;
    if (!normalizedPath.startsWith("/")) return "/";
    return normalizedPath;
  } catch {
    return "/";
  }
}

export function buildControlPlaneProjectIngressProxyLoginUrl(params: {
  controlPlanePublicUrl: string;
  projectIngressProxyHost: string;
  redirectPath: string;
}): URL {
  const controlPlaneBridgeStartUrl = buildControlPlaneProjectIngressProxyBridgeStartUrl(params);
  const controlPlaneLoginUrl = new URL("/login", params.controlPlanePublicUrl);
  controlPlaneLoginUrl.searchParams.set(
    "redirectUrl",
    `${controlPlaneBridgeStartUrl.pathname}${controlPlaneBridgeStartUrl.search}`,
  );
  return controlPlaneLoginUrl;
}

export function buildControlPlaneProjectIngressProxyBridgeStartUrl(params: {
  controlPlanePublicUrl: string;
  projectIngressProxyHost: string;
  redirectPath: string;
}): URL {
  const { controlPlanePublicUrl, projectIngressProxyHost, redirectPath } = params;
  const controlPlaneBridgeStartUrl = new URL(
    PROJECT_INGRESS_PROXY_AUTH_BRIDGE_START_PATH,
    controlPlanePublicUrl,
  );
  // Pass the full hostname for custom domains; extract subdomain for standard ingress
  controlPlaneBridgeStartUrl.searchParams.set("projectIngressProxyHost", projectIngressProxyHost);
  controlPlaneBridgeStartUrl.searchParams.set(
    "path",
    normalizeProjectIngressProxyRedirectPath(redirectPath),
  );
  return controlPlaneBridgeStartUrl;
}

function isAlwaysControlPlanePath(pathname: string): boolean {
  return pathname === PROJECT_INGRESS_PROXY_AUTH_EXCHANGE_PATH;
}

type ResolveMachineForIngressResult = {
  machine: typeof schema.machine.$inferSelect | null;
  projectFound?: boolean;
  accessDenied?: boolean;
  machineExists?: boolean;
  machineState?: typeof schema.machine.$inferSelect.state;
};

async function resolveMachineForIngress(
  target: IngressTarget,
  userId: string,
  isSystemAdmin: boolean,
): Promise<ResolveMachineForIngressResult> {
  const db = getDb();

  if (target.kind === "project") {
    const rows = await db
      .select({
        projectId: schema.project.id,
        membershipId: schema.organizationUserMembership.id,
      })
      .from(schema.project)
      .innerJoin(schema.organization, eq(schema.project.organizationId, schema.organization.id))
      .leftJoin(
        schema.organizationUserMembership,
        and(
          eq(schema.organizationUserMembership.organizationId, schema.organization.id),
          eq(schema.organizationUserMembership.userId, userId),
        ),
      )
      .where(eq(schema.project.slug, target.projectSlug))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return { machine: null, projectFound: false };
    }
    if (!row.membershipId && !isSystemAdmin) {
      return { machine: null, projectFound: true, accessDenied: true };
    }

    const machine = await db.query.machine.findFirst({
      where: and(eq(schema.machine.projectId, row.projectId), eq(schema.machine.state, "active")),
    });
    return { machine: machine ?? null, projectFound: true };
  }

  const rows = await db
    .select({
      machine: schema.machine,
      membershipId: schema.organizationUserMembership.id,
    })
    .from(schema.machine)
    .innerJoin(schema.project, eq(schema.machine.projectId, schema.project.id))
    .innerJoin(schema.organization, eq(schema.project.organizationId, schema.organization.id))
    .leftJoin(
      schema.organizationUserMembership,
      and(
        eq(schema.organizationUserMembership.organizationId, schema.organization.id),
        eq(schema.organizationUserMembership.userId, userId),
      ),
    )
    .where(eq(schema.machine.id, target.machineId))
    .limit(1);

  const row = rows[0];
  if (!row) return { machine: null, machineExists: false };
  if (!row.membershipId && !isSystemAdmin) {
    return {
      machine: null,
      accessDenied: true,
      machineExists: true,
      machineState: row.machine.state,
    };
  }

  if (
    row.machine.state !== "active" &&
    row.machine.state !== "detached" &&
    row.machine.state !== "starting"
  ) {
    return {
      machine: null,
      machineExists: true,
      machineState: row.machine.state,
    };
  }

  return {
    machine: row.machine,
    machineExists: true,
    machineState: row.machine.state,
  };
}

function filterProxyRequestHeaders(request: Request, targetHost: string): Headers {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) {
      headers.set(key, value);
    }
  });
  headers.set(TARGET_HOST_HEADER, targetHost);
  return headers;
}

function filterWebSocketHeaders(request: Request, targetHost: string): Headers {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.startsWith("sec-websocket-") ||
      lowerKey === "origin" ||
      lowerKey === "upgrade" ||
      lowerKey === "connection"
    ) {
      headers.set(key, value);
    }
  });
  headers.set(TARGET_HOST_HEADER, targetHost);
  return headers;
}

async function proxyWithFetcher(
  request: Request,
  pathWithQuery: string,
  fetcher: SandboxFetcher,
  targetHost: string,
): Promise<Response> {
  const isWebSocket = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
  if (isWebSocket) {
    const proxyRequest = new Request(new URL(pathWithQuery, request.url), {
      method: request.method,
      headers: filterWebSocketHeaders(request, targetHost),
    });
    return fetcher(proxyRequest);
  }

  const response = await fetcher(pathWithQuery, {
    method: request.method,
    headers: filterProxyRequestHeaders(request, targetHost),
    body: request.body,
    // @ts-expect-error - Cloudflare Workers support duplex streaming
    duplex: "half",
  });

  const responseHeaders = new Headers();
  response.headers.forEach((value, key) => {
    if (!EXCLUDE_RESPONSE_HEADERS.includes(key.toLowerCase())) {
      responseHeaders.append(key, value);
    }
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

function buildParseDetails(params: {
  hostname: string;
  projectIngressDomain: string;
  resolvedHost?: ParsedIngressHostname;
}): Record<string, unknown> {
  const labels = params.hostname.toLowerCase().split(".").filter(Boolean);
  const details: Record<string, unknown> = {
    hostname: params.hostname,
    hostnameLabels: labels,
    projectIngressDomain: params.projectIngressDomain,
  };

  if (params.resolvedHost) {
    if (params.resolvedHost.ok) {
      details.parsedTarget =
        params.resolvedHost.target.kind === "project"
          ? {
              kind: "project",
              projectSlug: params.resolvedHost.target.projectSlug,
              targetPort: params.resolvedHost.target.targetPort,
              rootDomain: params.resolvedHost.rootDomain,
            }
          : {
              kind: "machine",
              machineId: params.resolvedHost.target.machineId,
              targetPort: params.resolvedHost.target.targetPort,
              rootDomain: params.resolvedHost.rootDomain,
            };
    } else {
      details.parsedTargetError = params.resolvedHost.error;
    }
  }

  return details;
}

/**
 * @param cachedCustomDomainProject - Pre-resolved custom domain project from
 *   `shouldHandleProjectIngressHostname`. Avoids a duplicate DB lookup.
 */
export async function handleProjectIngressRequest(
  request: Request,
  env: CloudflareEnv,
  session: AuthSession,
  cachedCustomDomainProject?: typeof schema.project.$inferSelect,
): Promise<Response | null> {
  const url = new URL(request.url);
  const requestHostname = getProjectIngressRequestHostname(request);
  const projectIngressDomain = env.PROJECT_INGRESS_DOMAIN;

  if (!projectIngressDomain) {
    logger.error("[project-ingress] PROJECT_INGRESS_DOMAIN is empty");
    return jsonError(500, "ingress_not_configured", { hostname: requestHostname });
  }

  // Check if this is a custom domain request
  if (!isProjectIngressHostname(requestHostname, projectIngressDomain)) {
    const customDomainResponse = await handleCustomDomainRequest(
      request,
      url,
      requestHostname,
      env,
      session,
      cachedCustomDomainProject,
    );
    // Sentinel: custom domain recognized but needs control plane handling (e.g. /_/exchange-token)
    if (customDomainResponse === FALL_THROUGH_TO_CONTROL_PLANE) return null;
    if (customDomainResponse) return customDomainResponse;

    return jsonError(
      404,
      "not_found",
      buildParseDetails({
        hostname: requestHostname,
        projectIngressDomain,
      }),
    );
  }

  const resolvedHost = parseProjectIngressHostname(requestHostname);
  if (!resolvedHost.ok) {
    return jsonError(
      resolvedHost.error === "invalid_port"
        ? 400
        : resolvedHost.error === "invalid_project_slug"
          ? 400
          : 400,
      resolvedHost.error,
      buildParseDetails({ hostname: requestHostname, projectIngressDomain, resolvedHost }),
    );
  }

  // Build canonical hostname — always use the PROJECT_INGRESS_DOMAIN
  const canonicalHostname = buildCanonicalProjectIngressProxyHostname({
    target: resolvedHost.target,
    projectIngressDomain,
  });
  if (requestHostname !== canonicalHostname) {
    const redirectUrl = new URL(url.toString());
    redirectUrl.host = canonicalHostname;
    return Response.redirect(redirectUrl.toString(), 301);
  }

  if (isAlwaysControlPlanePath(url.pathname)) {
    return null;
  }

  if (!session) {
    const controlPlaneBridgeStartUrl = buildControlPlaneProjectIngressProxyBridgeStartUrl({
      controlPlanePublicUrl: env.VITE_PUBLIC_URL,
      projectIngressProxyHost: canonicalHostname,
      redirectPath: `${url.pathname}${url.search}`,
    });
    return Response.redirect(controlPlaneBridgeStartUrl.toString(), 302);
  }

  const parseDetails = buildParseDetails({
    hostname: requestHostname,
    projectIngressDomain,
    resolvedHost,
  });

  const resolvedMachine = await resolveMachineForIngress(
    resolvedHost.target,
    session.user.id,
    session.user.role === "admin",
  );
  if (resolvedHost.target.kind === "project" && resolvedMachine.projectFound === false) {
    return jsonError(404, "project_not_found", {
      ...parseDetails,
      resolution: { projectFound: false },
    });
  }
  if (resolvedMachine.accessDenied) {
    return jsonError(403, "forbidden", {
      ...parseDetails,
      resolution: {
        projectFound: resolvedMachine.projectFound ?? null,
        machineExists: resolvedMachine.machineExists ?? null,
        machineState: resolvedMachine.machineState ?? null,
      },
    });
  }
  const machine = resolvedMachine.machine;
  if (!machine) {
    if (resolvedHost.target.kind === "machine" && resolvedMachine.machineExists) {
      return jsonError(409, "machine_not_routable", {
        ...parseDetails,
        resolution: {
          machineExists: true,
          machineState: resolvedMachine.machineState ?? null,
          routableStates: ["starting", "active", "detached"],
        },
      });
    }

    return jsonError(404, "machine_not_found", {
      ...parseDetails,
      resolution: {
        projectFound: resolvedMachine.projectFound ?? null,
        machineExists: resolvedMachine.machineExists ?? false,
        machineState: resolvedMachine.machineState ?? null,
      },
    });
  }
  if (!machine.externalId) {
    return jsonError(503, "machine_unavailable", {
      ...parseDetails,
      resolution: {
        machineId: machine.id,
        machineState: machine.state,
        missing: "externalId",
      },
    });
  }

  try {
    const runtime = await createMachineStub({
      type: machine.type,
      env,
      externalId: machine.externalId,
      metadata: (machine.metadata as Record<string, unknown>) ?? {},
    });
    const fetcher = await runtime.getFetcher(SANDBOX_INGRESS_PORT);
    const pathWithQuery = `${url.pathname}${url.search}`;
    return await proxyWithFetcher(request, pathWithQuery, fetcher, requestHostname);
  } catch (error) {
    logger.error("[project-ingress] Failed to proxy request", error, {
      host: requestHostname,
      rootDomain: resolvedHost.rootDomain,
      machine: { id: machine.id },
      machineType: machine.type,
    });
    return jsonError(502, "proxy_error", {
      ...parseDetails,
      resolution: {
        machineId: machine.id,
        machineState: machine.state,
        machineType: machine.type,
      },
      proxyError: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Handle a request for a custom domain hostname.
 * Returns a Response if handled, null if not a known custom domain,
 * or FALL_THROUGH_TO_CONTROL_PLANE if the request needs control plane handling.
 */
async function handleCustomDomainRequest(
  request: Request,
  url: URL,
  requestHostname: string,
  env: CloudflareEnv,
  session: AuthSession,
  cachedProject?: typeof schema.project.$inferSelect,
): Promise<Response | typeof FALL_THROUGH_TO_CONTROL_PLANE | null> {
  // Use the pre-resolved project from shouldHandleProjectIngressHostname, or look it up
  const project = cachedProject ?? (await findProjectByCustomDomainHostname(requestHostname));
  if (!project || !project.customDomain) return null;

  // Parse the custom domain hostname into a target
  const parsed = parseCustomDomainHostname(requestHostname, project.customDomain);
  if (!parsed.ok) {
    return jsonError(400, parsed.error, { hostname: requestHostname });
  }

  // Control plane paths (e.g. /_/exchange-token) are handled by the Hono routes in worker.ts.
  // Return a sentinel to tell the caller to fall through to Hono instead of returning 404.
  if (isAlwaysControlPlanePath(url.pathname)) {
    return FALL_THROUGH_TO_CONTROL_PLANE;
  }

  // Auth bridge — redirect to control plane login if no session
  if (!session) {
    const controlPlaneBridgeStartUrl = buildControlPlaneProjectIngressProxyBridgeStartUrl({
      controlPlanePublicUrl: env.VITE_PUBLIC_URL,
      projectIngressProxyHost: requestHostname,
      redirectPath: `${url.pathname}${url.search}`,
    });
    return Response.redirect(controlPlaneBridgeStartUrl.toString(), 302);
  }

  const { target } = parsed;

  // Resolve machine based on target type
  let machine: typeof schema.machine.$inferSelect | null = null;

  if (target.kind === "project") {
    // Find the active machine for this project
    const db = getDb();
    // Verify access
    const membershipRows = await db
      .select({ membershipId: schema.organizationUserMembership.id })
      .from(schema.organizationUserMembership)
      .where(
        and(
          eq(schema.organizationUserMembership.organizationId, project.organizationId),
          eq(schema.organizationUserMembership.userId, session.user.id),
        ),
      )
      .limit(1);

    if (membershipRows.length === 0 && session.user.role !== "admin") {
      return jsonError(403, "forbidden", { hostname: requestHostname });
    }

    machine =
      (await db.query.machine.findFirst({
        where: and(eq(schema.machine.projectId, project.id), eq(schema.machine.state, "active")),
      })) ?? null;
  } else {
    // Machine target — resolve directly
    const resolved = await resolveMachineForIngress(
      { ...target, isPortExplicit: true },
      session.user.id,
      session.user.role === "admin",
    );
    machine = resolved.machine;
    if (resolved.accessDenied) {
      return jsonError(403, "forbidden", { hostname: requestHostname });
    }
  }

  if (!machine) {
    return jsonError(404, "machine_not_found", { hostname: requestHostname });
  }
  if (!machine.externalId) {
    return jsonError(503, "machine_unavailable", { hostname: requestHostname });
  }

  try {
    const runtime = await createMachineStub({
      type: machine.type,
      env,
      externalId: machine.externalId,
      metadata: (machine.metadata as Record<string, unknown>) ?? {},
    });
    const fetcher = await runtime.getFetcher(SANDBOX_INGRESS_PORT);
    const pathWithQuery = `${url.pathname}${url.search}`;
    // Custom domain hostnames (e.g. "opencode.templestein.com") don't use the __
    // separator that the sandbox proxy expects. Send "localhost:<port>" so the
    // sandbox proxy routes to the correct upstream port.
    const targetHost = `localhost:${target.targetPort}`;
    return await proxyWithFetcher(request, pathWithQuery, fetcher, targetHost);
  } catch (error) {
    logger.error("[project-ingress] Failed to proxy custom domain request", error, {
      host: requestHostname,
      customDomain: project.customDomain,
      machine: { id: machine.id },
      machineType: machine.type,
    });
    return jsonError(502, "proxy_error", {
      hostname: requestHostname,
      proxyError: error instanceof Error ? error.message : String(error),
    });
  }
}

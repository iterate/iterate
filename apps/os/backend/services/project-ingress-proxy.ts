import { and, eq } from "drizzle-orm";
import { createMachineStub } from "@iterate-com/sandbox/providers/machine-stub";
import type { SandboxFetcher } from "@iterate-com/sandbox/providers/types";
import { minimatch } from "minimatch";
import type { CloudflareEnv } from "../../env.ts";
import type { AuthSession } from "../auth/auth.ts";
import { getDb } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { logger } from "../tag-logger.ts";

const DEFAULT_TARGET_PORT = 3000;
const SANDBOX_INGRESS_PORT = 8080;
const MAX_PORT = 65_535;
const TARGET_HOST_HEADER = "x-iterate-proxy-target-host";
const PROJECT_SLUG_PATTERN = /^[a-z0-9-]+$/;
const RESERVED_PROJECT_SLUGS = new Set(["prj", "org"]);

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

type IngressRouteTarget =
  | { kind: "project"; projectSlug: string; targetPort: number }
  | { kind: "machine"; machineId: string; targetPort: number };

type ResolveHostnameResult =
  | { ok: true; target: IngressRouteTarget; rootDomain: string }
  | { ok: false; error: "invalid_hostname" | "invalid_port" | "invalid_project_slug" };

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

export function parseProjectIngressProxyHostMatchers(raw: string): string[] {
  const values = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(values)];
}

export function getProjectIngressProxyHostMatchers(env: CloudflareEnv): string[] {
  return parseProjectIngressProxyHostMatchers(env.PROJECT_INGRESS_PROXY_HOST_MATCHERS);
}

export function shouldHandleProjectIngressHostname(
  hostname: string,
  hostMatchers: string[],
): boolean {
  return getMatchingProjectIngressHostMatcher(hostname, hostMatchers) !== null;
}

function getMatchingProjectIngressHostMatcher(
  hostname: string,
  hostMatchers: string[],
): string | null {
  const normalizedHostname = hostname.toLowerCase();
  for (const matcher of hostMatchers) {
    if (
      minimatch(normalizedHostname, matcher, {
        nocase: true,
        dot: true,
        noext: false,
        noglobstar: false,
      })
    ) {
      return matcher;
    }
  }
  return null;
}

function buildHostnameParseDetails(params: {
  hostname: string;
  hostMatchers: string[];
  matchedHostMatcher: string | null;
  resolvedHost?: ResolveHostnameResult;
}): Record<string, unknown> {
  const labels = params.hostname.toLowerCase().split(".").filter(Boolean);
  const details: Record<string, unknown> = {
    hostname: params.hostname,
    hostnameLabels: labels,
    hostMatchers: params.hostMatchers,
    matchedHostMatcher: params.matchedHostMatcher,
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

function parseTargetPort(rawPort: string): number | null {
  if (!/^\d+$/.test(rawPort)) return null;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) return null;
  return port;
}

function parseTargetToken(token: string): { identifier: string; targetPort: number } | null {
  if (!token) return null;

  const separatorIndex = token.indexOf("__");
  if (separatorIndex === -1) {
    return { identifier: token, targetPort: DEFAULT_TARGET_PORT };
  }

  if (separatorIndex === 0) return null;

  const rawPort = token.slice(0, separatorIndex);
  const identifier = token.slice(separatorIndex + 2);
  if (!identifier) return null;

  const targetPort = parseTargetPort(rawPort);
  if (!targetPort) return null;

  return { identifier, targetPort };
}

function isValidProjectSlug(slug: string): boolean {
  return (
    PROJECT_SLUG_PATTERN.test(slug) &&
    /[a-z]/.test(slug) &&
    slug.length <= 50 &&
    !RESERVED_PROJECT_SLUGS.has(slug)
  );
}

export function resolveIngressHostname(hostname: string): ResolveHostnameResult {
  const normalizedHostname = hostname.toLowerCase();
  const labels = normalizedHostname.split(".").filter(Boolean);
  if (labels.length < 3) return { ok: false, error: "invalid_hostname" };

  const parsed = parseTargetToken(labels[0] ?? "");
  if (!parsed) return { ok: false, error: "invalid_port" };
  if (parsed.identifier.startsWith("mach_")) {
    return {
      ok: true,
      target: {
        kind: "machine",
        machineId: parsed.identifier,
        targetPort: parsed.targetPort,
      },
      rootDomain: labels.slice(1).join("."),
    };
  }

  if (!isValidProjectSlug(parsed.identifier)) {
    return { ok: false, error: "invalid_project_slug" };
  }

  return {
    ok: true,
    target: {
      kind: "project",
      projectSlug: parsed.identifier,
      targetPort: parsed.targetPort,
    },
    rootDomain: labels.slice(1).join("."),
  };
}

type ResolveMachineForIngressResult = {
  machine: typeof schema.machine.$inferSelect | null;
  projectFound?: boolean;
  accessDenied?: boolean;
  machineExists?: boolean;
  machineState?: typeof schema.machine.$inferSelect.state;
};

async function resolveMachineForIngress(
  target: IngressRouteTarget,
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
    return fetcher(request, {
      method: request.method,
      headers: filterWebSocketHeaders(request, targetHost),
    });
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
      responseHeaders.set(key, value);
    }
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

export async function handleProjectIngressRequest(
  request: Request,
  env: CloudflareEnv,
  session: AuthSession,
): Promise<Response> {
  const url = new URL(request.url);
  const requestHostname = getProjectIngressRequestHostname(request);
  const hostMatchers = getProjectIngressProxyHostMatchers(env);
  if (hostMatchers.length === 0) {
    logger.error("[project-ingress] PROJECT_INGRESS_PROXY_HOST_MATCHERS is empty");
    return jsonError(500, "ingress_not_configured", { hostname: requestHostname, hostMatchers });
  }

  const matchedHostMatcher = getMatchingProjectIngressHostMatcher(requestHostname, hostMatchers);
  if (!matchedHostMatcher) {
    return jsonError(
      404,
      "not_found",
      buildHostnameParseDetails({
        hostname: requestHostname,
        hostMatchers,
        matchedHostMatcher,
      }),
    );
  }

  if (!session) {
    return jsonError(
      401,
      "unauthorized",
      buildHostnameParseDetails({
        hostname: requestHostname,
        hostMatchers,
        matchedHostMatcher,
      }),
    );
  }

  const resolvedHost = resolveIngressHostname(requestHostname);
  if (!resolvedHost.ok) {
    if (resolvedHost.error === "invalid_port") {
      return jsonError(
        400,
        "invalid_port",
        buildHostnameParseDetails({
          hostname: requestHostname,
          hostMatchers,
          matchedHostMatcher,
          resolvedHost,
        }),
      );
    }
    if (resolvedHost.error === "invalid_project_slug") {
      return jsonError(
        400,
        "invalid_project_slug",
        buildHostnameParseDetails({
          hostname: requestHostname,
          hostMatchers,
          matchedHostMatcher,
          resolvedHost,
        }),
      );
    }
    return jsonError(
      400,
      "invalid_hostname",
      buildHostnameParseDetails({
        hostname: requestHostname,
        hostMatchers,
        matchedHostMatcher,
        resolvedHost,
      }),
    );
  }

  const parseDetails = buildHostnameParseDetails({
    hostname: requestHostname,
    hostMatchers,
    matchedHostMatcher,
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
    logger.error("[project-ingress] Failed to proxy request", {
      host: requestHostname,
      rootDomain: resolvedHost.rootDomain,
      machineId: machine.id,
      machineType: machine.type,
      error: error instanceof Error ? error.message : String(error),
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

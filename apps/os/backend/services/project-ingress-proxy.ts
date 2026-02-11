import { and, eq, or } from "drizzle-orm";
import { createMachineStub } from "@iterate-com/sandbox/providers/machine-stub";
import type { SandboxFetcher } from "@iterate-com/sandbox/providers/types";
import { minimatch } from "minimatch";
import type { CloudflareEnv } from "../../env.ts";
import { getDb } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { logger } from "../tag-logger.ts";

const DEFAULT_TARGET_PORT = 3000;
const SANDBOX_INGRESS_PORT = 8080;
const MAX_PORT = 65_535;
const TARGET_HOST_HEADER = "x-iterate-proxy-target-host";

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
  | { ok: false; error: "invalid_hostname" | "invalid_port" };

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
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
  const normalizedHostname = hostname.toLowerCase();
  return hostMatchers.some((matcher) =>
    minimatch(normalizedHostname, matcher, {
      nocase: true,
      dot: true,
      noext: false,
      noglobstar: false,
    }),
  );
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

function resolveIngressHostname(hostname: string): ResolveHostnameResult {
  const normalizedHostname = hostname.toLowerCase();
  const labels = normalizedHostname.split(".").filter(Boolean);
  if (labels.length < 3) return { ok: false, error: "invalid_hostname" };

  if (labels[1] === "machines") {
    if (labels.length < 4) return { ok: false, error: "invalid_hostname" };
    const parsed = parseTargetToken(labels[0] ?? "");
    if (!parsed) return { ok: false, error: "invalid_port" };
    if (!parsed.identifier.startsWith("mach_")) return { ok: false, error: "invalid_hostname" };

    return {
      ok: true,
      target: {
        kind: "machine",
        machineId: parsed.identifier,
        targetPort: parsed.targetPort,
      },
      rootDomain: labels.slice(2).join("."),
    };
  }

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

async function resolveMachineForIngress(target: IngressRouteTarget) {
  const db = getDb();

  if (target.kind === "project") {
    const rows = await db
      .select({ machine: schema.machine })
      .from(schema.machine)
      .innerJoin(schema.project, eq(schema.machine.projectId, schema.project.id))
      .where(and(eq(schema.project.slug, target.projectSlug), eq(schema.machine.state, "active")))
      .limit(1);

    return rows[0]?.machine ?? null;
  }

  return db.query.machine.findFirst({
    where: and(
      eq(schema.machine.id, target.machineId),
      or(eq(schema.machine.state, "active"), eq(schema.machine.state, "detached")),
    ),
  });
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
    return fetcher(pathWithQuery, {
      method: request.method,
      headers: filterWebSocketHeaders(request, targetHost),
      body: request.body,
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
): Promise<Response> {
  const url = new URL(request.url);
  const hostMatchers = getProjectIngressProxyHostMatchers(env);
  if (hostMatchers.length === 0) {
    logger.error("[project-ingress] PROJECT_INGRESS_PROXY_HOST_MATCHERS is empty");
    return jsonError(500, "ingress_not_configured");
  }

  if (!shouldHandleProjectIngressHostname(url.hostname, hostMatchers)) {
    return jsonError(404, "not_found");
  }

  const resolvedHost = resolveIngressHostname(url.hostname);
  if (!resolvedHost.ok) {
    if (resolvedHost.error === "invalid_port") return jsonError(400, "invalid_port");
    return jsonError(400, "invalid_hostname");
  }

  const machine = await resolveMachineForIngress(resolvedHost.target);
  if (!machine) return jsonError(404, "machine_not_found");
  if (!machine.externalId) return jsonError(503, "machine_unavailable");

  try {
    const runtime = await createMachineStub({
      type: machine.type,
      env,
      externalId: machine.externalId,
      metadata: (machine.metadata as Record<string, unknown>) ?? {},
    });
    const fetcher = await runtime.getFetcher(SANDBOX_INGRESS_PORT);
    const pathWithQuery = `${url.pathname}${url.search}`;
    return await proxyWithFetcher(request, pathWithQuery, fetcher, url.hostname);
  } catch (error) {
    logger.error("[project-ingress] Failed to proxy request", {
      host: url.hostname,
      rootDomain: resolvedHost.rootDomain,
      machineId: machine.id,
      machineType: machine.type,
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonError(502, "proxy_error");
  }
}

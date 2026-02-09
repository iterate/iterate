/**
 * Machine proxy route.
 *
 * Provides authenticated proxy access to services running inside machines
 * (Daytona sandboxes, local Docker containers, etc).
 *
 * Route: /org/:org/proj/:project/:machine/proxy/:port/*
 */
import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { Daytona } from "@daytonaio/sdk";
import { createMachineRuntime } from "@iterate-com/sandbox/providers/machine-runtime";
import type { SandboxFetcher } from "@iterate-com/sandbox/providers/types";
import type { CloudflareEnv } from "../../env.ts";
import type { Variables } from "../types.ts";
import * as schema from "../db/schema.ts";
import { logger } from "../tag-logger.ts";
import type { DB } from "../db/client.ts";
import { rewriteHTMLUrls } from "../utils/proxy-html-rewriter.ts";
import { getPreviewToken, refreshPreviewToken } from "../integrations/daytona/daytona.ts";

export const machineProxyApp = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

/**
 * Single query to resolve org -> project -> machine and check membership.
 * Returns machine data if user has access, null otherwise.
 */
async function resolveProxyAccess(
  db: DB,
  orgSlug: string,
  projectSlug: string,
  machineId: string,
  userId: string,
  isSystemAdmin: boolean,
): Promise<{
  machine: typeof schema.machine.$inferSelect;
} | null> {
  const result = await db
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
    .where(
      and(
        eq(schema.organization.slug, orgSlug),
        eq(schema.project.slug, projectSlug),
        eq(schema.machine.id, machineId),
      ),
    )
    .limit(1);

  const row = result[0];
  if (!row) return null;

  // Check access: must be member OR system admin
  if (!row.membershipId && !isSystemAdmin) return null;

  return { machine: row.machine };
}

/**
 * Proxy route: /org/:org/proj/:project/:machine/proxy/:port/*
 */
machineProxyApp.all("/org/:org/proj/:project/:machine/proxy/:port/*", async (c) => {
  // 1. Require authentication
  if (!c.var.session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { org, project, machine, port } = c.req.param();
  const db = c.var.db;
  const proxyBasePath = `/org/${org}/proj/${project}/${machine}/proxy/${port}`;

  // 2. Validate port (must be valid TCP port number)
  const portNum = parseInt(port, 10);
  if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
    return c.json({ error: "Invalid port" }, 400);
  }

  // 3. Single query to resolve machine + check access
  const access = await resolveProxyAccess(
    db,
    org,
    project,
    machine,
    c.var.session.user.id,
    c.var.session.user.role === "admin",
  );

  if (!access) {
    return c.json({ error: "Not found or forbidden" }, 404);
  }

  const machineRecord = access.machine;
  const externalId = machineRecord.externalId;
  const metadata = machineRecord.metadata as Record<string, unknown>;

  // 4. Build target URL using provider
  const url = new URL(c.req.url);
  const pathMatch = url.pathname.match(new RegExp(`/proxy/${port}(/.*)$`));
  const path = pathMatch?.[1] ?? "/";

  const runtime = await createMachineRuntime({
    type: machineRecord.type,
    env: c.env,
    externalId,
    metadata,
  });
  const baseUrl = await runtime.getBaseUrl(portNum);
  const targetUrl = `${baseUrl}${path}`;
  const fullTargetUrl = url.search ? `${targetUrl}${url.search}` : targetUrl;
  const pathWithQuery = url.search ? `${path}${url.search}` : path;

  // For Daytona, we need special auth handling
  if (machineRecord.type === "daytona") {
    if (!/^[a-zA-Z0-9-]+$/.test(externalId)) {
      logger.error("Invalid sandbox ID format", {
        sandboxId: externalId,
        machineId: machineRecord.id,
      });
      return c.json({ error: "Invalid sandbox configuration" }, 500);
    }

    const daytona = new Daytona({ apiKey: c.env.DAYTONA_API_KEY });
    const deps = { db, daytona };

    let token: string;
    try {
      token = await getPreviewToken(deps, machineRecord.id, externalId, portNum);
    } catch (err) {
      logger.error("Failed to get preview token", err);
      return c.json({ error: "Failed to get preview token" }, 500);
    }

    let response = await proxyDaytona(c.req.raw, fullTargetUrl, token);

    // Handle 401 - lazy refresh
    if (response.status === 401) {
      logger.info("Received 401 from Daytona, refreshing token", {
        sandboxId: externalId,
        port: portNum,
      });
      try {
        token = await refreshPreviewToken(deps, machineRecord.id, externalId, portNum);
        response = await proxyDaytona(c.req.raw, fullTargetUrl, token);
      } catch (err) {
        logger.error("Failed to refresh token after 401", err);
        return c.json({ error: "Authentication failed" }, 401);
      }
    }

    return rewriteHTMLUrls(response, proxyBasePath);
  }

  // For non-Daytona machines (docker, fly, local), simple proxy without auth
  const fetcher = await runtime.getFetcher(portNum);
  const response = await proxyWithFetcher(c.req.raw, pathWithQuery, fetcher);
  return rewriteHTMLUrls(response, proxyBasePath);
});

// ============================================================================
// Proxy helpers
// ============================================================================

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
 * Proxy request to Daytona with auth headers
 */
async function proxyDaytona(request: Request, targetUrl: string, token: string): Promise<Response> {
  const url = new URL(targetUrl);

  if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    return proxyDaytonaWebSocket(request, targetUrl, token);
  }

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) {
      headers.set(key, value);
    }
  });

  headers.set("X-Daytona-Preview-Token", token);
  headers.set("X-Daytona-Skip-Preview-Warning", "true");
  headers.set("Host", url.host);

  const response = await fetch(targetUrl, {
    method: request.method,
    headers,
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

async function proxyDaytonaWebSocket(
  request: Request,
  targetUrl: string,
  token: string,
): Promise<Response> {
  const url = new URL(targetUrl);
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

  headers.set("X-Daytona-Preview-Token", token);
  headers.set("X-Daytona-Skip-Preview-Warning", "true");
  headers.set("Host", url.host);

  return fetch(targetUrl, {
    method: request.method,
    headers,
    body: request.body,
  });
}

/**
 * Proxy request via provider-specific fetcher (no auth needed)
 */
async function proxyWithFetcher(
  request: Request,
  targetPath: string,
  fetcher: SandboxFetcher,
): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    return proxyWebSocketWithFetcher(request, targetPath, fetcher);
  }

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) {
      headers.set(key, value);
    }
  });

  const response = await fetcher(targetPath, {
    method: request.method,
    headers,
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

async function proxyWebSocketWithFetcher(
  request: Request,
  targetPath: string,
  fetcher: SandboxFetcher,
): Promise<Response> {
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

  return fetcher(targetPath, {
    method: request.method,
    headers,
    body: request.body,
  });
}

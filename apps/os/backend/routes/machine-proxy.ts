/**
 * Machine proxy route.
 *
 * Provides authenticated proxy access to services running inside machines
 * (Daytona sandboxes, local Docker containers, etc).
 *
 * Route: /org/:org/proj/:project/:machine/proxy/:port/*
 */
import { Hono } from "hono";
import { eq, and, isNull } from "drizzle-orm";
import { Daytona } from "@daytonaio/sdk";
import type { CloudflareEnv } from "../../env.ts";
import type { Variables } from "../worker.ts";
import * as schema from "../db/schema.ts";
import { logger } from "../tag-logger.ts";
import type { DB } from "../db/client.ts";
import { rewriteHTMLUrls } from "../utils/proxy-html-rewriter.ts";
import { getPreviewToken, refreshPreviewToken } from "../integrations/daytona/daytona.ts";
import { DAEMON_DEFINITIONS } from "../daemons.ts";
import { hashToken } from "../trpc/routers/access-token.ts";

export const machineProxyApp = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

/**
 * Resolve machine without checking membership (for access token auth).
 * Returns machine data if found, null otherwise.
 */
async function resolveMachineOnly(
  db: DB,
  orgSlug: string,
  projectSlug: string,
  machineId: string,
): Promise<{
  machine: typeof schema.machine.$inferSelect;
} | null> {
  const result = await db
    .select({
      machine: schema.machine,
    })
    .from(schema.machine)
    .innerJoin(schema.project, eq(schema.machine.projectId, schema.project.id))
    .innerJoin(schema.organization, eq(schema.project.organizationId, schema.organization.id))
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

  return { machine: row.machine };
}

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
 * Validate HTTP Basic Auth with project access token.
 * Returns machine record if valid token, null otherwise.
 */
async function validateAccessTokenAuth(
  db: DB,
  authHeader: string | undefined,
  orgSlug: string,
  projectSlug: string,
  machineId: string,
): Promise<{ machine: typeof schema.machine.$inferSelect } | null> {
  if (!authHeader?.startsWith("Basic ")) {
    return null;
  }

  // Decode base64 credentials (format: "username:password" where username is empty)
  const base64Credentials = authHeader.slice(6);
  let credentials: string;
  try {
    credentials = atob(base64Credentials);
  } catch {
    return null;
  }

  // Split on first colon only (password may contain colons)
  const colonIndex = credentials.indexOf(":");
  if (colonIndex === -1) {
    return null;
  }

  const token = credentials.slice(colonIndex + 1);
  if (!token?.startsWith("pat_")) {
    return null;
  }

  // Hash the token and look it up
  const tokenHash = await hashToken(token);

  // Find token and verify it's valid and belongs to the right project
  const tokenRecord = await db
    .select({
      token: schema.projectAccessToken,
      project: schema.project,
      organization: schema.organization,
    })
    .from(schema.projectAccessToken)
    .innerJoin(schema.project, eq(schema.projectAccessToken.projectId, schema.project.id))
    .innerJoin(schema.organization, eq(schema.project.organizationId, schema.organization.id))
    .where(
      and(
        eq(schema.projectAccessToken.tokenHash, tokenHash),
        isNull(schema.projectAccessToken.revokedAt),
        eq(schema.project.slug, projectSlug),
        eq(schema.organization.slug, orgSlug),
      ),
    )
    .limit(1)
    .then((rows) => rows[0]);

  if (!tokenRecord) {
    return null;
  }

  // Update lastUsedAt (fire and forget)
  db.update(schema.projectAccessToken)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.projectAccessToken.id, tokenRecord.token.id))
    .then(() => {})
    .catch(() => {});

  // Get machine record (no membership check needed for token auth)
  return resolveMachineOnly(db, orgSlug, projectSlug, machineId);
}

/**
 * Proxy route: /org/:org/proj/:project/:machine/proxy/:port/*
 */
machineProxyApp.all("/org/:org/proj/:project/:machine/proxy/:port/*", async (c) => {
  const { org, project, machine, port } = c.req.param();
  const db = c.var.db;
  const proxyBasePath = `/org/${org}/proj/${project}/${machine}/proxy/${port}`;

  // 1. Validate port (must be valid TCP port number)
  const portNum = parseInt(port, 10);
  if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
    return c.json({ error: "Invalid port" }, 400);
  }

  let machineRecord: typeof schema.machine.$inferSelect;

  // 2. Try HTTP Basic Auth with project access token first
  const authHeader = c.req.header("Authorization");
  const tokenAuth = await validateAccessTokenAuth(db, authHeader, org, project, machine);

  if (tokenAuth) {
    // Valid access token - use machine from token auth
    machineRecord = tokenAuth.machine;
  } else {
    // 3. Fall back to session-based authentication
    if (!c.var.session) {
      return c.json({ error: "Unauthorized" }, 401);
    }

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

    machineRecord = access.machine;
  }

  const externalId = machineRecord.externalId;

  // 4. Build target URL based on machine type
  const url = new URL(c.req.url);
  const pathMatch = url.pathname.match(new RegExp(`/proxy/${port}(/.*)$`));
  const path = pathMatch?.[1] ?? "/";

  if (machineRecord.type === "local-docker") {
    // For local-docker, proxy to localhost with the container's mapped port
    const meta = machineRecord.metadata as { ports?: Record<string, number>; port?: number };

    let hostPort: number | undefined;

    // New format: ports is a map of daemonId/terminal -> hostPort
    if (meta?.ports) {
      // Find which daemon this internal port corresponds to
      const daemon = DAEMON_DEFINITIONS.find((d) => d.internalPort === portNum);
      if (daemon && meta.ports[daemon.id]) {
        hostPort = meta.ports[daemon.id];
      } else if (portNum === 22222 && meta.ports["terminal"]) {
        // Terminal port
        hostPort = meta.ports["terminal"];
      }
    } else if (meta?.port) {
      // Legacy fallback: single port field
      hostPort = portNum === 22222 ? meta.port + 1 : meta.port;
    }

    if (!hostPort) {
      return c.json({ error: "Local docker machine has no port mapping for port " + portNum }, 500);
    }
    const targetUrl = `http://localhost:${hostPort}${path}`;
    const fullTargetUrl = url.search ? `${targetUrl}${url.search}` : targetUrl;

    const response = await proxyLocalDocker(c.req.raw, fullTargetUrl);
    return rewriteHTMLUrls(response, proxyBasePath);
  }

  if (machineRecord.type === "local") {
    // For local machines, proxy to configured host:port
    const metadata = machineRecord.metadata as { host?: string; port?: number };
    if (!metadata.host || !metadata.port) {
      return c.json({ error: "Local machine missing host or port configuration" }, 500);
    }
    const targetUrl = `http://${metadata.host}:${metadata.port}${path}`;
    const fullTargetUrl = url.search ? `${targetUrl}${url.search}` : targetUrl;

    const response = await proxyLocalDocker(c.req.raw, fullTargetUrl);
    return rewriteHTMLUrls(response, proxyBasePath);
  }

  // Daytona machine handling
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

  const targetUrl = `https://${portNum}-${externalId}.proxy.daytona.works${path}`;
  const fullTargetUrl = url.search ? `${targetUrl}${url.search}` : targetUrl;

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
 * Proxy request to local Docker container (no auth needed)
 */
async function proxyLocalDocker(request: Request, targetUrl: string): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    return proxyLocalDockerWebSocket(request, targetUrl);
  }

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) {
      headers.set(key, value);
    }
  });

  const url = new URL(targetUrl);
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

async function proxyLocalDockerWebSocket(request: Request, targetUrl: string): Promise<Response> {
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

  headers.set("Host", url.host);

  return fetch(targetUrl, {
    method: request.method,
    headers,
    body: request.body,
  });
}

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { Daytona } from "@daytonaio/sdk";
import type { CloudflareEnv } from "../../../env.ts";
import type { Variables } from "../../worker.ts";
import * as schema from "../../db/schema.ts";
import { logger } from "../../tag-logger.ts";
import type { DB } from "../../db/client.ts";

type TokenDeps = {
  db: DB;
  daytona: Daytona;
};

/**
 * Get cached preview token or fetch fresh from Daytona SDK
 */
export async function getPreviewToken(
  deps: TokenDeps,
  machineId: string,
  sandboxId: string,
  port: number,
): Promise<string> {
  const cached = await deps.db.query.daytonaPreviewToken.findFirst({
    where: and(
      eq(schema.daytonaPreviewToken.machineId, machineId),
      eq(schema.daytonaPreviewToken.port, String(port)),
    ),
  });

  if (cached) {
    return cached.token;
  }

  return refreshPreviewToken(deps, machineId, sandboxId, port);
}

/**
 * Fetch fresh token from Daytona SDK and cache it
 */
export async function refreshPreviewToken(
  deps: TokenDeps,
  machineId: string,
  sandboxId: string,
  port: number,
): Promise<string> {
  const sandbox = await deps.daytona.get(sandboxId);
  const previewInfo = await sandbox.getPreviewLink(port);

  await deps.db
    .insert(schema.daytonaPreviewToken)
    .values({
      machineId,
      port: String(port),
      token: previewInfo.token,
    })
    .onConflictDoUpdate({
      target: [schema.daytonaPreviewToken.machineId, schema.daytonaPreviewToken.port],
      set: {
        token: previewInfo.token,
        updatedAt: new Date(),
      },
    });

  return previewInfo.token;
}

export const daytonaProxyApp = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

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
  // Single query with JOINs to get machine + verify access
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
daytonaProxyApp.all("/org/:org/proj/:project/:machine/proxy/:port/*", async (c) => {
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

  // 4. Build target URL based on machine type
  const url = new URL(c.req.url);
  const pathMatch = url.pathname.match(new RegExp(`/proxy/${port}(/.*)$`));
  const path = pathMatch?.[1] ?? "/";

  if (machineRecord.type === "local-docker") {
    // For local-docker, proxy to localhost with the container's mapped port
    const hostPort = (machineRecord.metadata as { port?: number })?.port;
    if (!hostPort) {
      return c.json({ error: "Local docker machine has no port mapping" }, 500);
    }
    // Use localhost since the container's port is bound to the host
    const targetUrl = `http://localhost:${hostPort}${path}`;
    const fullTargetUrl = url.search ? `${targetUrl}${url.search}` : targetUrl;

    const response = await proxyLocalDocker(c.req.raw, fullTargetUrl);
    return rewriteBaseTag(response, proxyBasePath);
  }

  // Daytona machine handling
  // Validate sandboxId format (should be alphanumeric with dashes from Daytona)
  if (!/^[a-zA-Z0-9-]+$/.test(externalId)) {
    logger.error("Invalid sandbox ID format", {
      sandboxId: externalId,
      machineId: machineRecord.id,
    });
    return c.json({ error: "Invalid sandbox configuration" }, 500);
  }

  // Get preview token
  const daytona = new Daytona({ apiKey: c.env.DAYTONA_API_KEY });
  const deps: TokenDeps = { db, daytona };

  let token: string;
  try {
    token = await getPreviewToken(deps, machineRecord.id, externalId, portNum);
  } catch (err) {
    logger.error("Failed to get preview token", err);
    return c.json({ error: "Failed to get preview token" }, 500);
  }

  const targetUrl = `https://${portNum}-${externalId}.proxy.daytona.works${path}`;
  const fullTargetUrl = url.search ? `${targetUrl}${url.search}` : targetUrl;

  // Proxy the request
  let response = await proxyRequest(c.req.raw, fullTargetUrl, token);

  // Handle 401 - lazy refresh
  if (response.status === 401) {
    logger.info("Received 401 from Daytona, refreshing token", {
      sandboxId: externalId,
      port: portNum,
    });
    try {
      token = await refreshPreviewToken(deps, machineRecord.id, externalId, portNum);
      response = await proxyRequest(c.req.raw, fullTargetUrl, token);
    } catch (err) {
      logger.error("Failed to refresh token after 401", err);
      return c.json({ error: "Authentication failed" }, 401);
    }
  }

  return rewriteBaseTag(response, proxyBasePath);
});

/**
 * Proxy a request to Daytona with proper headers
 */
async function proxyRequest(request: Request, targetUrl: string, token: string): Promise<Response> {
  const url = new URL(targetUrl);

  // Check for WebSocket upgrade
  const upgradeHeader = request.headers.get("Upgrade");
  if (upgradeHeader?.toLowerCase() === "websocket") {
    return proxyWebSocket(request, targetUrl, token);
  }

  // Clone headers, removing hop-by-hop headers (per RFC 2616)
  const headers = new Headers();
  const hopByHopHeaders = [
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

  request.headers.forEach((value, key) => {
    if (!hopByHopHeaders.includes(key.toLowerCase())) {
      headers.set(key, value);
    }
  });

  // Set Daytona auth headers
  headers.set("X-Daytona-Preview-Token", token);
  headers.set("X-Daytona-Skip-Preview-Warning", "true");
  headers.set("Host", url.host);

  // Proxy the request
  const response = await fetch(targetUrl, {
    method: request.method,
    headers,
    body: request.body,
    // @ts-expect-error - Cloudflare Workers support duplex streaming
    duplex: "half",
  });

  // Clone response headers, preserving streaming
  const responseHeaders = new Headers();
  const excludeResponseHeaders = ["transfer-encoding", "connection", "keep-alive"];

  response.headers.forEach((value, key) => {
    if (!excludeResponseHeaders.includes(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

/**
 * Proxy WebSocket connections using fetch (Cloudflare Workers approach)
 */
async function proxyWebSocket(
  request: Request,
  targetUrl: string,
  token: string,
): Promise<Response> {
  const url = new URL(targetUrl);

  // Build headers for the upstream WebSocket connection
  const headers = new Headers();

  // Forward relevant headers from the original request
  request.headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    // Forward WebSocket-specific headers and origin
    if (
      lowerKey.startsWith("sec-websocket-") ||
      lowerKey === "origin" ||
      lowerKey === "upgrade" ||
      lowerKey === "connection"
    ) {
      headers.set(key, value);
    }
  });

  // Set Daytona auth headers
  headers.set("X-Daytona-Preview-Token", token);
  headers.set("X-Daytona-Skip-Preview-Warning", "true");
  headers.set("Host", url.host);

  // Use fetch with upgrade header - Cloudflare Workers handles WebSocket upgrade
  return fetch(targetUrl, {
    method: request.method,
    headers,
    body: request.body,
  });
}

/**
 * Proxy a request to local docker container (no auth needed)
 */
async function proxyLocalDocker(request: Request, targetUrl: string): Promise<Response> {
  const upgradeHeader = request.headers.get("Upgrade");
  if (upgradeHeader?.toLowerCase() === "websocket") {
    return proxyLocalDockerWebSocket(request, targetUrl);
  }

  const headers = new Headers();
  const hopByHopHeaders = [
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

  request.headers.forEach((value, key) => {
    if (!hopByHopHeaders.includes(key.toLowerCase())) {
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
  const excludeResponseHeaders = ["transfer-encoding", "connection", "keep-alive"];

  response.headers.forEach((value, key) => {
    if (!excludeResponseHeaders.includes(key.toLowerCase())) {
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

/**
 * Rewrite the <base> tag in HTML responses to use the proxy base path.
 * Uses simple string replacement for maximum performance.
 * The daemon app uses relative URLs with base: "./" in Vite config,
 * so we just need to update the base href.
 */
async function rewriteBaseTag(response: Response, proxyBasePath: string): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) {
    return response;
  }

  const html = await response.text();

  // Replace <base href="/"> or <base href="/" /> with proxy base path
  // This handles the daemon's existing <base href="/" /> tag
  const rewritten = html.replace(
    /<base\s+href=["']\/["']\s*\/?>/i,
    `<base href="${proxyBasePath}/">`,
  );

  return new Response(rewritten, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

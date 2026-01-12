import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { Daytona } from "@daytonaio/sdk";
import type { CloudflareEnv } from "../../../env.ts";
import type { Variables } from "../../worker.ts";
import * as schema from "../../db/schema.ts";
import { encrypt, decrypt } from "../../utils/encryption.ts";
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
    return decrypt(cached.encryptedToken);
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

  const encryptedToken = await encrypt(previewInfo.token);

  await deps.db
    .insert(schema.daytonaPreviewToken)
    .values({
      machineId,
      port: String(port),
      encryptedToken,
    })
    .onConflictDoUpdate({
      target: [schema.daytonaPreviewToken.machineId, schema.daytonaPreviewToken.port],
      set: {
        encryptedToken,
        updatedAt: new Date(),
      },
    });

  return previewInfo.token;
}

export const daytonaProxyApp = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

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

  // 3. Resolve organization
  const organization = await db.query.organization.findFirst({
    where: eq(schema.organization.slug, org),
  });
  if (!organization) {
    return c.json({ error: "Organization not found" }, 404);
  }

  // 4. Check user membership (allow if member OR system admin)
  // Note: user.role === "admin" refers to system-wide admin from better-auth's admin plugin,
  // not the organization-level role in organizationUserMembership
  const membership = await db.query.organizationUserMembership.findFirst({
    where: and(
      eq(schema.organizationUserMembership.organizationId, organization.id),
      eq(schema.organizationUserMembership.userId, c.var.session.user.id),
    ),
  });

  if (!membership && c.var.session.user.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }

  // 5. Resolve project
  const proj = await db.query.project.findFirst({
    where: and(
      eq(schema.project.organizationId, organization.id),
      eq(schema.project.slug, project),
    ),
  });
  if (!proj) {
    return c.json({ error: "Project not found" }, 404);
  }

  // 6. Resolve machine (machine param is the full TypeID like mach_abc123xyz)
  const machineRecord = await db.query.machine.findFirst({
    where: and(eq(schema.machine.id, machine), eq(schema.machine.projectId, proj.id)),
  });
  if (!machineRecord) {
    return c.json({ error: "Machine not found" }, 404);
  }

  const externalId = machineRecord.externalId;

  // 7. Build target URL based on machine type
  const url = new URL(c.req.url);
  const pathMatch = url.pathname.match(new RegExp(`/proxy/${port}(/.*)$`));
  const path = pathMatch?.[1] ?? "/";

  if (machineRecord.type === "local-docker") {
    // For local-docker, proxy to localhost with the container's mapped port
    const hostPort = (machineRecord.metadata as { port?: number })?.port;
    if (!hostPort) {
      return c.json({ error: "Local docker machine has no port mapping" }, 500);
    }
    // Use localhost since local-docker machines only work in local dev
    const targetUrl = `http://localhost:${hostPort}${path}`;
    const fullTargetUrl = url.search ? `${targetUrl}${url.search}` : targetUrl;

    const response = await proxyLocalDocker(c.req.raw, fullTargetUrl);
    return await rewriteHTMLUrls(response, proxyBasePath);
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

  return await rewriteHTMLUrls(response, proxyBasePath);
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
 * Rewrite HTML responses to work behind the proxy.
 * Strategy: Override window.location so client-side JS sees the stripped path.
 * The proxy strips the prefix when forwarding, so the backend sees "/" paths.
 * We just need to make the frontend think it's at "/" too.
 */
async function rewriteHTMLUrls(response: Response, proxyBasePath: string): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) {
    return response;
  }

  let html = await response.text();

  // Replace absolute /assets/ paths with the proxy base path
  html = html.replace(/(["'(])\/assets\//g, `$1${proxyBasePath}/assets/`);
  html = html.replace(/(["'(])\/logo\.svg/g, `$1${proxyBasePath}/logo.svg`);
  html = html.replace(/(["'(])\/favicon/g, `$1${proxyBasePath}/favicon`);

  // Inject location override script at the very start of <head>
  // This MUST run before any other scripts to fool the router
  const script = `<script>
(function() {
  var proxyBase = ${JSON.stringify(proxyBasePath)};
  var realLocation = window.location;
  
  // Override location.pathname to strip the proxy base
  var locationProxy = new Proxy(realLocation, {
    get: function(target, prop) {
      if (prop === 'pathname') {
        var path = target.pathname;
        return path.startsWith(proxyBase) ? (path.slice(proxyBase.length) || '/') : path;
      }
      if (prop === 'href') {
        var url = new URL(target.href);
        if (url.pathname.startsWith(proxyBase)) url.pathname = url.pathname.slice(proxyBase.length) || '/';
        return url.toString();
      }
      if (prop === 'toString') return function() { return locationProxy.href; };
      var value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  
  try { Object.defineProperty(window, 'location', { get: function() { return locationProxy; }, configurable: true }); } catch(e) {}
  
  // Override history to add proxy base back when navigating
  var pushState = history.pushState.bind(history);
  var replaceState = history.replaceState.bind(history);
  function addBase(url) { return url && typeof url === 'string' && url.startsWith('/') && !url.startsWith(proxyBase) ? proxyBase + url : url; }
  history.pushState = function(s,t,u) { return pushState(s,t,addBase(u)); };
  history.replaceState = function(s,t,u) { return replaceState(s,t,addBase(u)); };
  
  // Override fetch to add proxy base
  var origFetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string' && input.startsWith('/') && !input.startsWith(proxyBase)) input = proxyBase + input;
    return origFetch.call(this, input, init);
  };
  
  // Override WebSocket to add proxy base
  var WS = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    if (typeof url === 'string') {
      try {
        var parsed = new URL(url, realLocation.origin);
        if (!parsed.pathname.startsWith(proxyBase)) { parsed.pathname = proxyBase + parsed.pathname; url = parsed.toString(); }
      } catch(e) {
        if (url.startsWith('/') && !url.startsWith(proxyBase)) url = (realLocation.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + realLocation.host + proxyBase + url;
      }
    }
    return new WS(url, protocols);
  };
  window.WebSocket.prototype = WS.prototype;
  window.WebSocket.CONNECTING = 0; window.WebSocket.OPEN = 1; window.WebSocket.CLOSING = 2; window.WebSocket.CLOSED = 3;
  window.__PROXY_BASE_PATH__ = proxyBase;
})();
</script><base href="${proxyBasePath}/">`;

  html = html.replace(/<head([^>]*)>/i, `<head$1>${script}`);

  return new Response(html, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

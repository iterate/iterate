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
    const targetUrl = `http://host.docker.internal:${hostPort}${path}`;
    const fullTargetUrl = url.search ? `${targetUrl}${url.search}` : targetUrl;

    const response = await proxyLocalDocker(c.req.raw, fullTargetUrl);
    return rewriteHTMLUrls(response, proxyBasePath);
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

  return rewriteHTMLUrls(response, proxyBasePath);
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
 * Rewrite absolute URLs in HTML responses to include the proxy base path.
 * This fixes issues where proxied pages reference assets with absolute paths
 * (e.g., /xterm.js) that would otherwise resolve to the wrong domain.
 *
 * Also injects a <base> tag and WebSocket interceptor to handle JavaScript-constructed URLs.
 */
function rewriteHTMLUrls(response: Response, proxyBasePath: string): Response {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) {
    return response;
  }

  class URLRewriter {
    private attr: string;
    constructor(attr: string) {
      this.attr = attr;
    }

    element(element: Element) {
      const value = element.getAttribute(this.attr);
      if (value && value.startsWith("/") && !value.startsWith("//")) {
        element.setAttribute(this.attr, `${proxyBasePath}${value}`);
      }
    }
  }

  class HeadInjector {
    element(element: Element) {
      // Inject a <base> tag so relative URLs resolve correctly
      element.prepend(`<base href="${proxyBasePath}/">`, { html: true });
      // Inject a WebSocket interceptor to rewrite WebSocket URLs
      // This handles cases where JS constructs WebSocket URLs with absolute paths
      element.append(
        `<script>
(function() {
  const proxyBase = ${JSON.stringify(proxyBasePath)};
  const OriginalWebSocket = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    let newUrl = url;
    if (typeof url === 'string') {
      try {
        const parsed = new URL(url, window.location.origin);
        // If the WebSocket path doesn't start with the proxy base, prepend it
        if (!parsed.pathname.startsWith(proxyBase)) {
          parsed.pathname = proxyBase + parsed.pathname;
          newUrl = parsed.toString();
        }
      } catch (e) {
        // If URL parsing fails, try simple string manipulation
        if (url.startsWith('/') && !url.startsWith('//') && !url.startsWith(proxyBase)) {
          const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
          newUrl = protocol + '//' + window.location.host + proxyBase + url;
        }
      }
    }
    return new OriginalWebSocket(newUrl, protocols);
  };
  window.WebSocket.prototype = OriginalWebSocket.prototype;
  window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  window.WebSocket.OPEN = OriginalWebSocket.OPEN;
  window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
  window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;
})();
</script>`,
        { html: true },
      );
    }
  }

  class InlineScriptRewriter {
    private chunks: string[] = [];

    text(text: Text) {
      this.chunks.push(text.text);
      if (text.lastInTextNode) {
        const content = this.chunks.join("");
        // Rewrite dynamic import() calls with absolute paths
        // Matches: import('/path') or import("/path")
        const rewritten = content.replace(
          /\bimport\s*\(\s*(['"])(\/)(?!\/)/g,
          `import($1${proxyBasePath}$2`,
        );
        if (rewritten !== content) {
          text.replace(rewritten, { html: false });
        }
        this.chunks = [];
      } else {
        text.remove();
      }
    }
  }

  return new HTMLRewriter()
    .on("head", new HeadInjector())
    .on("script[src]", new URLRewriter("src"))
    .on("script:not([src])", new InlineScriptRewriter())
    .on("link[href]", new URLRewriter("href"))
    .on("img[src]", new URLRewriter("src"))
    .on("a[href]", new URLRewriter("href"))
    .on("form[action]", new URLRewriter("action"))
    .on("source[src]", new URLRewriter("src"))
    .on("video[src]", new URLRewriter("src"))
    .on("audio[src]", new URLRewriter("src"))
    .on("iframe[src]", new URLRewriter("src"))
    .transform(response);
}

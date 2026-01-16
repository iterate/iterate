/**
 * Egress Proxy Route
 *
 * Receives proxied requests from sandbox mitmproxy instances and forwards
 * them to their original destinations.
 *
 * This worker handles:
 * - Authentication of proxy requests
 * - Token injection for specific hosts (OpenAI, Anthropic, etc.)
 * - Forwarding requests to their original destinations
 * - Observability/logging of sandbox outbound traffic
 *
 * Headers from mitmproxy addon:
 * - X-Iterate-Original-URL: The original request URL
 * - X-Iterate-Original-Host: The original host
 * - X-Iterate-Original-Method: The original HTTP method
 * - X-Iterate-API-Key: API key for authentication
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { CloudflareEnv } from "../../env.ts";
import type { Variables } from "../worker.ts";
import { logger } from "../tag-logger.ts";
import { parseTokenIdFromApiKey } from "../trpc/routers/machine.ts";
import * as schema from "../db/schema.ts";
import { decrypt } from "../utils/encryption.ts";
import type { DB } from "../db/client.ts";

export const egressProxyApp = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

// Headers to strip from forwarded requests (hop-by-hop + our custom headers)
const STRIP_REQUEST_HEADERS = [
  "x-iterate-original-url",
  "x-iterate-original-host",
  "x-iterate-original-method",
  "x-iterate-api-key",
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

// Headers to strip from responses
const STRIP_RESPONSE_HEADERS = ["transfer-encoding", "connection", "keep-alive"];

// Hosts where we inject API tokens
// Maps host pattern to { headerName, envVarName }
// Note: Only include env vars that exist in CloudflareEnv
const TOKEN_INJECTION_HOSTS: Record<
  string,
  { headerName: string; envVarName: keyof CloudflareEnv }
> = {
  "api.openai.com": { headerName: "Authorization", envVarName: "OPENAI_API_KEY" },
  "api.anthropic.com": { headerName: "x-api-key", envVarName: "ANTHROPIC_API_KEY" },
  // TODO: Add OPENROUTER_API_KEY to CloudflareEnv when needed
  // "openrouter.ai": { headerName: "Authorization", envVarName: "OPENROUTER_API_KEY" },
};

/**
 * Main egress proxy endpoint.
 * Receives requests from mitmproxy and forwards to original destination.
 */
egressProxyApp.all("/api/egress-proxy", async (c) => {
  // Extract original request info from headers
  const originalURL = c.req.header("X-Iterate-Original-URL");
  const originalHost = c.req.header("X-Iterate-Original-Host");
  const originalMethod = c.req.header("X-Iterate-Original-Method") || c.req.method;
  const apiKey = c.req.header("X-Iterate-API-Key");

  // Validate required headers
  if (!originalURL) {
    logger.warn("Egress proxy request missing X-Iterate-Original-URL");
    return c.json({ error: "Missing X-Iterate-Original-URL header" }, 400);
  }

  // Authenticate the request
  const db = c.get("db");
  if (!apiKey || !(await validateApiKey(db, apiKey))) {
    logger.warn("Egress proxy request with invalid API key", { originalURL });
    return c.json({ error: "Invalid or missing API key" }, 401);
  }

  logger.info("Egress proxy forwarding", {
    method: originalMethod,
    url: originalURL,
    host: originalHost,
  });

  try {
    // Build headers for the forwarded request
    const forwardHeaders = new Headers();
    c.req.raw.headers.forEach((value, key) => {
      if (!STRIP_REQUEST_HEADERS.includes(key.toLowerCase())) {
        forwardHeaders.set(key, value);
      }
    });

    // Set the correct Host header for the destination
    if (originalHost) {
      forwardHeaders.set("Host", originalHost);
    }

    // Inject API tokens for specific hosts
    if (originalHost) {
      const tokenConfig = getTokenConfigForHost(originalHost);
      if (tokenConfig) {
        const token = c.env[tokenConfig.envVarName] as string | undefined;
        if (token) {
          // For Authorization header, add "Bearer " prefix if not already present
          const headerValue =
            tokenConfig.headerName.toLowerCase() === "authorization" ? `Bearer ${token}` : token;

          // Only inject if not already present
          if (!forwardHeaders.has(tokenConfig.headerName)) {
            forwardHeaders.set(tokenConfig.headerName, headerValue);
            logger.info("Egress proxy injected token", {
              host: originalHost,
              header: tokenConfig.headerName,
            });
          }
        } else {
          logger.warn("Egress proxy: no token configured for host", {
            host: originalHost,
            envVar: tokenConfig.envVarName,
          });
        }
      }
    }

    // Forward the request to the original destination
    const response = await fetch(originalURL, {
      method: originalMethod,
      headers: forwardHeaders,
      body: hasRequestBody(originalMethod) ? c.req.raw.body : undefined,
      // @ts-expect-error - Cloudflare Workers support duplex streaming
      duplex: "half",
    });

    // Build response headers
    const responseHeaders = new Headers();
    response.headers.forEach((value, key) => {
      if (!STRIP_RESPONSE_HEADERS.includes(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    });

    logger.info("Egress proxy response", {
      url: originalURL,
      status: response.status,
    });

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    logger.error("Egress proxy error", {
      url: originalURL,
      error: err instanceof Error ? err.message : String(err),
    });

    return c.json(
      {
        error: "Failed to forward request",
        details: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }
});

/**
 * Get token injection config for a host.
 */
function getTokenConfigForHost(
  host: string,
): { headerName: string; envVarName: keyof CloudflareEnv } | null {
  for (const [pattern, config] of Object.entries(TOKEN_INJECTION_HOSTS)) {
    if (host.includes(pattern)) {
      return config;
    }
  }
  return null;
}

/**
 * Check if the HTTP method typically has a request body.
 */
function hasRequestBody(method: string): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
}

/**
 * Validate the API key against the database.
 * API key format: pak_<tokenId>_<randomHex>
 */
async function validateApiKey(db: DB, apiKey: string): Promise<boolean> {
  // For development/testing, accept "test-key"
  if (import.meta.env.DEV && apiKey === "test-key") {
    return true;
  }

  // Parse the token ID from the API key
  const tokenId = parseTokenIdFromApiKey(apiKey);
  if (!tokenId) {
    logger.warn("Invalid API key format", { apiKey: apiKey.slice(0, 20) + "..." });
    return false;
  }

  // Look up the token in the database
  const accessToken = await db.query.projectAccessToken.findFirst({
    where: eq(schema.projectAccessToken.id, tokenId),
  });

  if (!accessToken) {
    logger.warn("Access token not found", { tokenId });
    return false;
  }

  if (accessToken.revokedAt) {
    logger.warn("Access token revoked", { tokenId });
    return false;
  }

  // Decrypt the stored token and compare with the provided API key
  const storedToken = await decrypt(accessToken.encryptedToken);
  if (apiKey !== storedToken) {
    logger.warn("Invalid API key for token", { tokenId });
    return false;
  }

  // Update last used timestamp in background (fire and forget)
  db.update(schema.projectAccessToken)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.projectAccessToken.id, tokenId))
    .catch(() => {});

  return true;
}

/**
 * Egress Proxy Route
 *
 * Receives proxied requests from sandbox mitmproxy instances and forwards
 * them to their original destinations.
 *
 * This worker handles:
 * - Authentication of proxy requests
 * - Secret injection via `getIterateSecret({...})` magic string (in headers and path)
 * - Token injection for hosts matching egress rules in the secret table
 * - Automatic OAuth token refresh on 401 responses
 * - Rich error messages for connector secrets with connect/reauth URLs
 * - Forwarding requests to their original destinations
 * - Observability/logging of sandbox outbound traffic
 *
 * Headers from mitmproxy addon:
 * - X-Iterate-Original-URL: The original request URL
 * - X-Iterate-Original-Host: The original host
 * - X-Iterate-Original-Method: The original HTTP method
 * - X-Iterate-API-Key: API key for authentication
 *
 * Magic string format (can appear in headers or path):
 *   getIterateSecret({secretKey: "openai_api_key", machineId: "mach_xxx", userId: "usr_xxx"})
 */

import { Hono } from "hono";
import { eq, and, isNull, or } from "drizzle-orm";
import JSON5 from "json5";
import jsonata from "jsonata";
import { logger } from "../tag-logger.ts";
import * as schema from "../db/schema.ts";
import { decrypt } from "../utils/encryption.ts";
import type { DB } from "../db/client.ts";
import { getConnectorForUrl, getFullReauthUrl } from "../services/connectors.ts";
import { attemptSecretRefresh, type RefreshContext } from "../services/oauth-refresh.ts";
import { env, waitUntil, type CloudflareEnv } from "../../env.ts";
import type { Variables } from "../types.ts";
import { parseTokenIdFromApiKey } from "./api-key-utils.ts";

export const egressProxyApp = new Hono<{
  Bindings: CloudflareEnv;
  Variables: Variables;
}>();

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

// Magic string pattern: getIterateSecret({secretKey: "...", machineId?: "...", userId?: "..."})
export const MAGIC_STRING_PATTERN = /getIterateSecret\(\s*\{([^}]+)\}\s*\)/g;

// Error types for secret resolution
export type SecretError = {
  code: "NOT_FOUND" | "EXPIRED" | "REFRESH_FAILED";
  message: string;
  connectUrl?: string;
  reauthUrl?: string;
};

export type SecretResult =
  | { ok: true; value: string; secretId: string; isConnector: boolean }
  | { ok: false; error: SecretError };

// Context type including URL for connector detection
export type EgressContext = {
  organizationId?: string;
  projectId?: string;
  userId?: string;
  orgSlug?: string;
  projectSlug?: string;
  originalUrl: string;
};

/**
 * Parse the magic string arguments using JSON5.
 * JSON5 allows unquoted keys and single-quoted strings.
 * Returns { secretKey, machineId?, userId? } or null if invalid.
 */
export function parseMagicString(
  match: string,
): { secretKey: string; machineId?: string; userId?: string } | null {
  // Extract the object part: {...}
  const objectMatch = match.match(/\{[^}]+\}/);
  if (!objectMatch) return null;

  try {
    const parsed = JSON5.parse(objectMatch[0]) as {
      secretKey?: string;
      machineId?: string;
      userId?: string;
    };
    if (!parsed.secretKey) return null;
    return {
      secretKey: parsed.secretKey,
      machineId: parsed.machineId,
      userId: parsed.userId,
    };
  } catch {
    return null;
  }
}

/**
 * Context object passed to JSONata egress rule expressions.
 * The expression can reference url.hostname, url.pathname, etc.
 */
export type EgressRuleContext = {
  url: {
    hostname: string;
    pathname: string;
    href: string;
    protocol: string;
    port: string;
  };
  headers: Record<string, string>;
};

/**
 * Evaluate a JSONata egress proxy rule against a URL and headers.
 * Returns true if the rule matches (allows the request), false otherwise.
 *
 * Example rules:
 * - `url.hostname = 'api.openai.com'` - exact hostname match
 * - `$contains(url.hostname, 'googleapis.com')` - contains match
 * - `url.hostname = 'api.openai.com' or url.hostname = 'api.anthropic.com'` - OR
 */
export async function matchesEgressRule(
  urlString: string,
  expression: string,
  headers?: Record<string, string>,
): Promise<boolean> {
  try {
    const url = new URL(urlString.startsWith("http") ? urlString : `https://${urlString}`);
    const context: EgressRuleContext = {
      url: {
        hostname: url.hostname,
        pathname: url.pathname,
        href: url.href,
        protocol: url.protocol,
        port: url.port,
      },
      headers: headers ?? {},
    };
    const expr = jsonata(expression);
    const result = await expr.evaluate(context);
    return !!result;
  } catch (err) {
    logger.warn("Failed to evaluate egress rule", {
      expression,
      url: urlString,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Look up a secret from the database with hierarchy resolution.
 * Priority: user-specific > project > org > global
 *
 * Note: This returns the egressProxyRule but does NOT enforce it.
 * Callers must use matchesEgressRule() to verify the rule allows the request.
 */
async function lookupSecret(
  db: DB,
  secretKey: string,
  context: {
    organizationId?: string;
    projectId?: string;
    userId?: string;
  },
): Promise<{ value: string; secretId: string; egressProxyRule?: string } | null> {
  // Build conditions for each scope level
  const conditions = [];

  // Global scope (all nulls)
  conditions.push(
    and(
      eq(schema.secret.key, secretKey),
      isNull(schema.secret.organizationId),
      isNull(schema.secret.projectId),
      isNull(schema.secret.userId),
    ),
  );

  // Org scope (if provided)
  if (context.organizationId) {
    conditions.push(
      and(
        eq(schema.secret.key, secretKey),
        eq(schema.secret.organizationId, context.organizationId),
        isNull(schema.secret.projectId),
        isNull(schema.secret.userId),
      ),
    );
  }

  // Project scope (if provided)
  if (context.projectId) {
    conditions.push(
      and(
        eq(schema.secret.key, secretKey),
        eq(schema.secret.projectId, context.projectId),
        isNull(schema.secret.userId),
      ),
    );
  }

  // User scope (if provided)
  // User-scoped secrets must also be within the same organization to prevent cross-org access
  if (context.userId && context.organizationId) {
    conditions.push(
      and(
        eq(schema.secret.key, secretKey),
        eq(schema.secret.userId, context.userId),
        eq(schema.secret.organizationId, context.organizationId),
      ),
    );
  }

  // Query all matching secrets
  const secrets = await db.query.secret.findMany({
    where: or(...conditions),
  });

  if (secrets.length === 0) return null;

  // Sort by specificity (more specific = higher priority)
  // User > Project > Org > Global
  const sorted = secrets.sort((a, b) => {
    const scoreA = (a.userId ? 8 : 0) + (a.projectId ? 4 : 0) + (a.organizationId ? 2 : 0);
    const scoreB = (b.userId ? 8 : 0) + (b.projectId ? 4 : 0) + (b.organizationId ? 2 : 0);
    return scoreB - scoreA; // Higher score first
  });

  const bestMatch = sorted[0];
  const decryptedValue = await decrypt(bestMatch.encryptedValue);

  // Update lastSuccessAt in background
  waitUntil(
    db
      .update(schema.secret)
      .set({ lastSuccessAt: new Date() })
      .where(eq(schema.secret.id, bestMatch.id)),
  );

  return {
    value: decryptedValue,
    secretId: bestMatch.id,
    egressProxyRule: bestMatch.egressProxyRule ?? undefined,
  };
}

/**
 * Resolve a secret with connector-aware error handling.
 * Returns rich errors with connect/reauth URLs for connector secrets.
 * Enforces egress proxy rules - rejects if the URL doesn't match the rule.
 */
async function resolveSecret(
  db: DB,
  secretKey: string,
  context: EgressContext,
): Promise<SecretResult> {
  // Determine if this is a connector request based on the URL
  const connector = getConnectorForUrl(context.originalUrl);
  const urlContext = { orgSlug: context.orgSlug, projectSlug: context.projectSlug };

  // Look up the secret
  const secret = await lookupSecret(db, secretKey, {
    organizationId: context.organizationId,
    projectId: context.projectId,
    userId: context.userId,
  });

  if (!secret) {
    // Secret not found - return appropriate error
    if (connector) {
      // This is a connector URL - provide helpful connect URL
      const connectUrl = getFullReauthUrl(connector, urlContext, env.VITE_PUBLIC_URL);
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `${connector.name} is not connected. Please connect it first.`,
          connectUrl,
        },
      };
    }
    // Non-connector secret not found
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Secret '${secretKey}' not found.`,
      },
    };
  }

  // Enforce egress proxy rule if present
  if (secret.egressProxyRule) {
    const allowed = await matchesEgressRule(context.originalUrl, secret.egressProxyRule);
    if (!allowed) {
      logger.warn("Egress rule rejected request", {
        secretKey,
        rule: secret.egressProxyRule,
        url: context.originalUrl,
      });
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Secret '${secretKey}' is not allowed for this URL.`,
        },
      };
    }
  }

  return {
    ok: true,
    value: secret.value,
    secretId: secret.secretId,
    isConnector: !!connector,
  };
}

/**
 * API key context returned on successful validation.
 */
type ApiKeyContext = {
  projectId: string;
  organizationId: string;
  projectSlug: string;
  orgSlug: string;
};

/**
 * Result of magic string replacement - tracks which secrets were used for 401 retry.
 */
type ReplaceMagicStringsResult =
  | { ok: true; result: string; usedSecrets: Array<{ secretId: string; isConnector: boolean }> }
  | { ok: false; error: SecretError };

/**
 * Replace all magic strings in a string with their resolved secret values.
 * Returns errors with connect URLs for missing connector secrets.
 */
async function replaceMagicStrings(
  db: DB,
  input: string,
  context: EgressContext,
): Promise<ReplaceMagicStringsResult> {
  const matches = [...input.matchAll(MAGIC_STRING_PATTERN)];
  if (matches.length === 0) {
    return { ok: true, result: input, usedSecrets: [] };
  }

  let result = input;
  const usedSecrets: Array<{ secretId: string; isConnector: boolean }> = [];

  for (const match of matches) {
    const fullMatch = match[0];
    const parsed = parseMagicString(fullMatch);

    if (!parsed) {
      logger.warn("Invalid magic string format", { match: fullMatch });
      continue;
    }

    // Use resolveSecret with full context for connector-aware errors
    // Note: We intentionally ignore parsed.userId from magic strings to prevent cross-user access
    // User-scoped secrets are only accessible via the authenticated session context
    const secretResult = await resolveSecret(db, parsed.secretKey, context);

    if (!secretResult.ok) {
      // Return the error immediately - don't continue with partial replacement
      return { ok: false, error: secretResult.error };
    }

    result = result.replace(fullMatch, secretResult.value);
    usedSecrets.push({
      secretId: secretResult.secretId,
      isConnector: secretResult.isConnector,
    });

    logger.info("Egress proxy replaced magic string", {
      secretKey: parsed.secretKey,
      hasUserId: !!parsed.userId,
    });
  }

  return { ok: true, result, usedSecrets };
}

/**
 * Process a header value, handling Basic auth specially.
 * Basic auth credentials are base64-encoded, so we need to decode, replace magic strings, and re-encode.
 * For non-Basic auth headers, just do normal magic string replacement.
 */
async function processHeaderValue(
  db: DB,
  headerName: string,
  headerValue: string,
  context: EgressContext,
): Promise<ReplaceMagicStringsResult> {
  // Check if this is a Basic auth header
  const basicAuthMatch = headerValue.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
  if (basicAuthMatch && headerName.toLowerCase() === "authorization") {
    // Decode the base64 credentials
    let decoded: string;
    try {
      decoded = atob(basicAuthMatch[1]);
    } catch {
      // Invalid base64, treat as normal header
      return replaceMagicStrings(db, headerValue, context);
    }

    // Check if decoded value contains magic strings
    if (!MAGIC_STRING_PATTERN.test(decoded)) {
      // No magic strings in decoded value
      return { ok: true, result: headerValue, usedSecrets: [] };
    }

    // Reset regex lastIndex since we used .test()
    MAGIC_STRING_PATTERN.lastIndex = 0;

    // Replace magic strings in decoded credentials
    const result = await replaceMagicStrings(db, decoded, context);
    if (!result.ok) {
      return result;
    }

    // Re-encode as base64
    const reEncoded = `Basic ${btoa(result.result)}`;
    return { ok: true, result: reEncoded, usedSecrets: result.usedSecrets };
  }

  // Normal header - just replace magic strings directly
  return replaceMagicStrings(db, headerValue, context);
}

/**
 * Return a JSON error response for secret errors.
 */
function secretErrorResponse(
  c: { json: (data: unknown, status: number) => Response },
  error: SecretError,
): Response {
  return c.json(
    {
      error: error.code.toLowerCase(),
      code: error.code,
      message: error.message,
      connectUrl: error.connectUrl,
      reauthUrl: error.reauthUrl,
    },
    error.code === "NOT_FOUND" ? 404 : 401,
  );
}

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

  // Authenticate the request and get context in a single query
  const db = c.get("db");
  const apiKeyContext = apiKey ? await validateAndGetContext(db, apiKey) : null;
  if (!apiKeyContext) {
    logger.warn("Egress proxy request with invalid API key", { originalURL });
    return c.json({ error: "Invalid or missing API key" }, 401);
  }

  // Build full context including URL for connector detection
  const context: EgressContext = {
    organizationId: apiKeyContext.organizationId,
    projectId: apiKeyContext.projectId,
    orgSlug: apiKeyContext.orgSlug,
    projectSlug: apiKeyContext.projectSlug,
    originalUrl: originalURL,
  };

  logger.info("Egress proxy forwarding", {
    method: originalMethod,
    url: originalURL,
    host: originalHost,
    projectId: context.projectId,
  });

  // Track secrets used for potential 401 retry
  const usedSecrets: Array<{ secretId: string; isConnector: boolean }> = [];

  // Buffer the request body upfront so it can be reused on 401 retry
  // (Request bodies are streams and can only be read once)
  let requestBody: ArrayBuffer | null = null;
  if (hasRequestBody(originalMethod)) {
    try {
      requestBody = await c.req.raw.arrayBuffer();
    } catch {
      // Body may be empty or already consumed
    }
  }

  try {
    // Process magic strings in the URL
    const urlResult = await replaceMagicStrings(db, originalURL, context);
    if (!urlResult.ok) {
      return secretErrorResponse(c, urlResult.error);
    }
    const processedURL = urlResult.result;
    usedSecrets.push(...urlResult.usedSecrets);

    // Build headers for the forwarded request
    const forwardHeaders = new Headers();
    const originalHeaderEntries: Array<[string, string]> = [];
    c.req.raw.headers.forEach((value, key) => {
      if (!STRIP_REQUEST_HEADERS.includes(key.toLowerCase())) {
        forwardHeaders.set(key, value);
        originalHeaderEntries.push([key, value]);
      }
    });

    // Process magic strings in headers (handles Basic auth base64 encoding)
    for (const [key, value] of originalHeaderEntries) {
      const headerResult = await processHeaderValue(db, key, value, context);
      if (!headerResult.ok) {
        return secretErrorResponse(c, headerResult.error);
      }
      if (headerResult.result !== value) {
        forwardHeaders.set(key, headerResult.result);
        usedSecrets.push(...headerResult.usedSecrets);
      }
    }

    // Set the correct Host header for the destination
    if (originalHost) {
      forwardHeaders.set("Host", originalHost);
    }

    // Forward the request to the original destination
    let response = await fetch(processedURL, {
      method: originalMethod,
      headers: forwardHeaders,
      body: requestBody,
    });

    // Handle 401 - attempt refresh for connector secrets
    if (response.status === 401) {
      const connectorSecrets = usedSecrets.filter((s) => s.isConnector);

      if (connectorSecrets.length > 0) {
        logger.info("Egress proxy received 401, attempting refresh", {
          url: originalURL,
          secretCount: connectorSecrets.length,
        });

        // Try to refresh the first connector secret (usually there's only one)
        const secretToRefresh = connectorSecrets[0];
        const refreshContext: RefreshContext = {
          orgSlug: context.orgSlug,
          projectSlug: context.projectSlug,
          encryptionSecret: env.ENCRYPTION_SECRET,
          publicUrl: env.VITE_PUBLIC_URL,
          slackClientId: env.SLACK_CLIENT_ID,
          slackClientSecret: env.SLACK_CLIENT_SECRET,
          googleClientId: env.GOOGLE_CLIENT_ID,
          googleClientSecret: env.GOOGLE_CLIENT_SECRET,
        };
        const refreshResult = await attemptSecretRefresh(
          db,
          secretToRefresh.secretId,
          originalURL,
          refreshContext,
        );

        if (refreshResult.ok) {
          // Refresh succeeded - retry the request with the new token
          // Re-process magic strings to get the updated value
          const retryUrlResult = await replaceMagicStrings(db, originalURL, context);
          if (!retryUrlResult.ok) {
            return secretErrorResponse(c, retryUrlResult.error);
          }

          // Re-build headers with updated secrets (handles Basic auth base64 encoding)
          const retryHeaders = new Headers();
          for (const [key, value] of originalHeaderEntries) {
            const headerResult = await processHeaderValue(db, key, value, context);
            if (!headerResult.ok) {
              return secretErrorResponse(c, headerResult.error);
            }
            retryHeaders.set(key, headerResult.result);
          }

          if (originalHost) {
            retryHeaders.set("Host", originalHost);
          }

          // Retry the request with buffered body
          response = await fetch(retryUrlResult.result, {
            method: originalMethod,
            headers: retryHeaders,
            body: requestBody,
          });

          logger.info("Egress proxy retry after refresh", {
            url: originalURL,
            status: response.status,
          });
        } else {
          // Refresh failed - return helpful error
          return c.json(
            {
              error: "token_refresh_failed",
              code: refreshResult.code,
              message: `Authentication failed and token refresh was unsuccessful. Please re-authenticate.`,
              reauthUrl: refreshResult.reauthUrl,
            },
            401,
          );
        }
      }
    }

    // Build response headers
    const responseHeaders = new Headers();
    response.headers.forEach((value, key) => {
      if (!STRIP_RESPONSE_HEADERS.includes(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    });

    logger.info("Egress proxy response", {
      url: processedURL,
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
 * Check if the HTTP method typically has a request body.
 */
function hasRequestBody(method: string): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
}

/**
 * Validate the API key and return context in a single query.
 * API key format: pak_<tokenId>_<randomHex>
 * Returns null if validation fails, context object on success.
 */
async function validateAndGetContext(db: DB, apiKey: string): Promise<ApiKeyContext | null> {
  // For development/testing, accept "test-key"
  if (import.meta.env.DEV && apiKey === "test-key") {
    // Return a mock context for testing
    return {
      projectId: "test-project",
      organizationId: "test-org",
      projectSlug: "test",
      orgSlug: "test",
    };
  }

  // Parse the token ID from the API key
  const tokenId = parseTokenIdFromApiKey(apiKey);
  if (!tokenId) {
    logger.warn("Invalid API key format", { apiKey: apiKey.slice(0, 20) + "..." });
    return null;
  }

  // Look up the token with project and org relations in a single query
  const accessToken = await db.query.projectAccessToken.findFirst({
    where: eq(schema.projectAccessToken.id, tokenId),
    with: {
      project: {
        with: {
          organization: true,
        },
      },
    },
  });

  if (!accessToken) {
    logger.warn("Access token not found", { tokenId });
    return null;
  }

  if (accessToken.revokedAt) {
    logger.warn("Access token revoked", { tokenId });
    return null;
  }

  // Decrypt the stored token and compare with the provided API key
  const storedToken = await decrypt(accessToken.encryptedToken);
  if (apiKey !== storedToken) {
    logger.warn("Invalid API key for token", { tokenId });
    return null;
  }

  // Update last used timestamp in background
  waitUntil(
    db
      .update(schema.projectAccessToken)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.projectAccessToken.id, tokenId)),
  );

  return {
    projectId: accessToken.project.id,
    organizationId: accessToken.project.organizationId,
    projectSlug: accessToken.project.slug,
    orgSlug: accessToken.project.organization.slug,
  };
}

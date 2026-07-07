import { createIterateAuth } from "@iterate-com/auth/server";
import type { AppConfig } from "~/config.ts";

export type OsIterateAuth = ReturnType<typeof createIterateAuth>;

const authClients = new Map<string, OsIterateAuth>();

/**
 * Build (and cache) the iterate-auth relying-party client for this deployment.
 * Shared by the TanStack Start request middleware and the itx auth
 * adapter — one client config, one cache, regardless of which worker asks.
 */
export function createOsIterateAuth(config: AppConfig, requestUrl: string): OsIterateAuth | null {
  const authConfig = config.iterateAuth;
  if (!authConfig) return null;

  const requestOrigin = new URL(requestUrl).origin;
  const resource = resolveIterateAuthResource({
    authResource: authConfig.resource,
    baseUrl: config.baseUrl,
    requestUrl,
  });
  const clientConfig = {
    issuer: authConfig.issuer,
    clientId: authConfig.clientId,
    clientSecret: authConfig.clientSecret.exposeSecret(),
    jwks: authConfig.jwks,
    redirectURI: `${(config.baseUrl ?? requestOrigin).replace(/\/+$/, "")}/api/iterate-auth/callback`,
    resource: [resource],
    logoutReturnToOrigins: config.baseUrl ? [config.baseUrl] : undefined,
  };
  const cacheKey = JSON.stringify(clientConfig);
  const cached = authClients.get(cacheKey);
  if (cached) return cached;

  const auth = createIterateAuth(clientConfig);
  authClients.set(cacheKey, auth);
  return auth;
}

export function resolveIterateAuthResource(input: {
  authResource?: string;
  baseUrl?: string;
  requestUrl: string;
}) {
  return normalizeOAuthResource(
    input.authResource ?? input.baseUrl ?? new URL(input.requestUrl).origin,
  );
}

function normalizeOAuthResource(rawResource: string) {
  const url = new URL(rawResource);
  url.pathname = "";
  url.search = "";
  url.hash = "";
  if (
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname === "127.0.0.1"
  ) {
    url.port = "";
  }
  return url.toString().replace(/\/+$/u, "");
}

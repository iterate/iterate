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
  const resource = (authConfig.resource ?? config.baseUrl ?? requestOrigin).replace(/\/+$/, "");
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

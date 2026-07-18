import { createIterateAuth } from "@iterate-com/auth/server";
import type { AppConfig } from "./config.ts";

/**
 * Relying-party auth for the streams playground — the same model as
 * apps/semaphore. Browsers sign in through `/api/iterate-auth/*` and carry
 * the `iterate_session` cookie (sent on the capnweb WebSocket upgrade too);
 * CLIs and node e2e present a bearer access token. Everything the playground
 * serves runs with trusted-internal authority, so access is a single
 * question: is the caller an iterate admin?
 *
 * When `iterateAuth` is absent from the config (local dev only — deploys
 * require the secrets), the worker stays the historical auth-less
 * playground.
 */

type StreamsIterateAuth = ReturnType<typeof createIterateAuth>;

const authClients = new Map<string, StreamsIterateAuth>();

/** Build (and cache) the iterate-auth relying-party client for this deployment. */
export function createStreamsIterateAuth(
  config: AppConfig,
  requestUrl: string,
): StreamsIterateAuth | null {
  const authConfig = config.iterateAuth;
  if (!authConfig) return null;

  const requestOrigin = new URL(requestUrl).origin;
  const baseOrigin = (config.baseUrl ?? requestOrigin).replace(/\/+$/, "");
  const clientConfig = {
    issuer: authConfig.issuer,
    clientId: authConfig.clientId,
    clientSecret: authConfig.clientSecret.exposeSecret(),
    jwks: authConfig.jwks,
    redirectURI: `${baseOrigin}/api/iterate-auth/callback`,
    resource: [(authConfig.resource ?? baseOrigin).replace(/\/+$/, "")],
    logoutReturnToOrigins: config.baseUrl ? [config.baseUrl] : undefined,
  };
  const cacheKey = JSON.stringify(clientConfig);
  const cached = authClients.get(cacheKey);
  if (cached) return cached;

  const auth = createIterateAuth(clientConfig);
  authClients.set(cacheKey, auth);
  return auth;
}

/**
 * The authenticated caller: session cookie wins (browser + WS upgrade), else
 * bearer. `responseHeaders` carries any rotated-session `Set-Cookie` that
 * `authenticate()` produced when it refreshed an expiring token — the caller
 * MUST merge it onto the response, or the browser keeps the stale token and
 * refresh-token reuse eventually nukes the session.
 */
export async function resolveRequestAdmin(input: {
  auth: StreamsIterateAuth;
  headers: Headers;
}): Promise<{
  authenticated: boolean;
  isAdmin: boolean;
  email?: string;
  responseHeaders: Headers;
}> {
  const authentication = await input.auth.authenticate({
    headers: input.headers,
    includeUserInfo: false,
  });
  if (authentication.credential === null) {
    return {
      authenticated: false,
      isAdmin: false,
      responseHeaders: authentication.responseHeaders,
    };
  }
  return {
    authenticated: true,
    isAdmin: authentication.identity.isAdmin,
    email: authentication.identity.email,
    responseHeaders: authentication.responseHeaders,
  };
}

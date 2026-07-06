import { createIterateAuth } from "@iterate-com/auth/server";
import { ITERATE_IS_ADMIN_CLAIM, ITERATE_ROLE_CLAIM } from "@iterate-com/shared/auth-claims";
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

/** The authenticated caller: session cookie wins (browser + WS upgrade), else bearer. */
export async function resolveRequestAdmin(input: {
  auth: StreamsIterateAuth;
  headers: Headers;
}): Promise<{ authenticated: boolean; isAdmin: boolean; email?: string }> {
  const result = await input.auth.authenticate({
    headers: input.headers,
    includeUserInfo: false,
  });
  if (result.session) {
    return {
      authenticated: true,
      isAdmin: result.session.user.isAdmin === true || result.session.user.role === "admin",
      email: result.session.user.email,
    };
  }

  const accessToken = await input.auth.authenticateBearer({ headers: input.headers });
  if (accessToken) {
    const email = accessToken.email;
    return {
      authenticated: true,
      isAdmin:
        accessToken[ITERATE_IS_ADMIN_CLAIM] === true || accessToken[ITERATE_ROLE_CLAIM] === "admin",
      email: typeof email === "string" ? email : undefined,
    };
  }

  return { authenticated: false, isAdmin: false };
}

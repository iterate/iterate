import {
  createIterateAuth,
  type AccessTokenClaims,
  type AuthenticatedSession,
} from "@iterate-com/auth/server";
import { ITERATE_IS_ADMIN_CLAIM, ITERATE_ROLE_CLAIM } from "@iterate-com/shared/auth-claims";
import type { AppConfig } from "~/config.ts";

/**
 * Semaphore's relying-party auth against apps/auth — the same model as
 * apps/os. Browsers sign in through the `/api/iterate-auth/*` handler and
 * carry the `iterate_session` cookie; CLIs present a bearer access token
 * (forge-minted or issued by the auth worker). Everything semaphore serves is
 * operator tooling, so authorization is a single question: is the caller an
 * iterate admin?
 */

type SemaphoreIterateAuth = ReturnType<typeof createIterateAuth>;

const authClients = new Map<string, SemaphoreIterateAuth>();

/** Build (and cache) the iterate-auth relying-party client for this deployment. */
export function createSemaphoreIterateAuth(
  config: AppConfig,
  requestUrl: string,
): SemaphoreIterateAuth | null {
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

/** The authenticated caller behind a request — from a session cookie or a bearer access token. */
export type SemaphorePrincipal = {
  userId: string;
  email?: string;
  isAdmin: boolean;
};

function principalFromSession(session: AuthenticatedSession): SemaphorePrincipal {
  return {
    userId: session.user.id,
    email: session.user.email,
    isAdmin: session.user.isAdmin === true || session.user.role === "admin",
  };
}

function principalFromAccessToken(accessToken: AccessTokenClaims): SemaphorePrincipal {
  const email = accessToken.email;
  return {
    userId: accessToken.sub,
    email: typeof email === "string" ? email : undefined,
    isAdmin:
      accessToken[ITERATE_IS_ADMIN_CLAIM] === true || accessToken[ITERATE_ROLE_CLAIM] === "admin",
  };
}

/**
 * Resolve the request's principal: the session cookie wins (the browser
 * lane), else the Authorization bearer token (the CLI/API lane). Returns the
 * session too so the middleware can propagate refreshed cookies.
 */
export async function resolveRequestPrincipal(input: {
  auth: SemaphoreIterateAuth;
  headers: Headers;
}): Promise<{
  principal: SemaphorePrincipal | null;
  session: AuthenticatedSession | null;
  responseHeaders: Headers;
}> {
  const result = await input.auth.authenticate({
    headers: input.headers,
    includeUserInfo: false,
  });
  if (result.session) {
    return {
      principal: principalFromSession(result.session),
      session: result.session,
      responseHeaders: result.responseHeaders,
    };
  }

  const accessToken = await input.auth.authenticateBearer({ headers: input.headers });
  return {
    principal: accessToken ? principalFromAccessToken(accessToken) : null,
    session: null,
    responseHeaders: result.responseHeaders,
  };
}

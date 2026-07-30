import {
  createIterateAuth,
  type AuthenticatedIdentity,
  type AuthenticatedSession,
} from "@iterate-com/auth/server";
import type { AppConfig } from "./config.ts";

type EnvManagerIterateAuth = ReturnType<typeof createIterateAuth>;

const clients = new Map<string, EnvManagerIterateAuth>();

export function createEnvManagerIterateAuth(config: AppConfig): EnvManagerIterateAuth {
  const authConfig = config.iterateAuth;
  const clientConfig = {
    issuer: authConfig.issuer,
    clientId: authConfig.clientId,
    clientSecret: authConfig.clientSecret.exposeSecret(),
    jwks: authConfig.jwks,
    redirectURI: `${config.baseUrl}/api/iterate-auth/callback`,
    resource: [authConfig.resource],
    logoutReturnToOrigins: [config.baseUrl],
  };
  const cacheKey = JSON.stringify(clientConfig);
  const existing = clients.get(cacheKey);
  if (existing) return existing;

  const auth = createIterateAuth(clientConfig);
  clients.set(cacheKey, auth);
  return auth;
}

export type EnvManagerPrincipal = AuthenticatedIdentity;

export async function resolveRequestPrincipal(input: {
  auth: EnvManagerIterateAuth;
  headers: Headers;
}): Promise<{
  principal: EnvManagerPrincipal | null;
  session: AuthenticatedSession | null;
  responseHeaders: Headers;
}> {
  const authentication = await input.auth.authenticate({ headers: input.headers });
  if (authentication.credential === null) {
    return {
      principal: null,
      session: null,
      responseHeaders: authentication.responseHeaders,
    };
  }
  return {
    principal: authentication.identity,
    session: authentication.credential === "session" ? authentication.session : null,
    responseHeaders: authentication.responseHeaders,
  };
}

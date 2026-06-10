import {
  createIterateAuth,
  isAuthHandlerRequest,
  type AuthenticatedSession,
} from "@iterate-com/auth/server";
import { oauthResourceAudienceVariants } from "@iterate-com/shared/oauth-resource";
import { createMiddleware } from "@tanstack/react-start";
import type { RequestContext } from "~/request-context.ts";
import { authenticateAdminApiSecret } from "~/auth/admin.ts";
import { resolveMcpBaseUrl } from "~/lib/mcp-base-url.ts";
import {
  principalFromAccessToken,
  principalFromSession,
  type Principal,
} from "~/auth/principal.ts";

type OsIterateAuth = ReturnType<typeof createIterateAuth>;

const authClients = new Map<string, OsIterateAuth>();

// Registered as requestMiddleware in src/start.ts — `type: "request"` makes
// early `Response` returns part of the contract (and the context it passes to
// `next` flow into every server route, server function, and oRPC procedure):
// https://tanstack.com/start/latest/docs/framework/react/guide/middleware
export const iterateAuthMiddleware = createMiddleware({ type: "request" }).server(
  async ({ request, context, next }) => {
    // Start types the request context as possibly undefined, but worker.ts
    // always passes one to handler.fetch — treat its absence as a wiring bug.
    if (!context) {
      throw new Error("Request context missing — handler.fetch was called without a context.");
    }
    const auth = createOsIterateAuth(context, request);
    const authHandlerResponse = auth?.handleRequest(request) ?? null;
    if (authHandlerResponse) {
      return authHandlerResponse;
    }
    if (!auth && isAuthHandlerRequest(request)) {
      return new Response("Iterate auth is not configured.", { status: 503 });
    }

    const resolvedAuth = await resolveRequestAuth({ auth, context, request });

    const result = await next({
      context: {
        principal: resolvedAuth.principal,
        iterateAuthSession: resolvedAuth.session,
        rawRequest: request,
      },
    });

    const setCookie = resolvedAuth.responseHeaders.get("set-cookie");
    if (setCookie) {
      result.response.headers.append("set-cookie", setCookie);
    }

    return result;
  },
);

export async function resolveRequestAuth(input: {
  auth: OsIterateAuth | null;
  context: Pick<RequestContext, "config">;
  request: Request;
}): Promise<{
  principal: Principal | null;
  session: AuthenticatedSession | null;
  responseHeaders: Headers;
}> {
  const adminApiPrincipal = authenticateAdminApiSecret(input.context, input.request);
  if (adminApiPrincipal) {
    return {
      principal: adminApiPrincipal,
      session: null,
      responseHeaders: new Headers(),
    };
  }

  const sessionAuth = await authenticateSession({
    auth: input.auth,
    headers: input.request.headers,
  });
  if (sessionAuth.principal) {
    return sessionAuth;
  }

  const bearerPrincipal = await authenticateBearerPrincipal({
    auth: input.auth,
    headers: input.request.headers,
  });
  return {
    principal: bearerPrincipal,
    session: sessionAuth.session,
    responseHeaders: sessionAuth.responseHeaders,
  };
}

async function authenticateSession(input: {
  auth: OsIterateAuth | null;
  headers: Headers;
}): Promise<{
  principal: Principal | null;
  session: AuthenticatedSession | null;
  responseHeaders: Headers;
}> {
  if (!input.auth) {
    return {
      principal: null,
      session: null,
      responseHeaders: new Headers(),
    };
  }

  const result = await input.auth.authenticate({
    headers: input.headers,
    includeUserInfo: false,
  });
  return {
    principal: result.session ? principalFromSession(result.session) : null,
    session: result.session,
    responseHeaders: result.responseHeaders,
  };
}

async function authenticateBearerPrincipal(input: {
  auth: OsIterateAuth | null;
  headers: Headers;
}): Promise<Principal | null> {
  if (!input.auth) return null;

  const accessToken = await input.auth.authenticateBearer({ headers: input.headers });
  return accessToken ? principalFromAccessToken(accessToken) : null;
}

export function createOsIterateAuth(context: RequestContext, request: Request) {
  const config = context.config.iterateAuth;
  if (!config) return null;

  const requestOrigin = new URL(request.url).origin;
  const resource = (config.resource ?? context.config.baseUrl ?? requestOrigin).replace(/\/+$/, "");
  const resourceSet = new Set([resource]);
  if (isLocalhostOrigin(requestOrigin)) {
    resourceSet.add(requestOrigin.replace(/\/+$/, ""));
  }
  const mcpResource = resolveMcpBaseUrl({
    appBaseUrl: context.config.baseUrl,
    mcpBaseUrl: context.config.mcp?.baseUrl,
    requestUrl: request.url,
  });
  const resources = mcpResource
    ? [...resourceSet, ...oauthResourceAudienceVariants(mcpResource)]
    : [...resourceSet];

  const authConfig = {
    issuer: config.issuer,
    clientId: config.clientId,
    clientSecret: config.clientSecret.exposeSecret(),
    jwks: config.jwks,
    redirectURI: `${(context.config.baseUrl ?? requestOrigin).replace(/\/+$/, "")}/api/iterate-auth/callback`,
    resource: resources,
    logoutReturnToOrigins: context.config.baseUrl ? [context.config.baseUrl] : undefined,
  };
  const cacheKey = JSON.stringify(authConfig);
  const cached = authClients.get(cacheKey);
  if (cached) return cached;

  const auth = createIterateAuth(authConfig);
  authClients.set(cacheKey, auth);
  return auth;
}

function isLocalhostOrigin(origin: string) {
  const hostname = new URL(origin).hostname.toLowerCase();
  return hostname === "localhost";
}

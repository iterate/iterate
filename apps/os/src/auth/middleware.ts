import { createIterateAuth, type AuthenticatedSession } from "@iterate-com/auth/server";
import { createMiddleware } from "@tanstack/react-start";
import type { AppContext } from "~/context.ts";
import {
  adminPrincipal,
  principalFromAccessToken,
  principalFromSession,
  type Principal,
} from "~/auth/principal.ts";

const AUTH_HANDLER_PREFIX = "/api/iterate-auth/";

export const iterateAuthMiddleware = createMiddleware().server(
  async ({ request, context, next }) => {
    const auth = createOsIterateAuth(context, request);
    const authHandlerResponse = handleAuthHandlerRequest({ auth, request });
    if (authHandlerResponse) {
      return authHandlerResponse;
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

function handleAuthHandlerRequest(input: {
  auth: ReturnType<typeof createOsIterateAuth>;
  request: Request;
}) {
  if (!new URL(input.request.url).pathname.startsWith(AUTH_HANDLER_PREFIX)) {
    return null;
  }

  if (!input.auth) {
    return new Response("Iterate auth is not configured.", { status: 503 });
  }

  return input.auth.handler(input.request);
}

async function resolveRequestAuth(input: {
  auth: ReturnType<typeof createOsIterateAuth>;
  context: Pick<AppContext, "config">;
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
  auth: ReturnType<typeof createOsIterateAuth>;
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

  const result = await input.auth.authenticate({ headers: input.headers });
  return {
    principal: result.session ? principalFromSession(result.session) : null,
    session: result.session,
    responseHeaders: result.responseHeaders,
  };
}

async function authenticateBearerPrincipal(input: {
  auth: ReturnType<typeof createOsIterateAuth>;
  headers: Headers;
}): Promise<Principal | null> {
  if (!input.auth) return null;

  const accessToken = await input.auth.authenticateBearer({ headers: input.headers });
  return accessToken ? principalFromAccessToken(accessToken) : null;
}

export function readBearerToken(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const match = /^bearer\s+(.+)$/i.exec(headerValue);
  const token = match?.[1]?.trim() ?? "";
  return token.length > 0 ? token : null;
}

export function authenticateAdminApiSecret(
  context: Pick<AppContext, "config">,
  request: Request,
): Principal | null {
  const expectedToken = context.config.adminApiSecret?.exposeSecret();
  const providedToken = readBearerToken(request.headers.get("authorization"));

  if (!expectedToken || !providedToken || providedToken !== expectedToken) {
    return null;
  }

  return adminPrincipal;
}

function createOsIterateAuth(context: AppContext, request: Request) {
  const config = context.config.iterateAuth;
  if (!config) return null;

  const requestOrigin = new URL(request.url).origin;
  const resource = (config.resource ?? context.config.baseUrl ?? requestOrigin).replace(/\/+$/, "");

  return createIterateAuth({
    issuer: config.issuer,
    clientId: config.clientId,
    clientSecret: config.clientSecret.exposeSecret(),
    redirectURI: `${(context.config.baseUrl ?? requestOrigin).replace(/\/+$/, "")}/api/iterate-auth/callback`,
    resource: [resource, `${resource}/mcp`],
    logoutReturnToOrigins: context.config.baseUrl ? [context.config.baseUrl] : undefined,
  });
}

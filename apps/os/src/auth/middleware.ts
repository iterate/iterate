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
    if (new URL(request.url).pathname.startsWith(AUTH_HANDLER_PREFIX)) {
      if (!auth) {
        return new Response("Iterate auth is not configured.", { status: 503 });
      }
      return auth.handler(request);
    }

    let session: AuthenticatedSession | null = null;
    const adminApiPrincipal = authenticateAdminApiSecret(context, request);
    let principal: Principal | null = adminApiPrincipal;
    let responseHeaders = new Headers();

    if (!principal && auth) {
      const result = await auth.authenticate({ headers: request.headers });
      session = result.session;
      responseHeaders = result.responseHeaders;
      principal = session ? principalFromSession(session) : null;
    }

    if (!principal && auth) {
      const accessToken = await auth.authenticateBearer({ headers: request.headers });
      principal = accessToken ? principalFromAccessToken(accessToken) : null;
    }

    const result = await next({
      context: {
        principal,
        iterateAuthSession: session,
        rawRequest: request,
      },
    });

    const setCookie = responseHeaders.get("set-cookie");
    if (setCookie && "response" in result) {
      result.response.headers.append("set-cookie", setCookie);
    }

    return result;
  },
);

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
  });
}

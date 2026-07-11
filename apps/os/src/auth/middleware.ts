import {
  isAuthHandlerRequest,
  type AuthenticatedSession,
  type AuthenticateErrorEvent,
} from "@iterate-com/auth/server";
import { createMiddleware } from "@tanstack/react-start";
import type { RequestContext } from "~/request-context.ts";
import { authenticateAdminApiSecret } from "~/auth/admin.ts";
import type { SignInAuthError } from "~/auth/errors.ts";
import { createOsIterateAuth } from "~/auth/iterate-auth-client.ts";
import type { OsIterateAuth } from "~/auth/iterate-auth-client.ts";
import {
  principalFromAccessToken,
  principalFromSession,
  type Principal,
} from "~/auth/principal.ts";

// Registered as requestMiddleware in src/start.ts — `type: "request"` makes
// early `Response` returns part of the contract (and the context it passes to
// `next` flow into every server route and server function):
// https://tanstack.com/start/latest/docs/framework/react/guide/middleware
export const iterateAuthMiddleware = createMiddleware({ type: "request" }).server(
  async ({ request, context, next }) => {
    const auth = createOsIterateAuth(context.config, request.url);
    const authHandlerResponse = auth?.handleRequest(request) ?? null;
    if (authHandlerResponse) {
      return authHandlerResponse;
    }
    if (!auth && isAuthHandlerRequest(request)) {
      return new Response("Iterate auth is not configured.", { status: 503 });
    }

    // Fingerprinted client-build files are public, yet requests for them can
    // reach this worker (sourcemaps are not uploaded to the static assets
    // manifest, so devtools .js.map fetches fall through). They must never run
    // session auth: the refresh token rotates on every use and the anti-theft
    // response to presenting a rotated token is revoking the user's whole
    // session family, so a burst of parallel subresource refreshes racing a
    // navigation's refresh (single-flight only holds within one isolate) signs
    // the user out with "session_verification_failed".
    if (isPublicAssetRequest(request)) {
      return next({
        context: {
          principal: null,
          iterateAuthSession: null,
          iterateAuthError: undefined,
          rawRequest: request,
        },
      });
    }

    const resolvedAuth = await resolveRequestAuth({ auth, context, request });

    const result = await next({
      context: {
        principal: resolvedAuth.principal,
        iterateAuthSession: resolvedAuth.session,
        iterateAuthError: resolvedAuth.error,
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

/** GET/HEAD requests under the client build's asset prefix (including sourcemaps). */
export function isPublicAssetRequest(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  return new URL(request.url).pathname.startsWith("/assets/");
}

async function resolveRequestAuth(input: {
  auth: OsIterateAuth | null;
  context: Pick<RequestContext, "config" | "log">;
  request: Request;
}): Promise<{
  principal: Principal | null;
  session: AuthenticatedSession | null;
  error?: SignInAuthError;
  responseHeaders: Headers;
}> {
  const adminApiPrincipal = authenticateAdminApiSecret(input.context, input.request);
  if (adminApiPrincipal) {
    return {
      principal: adminApiPrincipal,
      session: null,
      error: undefined,
      responseHeaders: new Headers(),
    };
  }

  const sessionAuth = await authenticateSession({
    auth: input.auth,
    context: input.context,
    headers: input.request.headers,
    request: input.request,
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
    error: sessionAuth.error,
    responseHeaders: sessionAuth.responseHeaders,
  };
}

async function authenticateSession(input: {
  auth: OsIterateAuth | null;
  context: Pick<RequestContext, "config" | "log">;
  headers: Headers;
  request: Request;
}): Promise<{
  principal: Principal | null;
  session: AuthenticatedSession | null;
  error?: SignInAuthError;
  responseHeaders: Headers;
}> {
  if (!input.auth) {
    return {
      principal: null,
      session: null,
      error: undefined,
      responseHeaders: new Headers(),
    };
  }

  let authError: AuthenticateErrorEvent | null = null;
  const result = await input.auth.authenticate({
    headers: input.headers,
    includeUserInfo: false,
    onError: (event) => {
      authError = event;
    },
  });
  const hasSessionCookie = /(?:^|;\s*)iterate_session=/u.test(input.headers.get("cookie") ?? "");
  const error =
    !result.session && authError && hasSessionCookie ? "session_verification_failed" : undefined;
  if (authError && error) {
    logAuthSessionVerificationFailure({
      context: input.context,
      error: authError,
      request: input.request,
    });
  }

  return {
    principal: result.session ? principalFromSession(result.session) : null,
    session: result.session,
    error,
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

function logAuthSessionVerificationFailure(input: {
  context: Pick<RequestContext, "config" | "log">;
  error: AuthenticateErrorEvent;
  request: Request;
}) {
  const url = new URL(input.request.url);
  const details = {
    reason: input.error.reason,
    error: toLogError(input.error.error),
    issuer: input.context.config.iterateAuth?.issuer,
    clientId: input.context.config.iterateAuth?.clientId,
    jwksKeyIds: input.context.config.iterateAuth?.jwks?.keys
      ?.map((key) => (typeof key.kid === "string" ? key.kid : null))
      .filter((kid) => kid !== null),
    sessionCookie: summarizeSessionCookie(input.request.headers),
    path: `${url.pathname}${url.search}`,
  };

  input.context.log.warn("os.auth.session_verification_failed");
  input.context.log.set({ auth: { sessionVerificationFailure: details } });
}

function toLogError(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { message: String(error) };
}

function summarizeSessionCookie(headers: Headers) {
  const cookieValue = extractCookie(headers.get("cookie") ?? "", "iterate_session");
  if (!cookieValue) return { present: false };

  try {
    const tokenSet = JSON.parse(decodeURIComponent(cookieValue)) as {
      accessToken?: unknown;
      idToken?: unknown;
    };
    return {
      present: true,
      parseable: true,
      accessTokenKid: jwtHeaderKid(tokenSet.accessToken),
      idTokenKid: jwtHeaderKid(tokenSet.idToken),
    };
  } catch {
    return { present: true, parseable: false };
  }
}

function extractCookie(cookieHeader: string, name: string) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`(?:^|;\\s*)${escapedName}=([^;]*)`, "u").exec(cookieHeader);
  return match?.[1] ?? null;
}

function jwtHeaderKid(token: unknown) {
  if (typeof token !== "string") return null;
  const encodedHeader = token.split(".", 1)[0];
  if (!encodedHeader) return null;

  try {
    const header = JSON.parse(base64UrlDecode(encodedHeader)) as { kid?: unknown };
    return typeof header.kid === "string" ? header.kid : null;
  } catch {
    return null;
  }
}

function base64UrlDecode(value: string) {
  const padded = `${value.replace(/-/gu, "+").replace(/_/gu, "/")}${"=".repeat(
    (4 - (value.length % 4)) % 4,
  )}`;
  return atob(padded);
}

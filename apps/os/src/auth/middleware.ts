import {
  isAuthHandlerRequest,
  type AuthenticatedSession,
  type AuthenticateErrorEvent,
  withAuthenticationResponseHeaders,
} from "@iterate-com/auth/server";
import { createMiddleware } from "@tanstack/react-start";
import type { RequestContext } from "~/request-context.ts";
import { authenticateAdminApiSecret } from "~/auth/admin.ts";
import type { SignInAuthError } from "~/auth/errors.ts";
import { createOsIterateAuth } from "~/auth/iterate-auth-client.ts";
import type { OsIterateAuth } from "~/auth/iterate-auth-client.ts";
import {
  authenticateOperatorSession,
  type AuthenticatedOperatorSession,
} from "~/auth/operator-session.ts";
import { getUserPrincipal, principalFromIdentity, type Principal } from "~/auth/principal.ts";
import { withPosthogExceptionCapture } from "~/observability/posthog.ts";

// Registered as requestMiddleware in src/start.ts — `type: "request"` makes
// early `Response` returns part of the contract (and the context it passes to
// `next` flow into every server route and server function):
// https://tanstack.com/start/latest/docs/framework/react/guide/middleware
export const iterateAuthMiddleware = createMiddleware({ type: "request" }).server(
  async ({ request, context, next }) => {
    const auth = createOsIterateAuth(context.config, request.url);
    const authHandlerResponse = (await auth?.fetch(request)) ?? null;
    if (authHandlerResponse) return authHandlerResponse;
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
          operatorSession: null,
          iterateAuthSession: null,
          iterateAuthError: undefined,
          rawRequest: request,
        },
      });
    }

    const resolvedAuth = await resolveRequestAuth({ auth, context, request });

    const user = getUserPrincipal(resolvedAuth.principal);
    const result = await withPosthogExceptionCapture(
      {
        config: context.config,
        distinctId: user?.userId ?? resolvedAuth.operatorSession?.grant.operatorId,
        operation: context.executionCtx,
        projectId:
          resolvedAuth.operatorSession?.grant.kind === "project"
            ? resolvedAuth.operatorSession.grant.project.id
            : requestProjectId(request, user?.projects ?? []),
        request,
        waitUntil: context.waitUntil,
      },
      () =>
        next({
          context: {
            principal: resolvedAuth.principal,
            operatorSession: resolvedAuth.operatorSession,
            iterateAuthSession: resolvedAuth.session,
            iterateAuthError: resolvedAuth.error,
            rawRequest: request,
          },
        }),
    );

    const response = withAuthenticationResponseHeaders(
      result.response,
      resolvedAuth.responseHeaders,
    );
    return response === result.response ? result : { ...result, response };
  },
);

export function requestProjectId(request: Request, projects: Array<{ id: string; slug: string }>) {
  const requestUrl = new URL(request.url);
  const pathnames = [requestUrl.pathname];
  const referrer = request.headers.get("referer");
  if (referrer) {
    try {
      const referrerUrl = new URL(referrer);
      if (referrerUrl.origin === requestUrl.origin) pathnames.push(referrerUrl.pathname);
    } catch {
      // A malformed/spoofed referrer is not analytics identity.
    }
  }

  for (const pathname of pathnames) {
    const encodedSlug = /^\/projects\/([^/]+)/u.exec(pathname)?.[1];
    if (!encodedSlug) continue;
    try {
      const slug = decodeURIComponent(encodedSlug);
      const project = projects.find((candidate) => candidate.slug === slug);
      if (project) return project.id;
    } catch {
      // Keep looking; malformed percent escapes cannot identify a project.
    }
  }
  return undefined;
}

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
  operatorSession: AuthenticatedOperatorSession | null;
  responseHeaders: Headers;
}> {
  const adminPrincipal = authenticateAdminApiSecret(input.context, input.request);
  if (adminPrincipal) {
    return {
      principal: adminPrincipal,
      session: null,
      error: undefined,
      operatorSession: null,
      responseHeaders: new Headers(),
    };
  }

  const operatorSession = await authenticateOperatorSession({
    config: input.context.config,
    request: input.request,
  });
  if (operatorSession) {
    return {
      principal: operatorSession.principal,
      session: null,
      error: undefined,
      operatorSession,
      responseHeaders: new Headers(),
    };
  }

  if (!input.auth) {
    return {
      principal: null,
      session: null,
      error: undefined,
      operatorSession: null,
      responseHeaders: new Headers(),
    };
  }

  let authError: AuthenticateErrorEvent | null = null;
  const authentication = await input.auth.authenticate({
    headers: input.request.headers,
    onError: (event) => {
      authError = event;
    },
  });
  const hasSessionCookie = /(?:^|;\s*)iterate_session=/u.test(
    input.request.headers.get("cookie") ?? "",
  );
  const error =
    authentication.credential !== "session" && authError && hasSessionCookie
      ? "session_verification_failed"
      : undefined;
  if (authError && error)
    logAuthSessionVerificationFailure({ context: input.context, error: authError });

  return {
    principal:
      authentication.credential === null ? null : principalFromIdentity(authentication.identity),
    session: authentication.credential === "session" ? authentication.session : null,
    error,
    operatorSession: null,
    responseHeaders: authentication.responseHeaders,
  };
}

function logAuthSessionVerificationFailure(input: {
  context: Pick<RequestContext, "config" | "log">;
  error: AuthenticateErrorEvent;
}) {
  const details = {
    reason: diagnosticIdentifier(input.error.reason) ?? "unknown",
    errorType: input.error.error instanceof Error ? "Error" : "NonErrorThrowable",
    issuerHost: input.context.config.iterateAuth?.issuer
      ? new URL(input.context.config.iterateAuth.issuer).host
      : undefined,
    clientId: diagnosticIdentifier(input.context.config.iterateAuth?.clientId),
    jwksKeyIds: input.context.config.iterateAuth?.jwks?.keys
      ?.map((key) => diagnosticIdentifier(key.kid))
      .filter((kid) => kid !== undefined)
      .slice(0, 20),
  };

  input.context.log.warn("os.auth.session_verification_failed", {
    auth: { sessionVerificationFailure: details },
  });
}

function diagnosticIdentifier(value: unknown) {
  if (typeof value !== "string") return undefined;
  return /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/u.test(value) ? value : undefined;
}

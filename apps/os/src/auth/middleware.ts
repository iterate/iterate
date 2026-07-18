import {
  isAuthHandlerRequest,
  type AuthenticateErrorEvent,
  withAuthenticationResponseHeaders,
} from "@iterate-com/auth/server";
import { createMiddleware } from "@tanstack/react-start";
import type { RequestContext } from "~/request-context.ts";
import { createOsIterateAuth } from "~/auth/iterate-auth-client.ts";
import { resolveOsRequestAuth } from "~/auth/request-auth.ts";

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

    const resolvedAuth = await resolveOsRequestAuth({
      config: context.config,
      credentials: { type: "from-request" },
      iterateAuth: auth,
      request,
    });
    if (resolvedAuth.sessionVerificationFailure) {
      logAuthSessionVerificationFailure({
        context,
        error: resolvedAuth.sessionVerificationFailure,
      });
    }

    const result = await next({
      context: {
        principal: resolvedAuth.principal,
        operatorSession: resolvedAuth.operatorSession,
        iterateAuthSession: resolvedAuth.iterateAuthSession,
        iterateAuthError: resolvedAuth.error,
        rawRequest: request,
      },
    });

    const response = withAuthenticationResponseHeaders(
      result.response,
      resolvedAuth.responseHeaders,
    );
    return response === result.response ? result : { ...result, response };
  },
);

/** GET/HEAD requests under the client build's asset prefix (including sourcemaps). */
export function isPublicAssetRequest(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  return new URL(request.url).pathname.startsWith("/assets/");
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

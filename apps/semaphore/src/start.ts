import { isAuthHandlerRequest } from "@iterate-com/auth/server";
import { createMiddleware, createStart } from "@tanstack/react-start";
import { createSemaphoreIterateAuth, resolveRequestPrincipal } from "~/auth.ts";

// Registered as requestMiddleware below — `type: "request"` makes early
// `Response` returns part of the contract (and the context it passes to
// `next` flows into every server route and server function):
// https://tanstack.com/start/latest/docs/framework/react/guide/middleware
const iterateAuthMiddleware = createMiddleware({ type: "request" }).server(
  async ({ request, context, next }) => {
    const auth = createSemaphoreIterateAuth(context.config, request.url);

    // The relying-party handler (login/callback/logout/session/…) is served
    // straight from the middleware, before routing.
    const authHandlerResponse = auth?.handleRequest(request) ?? null;
    if (authHandlerResponse) {
      return authHandlerResponse;
    }
    if (!auth && isAuthHandlerRequest(request)) {
      return new Response("Iterate auth is not configured.", { status: 503 });
    }

    const resolved = auth
      ? await resolveRequestPrincipal({ auth, headers: request.headers })
      : { principal: null, session: null, responseHeaders: new Headers() };

    const result = await next({
      context: {
        principal: resolved.principal,
        rawRequest: request,
      },
    });

    // authenticate() may have refreshed the session; hand the rotated cookie
    // back to the browser or the refresh-token family gets revoked as reuse.
    const setCookie = resolved.responseHeaders.get("set-cookie");
    if (setCookie) {
      result.response.headers.append("set-cookie", setCookie);
    }

    return result;
  },
);

export const startInstance = createStart(() => ({
  requestMiddleware: [iterateAuthMiddleware],
}));

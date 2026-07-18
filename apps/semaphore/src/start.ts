import { isAuthHandlerRequest, withAuthenticationResponseHeaders } from "@iterate-com/auth/server";
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
    const authHandlerResponse = (await auth?.fetch(request)) ?? null;
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

    const response = withAuthenticationResponseHeaders(result.response, resolved.responseHeaders);
    return response === result.response ? result : { ...result, response };
  },
);

export const startInstance = createStart(() => ({
  requestMiddleware: [iterateAuthMiddleware],
}));

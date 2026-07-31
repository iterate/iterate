import { withAuthenticationResponseHeaders } from "@iterate-com/auth/server";
import { createMiddleware, createStart } from "@tanstack/react-start";
import { createEnvManagerIterateAuth, resolveRequestPrincipal } from "./auth.ts";

const iterateAuthMiddleware = createMiddleware({ type: "request" }).server(
  async ({ request, context, next }) => {
    const auth = createEnvManagerIterateAuth(context.config);
    const authResponse = await auth.fetch(request);
    if (authResponse) return authResponse;

    const resolved = await resolveRequestPrincipal({ auth, headers: request.headers });
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

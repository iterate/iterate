import { createMiddleware, createStart } from "@tanstack/react-start";
import { isRedirect } from "@tanstack/react-router";

/**
 * Redirects in middleware are not handled properly
 * Handle them until this is fixed:
 * - https://github.com/TanStack/router/issues/4460
 */
const convertRedirectErrorToExceptionMiddleware = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    const result = await next();
    if ("error" in result && isRedirect(result.error)) {
      throw result.error;
    }
    return result;
  },
);

export const startInstance = createStart(() => ({
  functionMiddleware: [convertRedirectErrorToExceptionMiddleware],
}));

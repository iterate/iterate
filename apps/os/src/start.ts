import { clerkMiddleware } from "@clerk/tanstack-react-start/server";
import { isRedirect } from "@tanstack/react-router";
import { createMiddleware, createStart } from "@tanstack/react-start";

const convertRedirectErrorToExceptionMiddleware = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    const result = await next();
    // Server functions invoked from route lifecycles can serialize redirects as
    // result errors in this runtime shape. Re-throwing preserves TanStack
    // Router's normal redirect control flow for beforeLoad auth guards.
    if ("error" in result && isRedirect(result.error)) {
      throw result.error;
    }
    return result;
  },
);

export const startInstance = createStart(() => ({
  requestMiddleware: [
    clerkMiddleware({
      organizationSyncOptions: {
        organizationPatterns: ["/orgs/:slug", "/orgs/:slug/(.*)"],
      },
    }),
  ],
  functionMiddleware: [convertRedirectErrorToExceptionMiddleware],
}));

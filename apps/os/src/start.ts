import { isNotFound, isRedirect } from "@tanstack/react-router";
import { createMiddleware, createStart } from "@tanstack/react-start";
import { getUserPrincipal } from "~/auth/principal.ts";
import { iterateAuthMiddleware, requestProjectId } from "~/auth/middleware.ts";
import { schedulePosthogException } from "~/observability/posthog.ts";

const captureServerFunctionExceptionMiddleware = createMiddleware({ type: "function" }).server(
  async ({ context, next, serverFnMeta }) => {
    try {
      return await next();
    } catch (error) {
      // Redirects, not-found results, and explicit Responses are TanStack
      // control flow / modeled HTTP outcomes, not backend defects.
      if (!isRedirect(error) && !isNotFound(error) && !(error instanceof Response)) {
        const user = getUserPrincipal(context.principal);
        schedulePosthogException({
          config: context.config,
          distinctId: user?.userId ?? context.operatorSession?.grant.operatorId,
          error,
          operation: context.executionCtx,
          projectId:
            context.operatorSession?.grant.kind === "project"
              ? context.operatorSession.grant.project.id
              : context.rawRequest
                ? requestProjectId(context.rawRequest, user?.projects ?? [])
                : undefined,
          properties: {
            exception_boundary: "tanstack_server_function",
            server_fn: serverFnMeta.name,
          },
          request: context.rawRequest,
          waitUntil: context.waitUntil,
        });
      }
      throw error;
    }
  },
);

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
  requestMiddleware: [iterateAuthMiddleware],
  functionMiddleware: [
    captureServerFunctionExceptionMiddleware,
    convertRedirectErrorToExceptionMiddleware,
  ],
}));

import { redirect } from "@tanstack/react-router";
import { createMiddleware, createServerFn } from "@tanstack/react-start";
import { getRequestUrl } from "@tanstack/react-start/server";

export const authMiddleware = createMiddleware({ type: "function" }).server(({ context, next }) => {
  const { session } = context.variables;
  const request = getRequestUrl();
  if (!session)
    throw redirect({
      to: "/login",
      search: {
        redirectUrl: request.pathname + request.search,
      },
    });

  return next({
    context: {
      ...context,
      variables: {
        ...context.variables,
        session,
      },
    },
  });
});

export const authenticatedServerFn = createServerFn({ method: "POST" }).middleware([
  authMiddleware,
]);

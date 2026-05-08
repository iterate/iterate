import { implement } from "@orpc/server";
import { eventsContract } from "@iterate-com/events-contract";
import type { AppContext } from "~/context.ts";
import { defaultNamespace, resolveHostNamespace } from "~/lib/namespace.ts";

export const os = implement(eventsContract).$context<AppContext>();

// oRPC middleware is the boundary for request-derived context like headers, so
// handlers can depend on validated context instead of reading Request globals:
// https://orpc.dev/docs/middleware
export const withNamespace = os.middleware(({ context, next }) => {
  const requestUrl = context.rawRequest?.url;
  const namespace =
    (requestUrl ? resolveHostNamespace(new URL(requestUrl).hostname) : undefined) ??
    defaultNamespace;

  return next({
    context: {
      namespace,
    },
  });
});

import { implement } from "@orpc/server";
import { eventsContract } from "@iterate-com/events-contract";
import type { AppContext } from "~/context.ts";
import { defaultProjectSlug, resolveHostProjectSlug } from "~/lib/project-slug.ts";

export const os = implement(eventsContract).$context<AppContext>();

// oRPC middleware is the boundary for request-derived context like headers, so
// handlers can depend on validated context instead of reading Request globals:
// https://orpc.dev/docs/middleware
export const withProject = os.middleware(({ context, next }) => {
  const requestUrl = context.rawRequest?.url;
  const projectSlug =
    (requestUrl ? resolveHostProjectSlug(new URL(requestUrl).hostname) : undefined) ??
    defaultProjectSlug;

  return next({
    context: {
      projectSlug,
    },
  });
});

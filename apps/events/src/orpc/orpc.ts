import { ORPCError, implement } from "@orpc/server";
import { eventsContract, ProjectSlug } from "@iterate-com/events-contract";
import type { AppContext } from "~/context.ts";
import {
  defaultProjectSlug,
  iterateProjectHeader,
  resolveProjectSlug,
} from "~/lib/project-slug.ts";

export const os = implement(eventsContract).$context<AppContext>();

// oRPC middleware is the boundary for request-derived context like headers, so
// handlers can depend on validated context instead of reading Request globals:
// https://orpc.dev/docs/middleware
export const withProject = os.middleware(({ context, next }) => {
  const rawProjectSlug = resolveProjectSlug({
    url: context.rawRequest?.url,
    headerValue: context.rawRequest?.headers.get(iterateProjectHeader) ?? defaultProjectSlug,
  });
  const parsedProjectSlug = ProjectSlug.safeParse(rawProjectSlug);

  if (!parsedProjectSlug.success) {
    throw new ORPCError("BAD_REQUEST", {
      message: "X-Iterate-Project must be a non-empty string up to 255 characters.",
      data: {
        issues: parsedProjectSlug.error.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      },
    });
  }

  return next({
    context: {
      projectSlug: parsedProjectSlug.data,
    },
  });
});

import { ORPCError, implement } from "@orpc/server";
import { eventsContract, StreamNamespace } from "@iterate-com/events-contract";
import type { AppContext } from "~/context.ts";

export const os = implement(eventsContract).$context<AppContext>();

const iterateNamespaceHeader = "x-iterate-namespace";
const defaultStreamNamespace = "public";

// oRPC middleware is the boundary for request-derived context like headers, so
// handlers can depend on validated context instead of reading Request globals:
// https://orpc.dev/docs/middleware
export const withNamespace = os.middleware(({ context, next }) => {
  const rawNamespace =
    context.rawRequest?.headers.get(iterateNamespaceHeader) ?? defaultStreamNamespace;
  const parsedNamespace = StreamNamespace.safeParse(rawNamespace);

  if (!parsedNamespace.success) {
    throw new ORPCError("BAD_REQUEST", {
      message: "X-Iterate-Namespace must be a non-empty string up to 255 characters.",
      data: {
        issues: parsedNamespace.error.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      },
    });
  }

  return next({
    context: {
      namespace: parsedNamespace.data,
    },
  });
});

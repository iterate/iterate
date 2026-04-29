import { ORPCError, implement } from "@orpc/server";
import { osContract } from "@iterate-com/os2-contract";
import type { AppContext } from "~/context.ts";
import { normalizeActiveOrganizationAuth } from "~/lib/auth.ts";

export const os = implement(osContract).$context<AppContext>();

export const activeOrganizationMiddleware = os.middleware(async ({ context, next }) => {
  if (!context.auth?.isAuthenticated) {
    throw new ORPCError("UNAUTHORIZED");
  }

  if (!context.auth.orgId || !context.auth.orgSlug) {
    throw new ORPCError("FORBIDDEN", {
      message: "OS2 requires an active Clerk Organization.",
    });
  }

  return next({
    context: {
      activeOrganization: normalizeActiveOrganizationAuth(context.auth),
    },
  });
});

import { ORPCError, implement } from "@orpc/server";
import { osContract } from "@iterate-com/os2-contract";
import type { AppContext } from "~/context.ts";
import {
  type ActiveOrganizationAuth,
  normalizeActiveOrganizationAuth,
} from "~/lib/active-organization-auth.ts";

export const os = implement(osContract).$context<AppContext>();

const adminApiActiveOrganization: ActiveOrganizationAuth = {
  isAdminApi: true,
  orgId: "org_admin_api",
  orgPermissions: ["admin:api"],
  orgRole: "admin",
  orgSlug: "admin-api",
  sessionId: "admin-api-secret",
  userId: "user_admin_api",
};

function readBearerToken(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const match = /^bearer\s+(.+)$/i.exec(headerValue);
  if (!match) return null;
  const token = match[1]?.trim() ?? "";
  return token.length > 0 ? token : null;
}

function authenticateAdminApiSecret(context: AppContext): ActiveOrganizationAuth | null {
  const expectedToken = context.config.adminApiSecret?.exposeSecret();
  const providedToken = readBearerToken(context.rawRequest?.headers.get("authorization") ?? null);

  if (!expectedToken || !providedToken || providedToken !== expectedToken) {
    return null;
  }

  return adminApiActiveOrganization;
}

export const activeOrganizationMiddleware = os.middleware(async ({ context, next }) => {
  if (context.auth?.isAuthenticated && context.auth.orgId && context.auth.orgSlug) {
    return next({
      context: {
        activeOrganization: normalizeActiveOrganizationAuth(context.auth),
      },
    });
  }

  // Preview and operator automation should exercise the same public oRPC
  // procedures as the UI. A valid admin bearer token therefore creates a small
  // synthetic active organization instead of introducing one-off seed routes.
  const adminApiOrganization = authenticateAdminApiSecret(context);
  if (adminApiOrganization) {
    return next({
      context: {
        activeOrganization: adminApiOrganization,
      },
    });
  }

  if (context.auth?.isAuthenticated) {
    throw new ORPCError("FORBIDDEN", {
      message: "OS2 requires an active Clerk Organization.",
    });
  }

  throw new ORPCError("UNAUTHORIZED");
});

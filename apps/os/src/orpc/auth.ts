import type { AppContext } from "~/context.ts";
import {
  type ActiveOrganizationAuth,
  normalizeActiveOrganizationAuth,
} from "~/lib/active-organization-auth.ts";
import { authenticateAdminApiSecret } from "~/auth/middleware.ts";

const adminApiActiveOrganization: ActiveOrganizationAuth = {
  isAdminApi: true,
  orgId: "org_admin_api",
  orgPermissions: ["admin:api"],
  orgRole: "admin",
  orgSlug: "admin-api",
  sessionId: "admin-api-secret",
  userId: "user_admin_api",
};

export function isAdminApiSecretRequest(context: Pick<AppContext, "config">, request: Request) {
  return authenticateAdminApiSecret(context, request)?.type === "admin";
}

export function resolveActiveOrganizationAuth(context: AppContext): ActiveOrganizationAuth | null {
  if (context.principal?.type === "user" && context.principal.organizations.length > 0) {
    return normalizeActiveOrganizationAuth(context.principal);
  }

  // Preview and operator automation should exercise the same public oRPC
  // procedures as the UI. A valid admin bearer token therefore creates a small
  // synthetic active organization instead of introducing one-off seed routes.
  if (context.principal?.type === "admin") {
    return adminApiActiveOrganization;
  }

  if (context.rawRequest && authenticateAdminApiSecret(context, context.rawRequest)) {
    return adminApiActiveOrganization;
  }

  return null;
}

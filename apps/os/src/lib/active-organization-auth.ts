import { authenticateAdminApiSecret } from "~/auth/admin.ts";
import type { Principal, UserPrincipal } from "~/auth/principal.ts";
import type { AppContext } from "~/context.ts";

export interface ActiveOrganizationAuth {
  isAdminApi?: boolean;
  userId: string;
  sessionId: string;
  orgId: string;
  orgRole: string | null;
  orgSlug: string;
  orgPermissions: string[];
}

export const adminApiActiveOrganization: ActiveOrganizationAuth = {
  isAdminApi: true,
  orgId: "org_admin_api",
  orgPermissions: ["admin:api"],
  orgRole: "admin",
  orgSlug: "admin-api",
  sessionId: "admin-api-secret",
  userId: "user_admin_api",
};

export function getUserPrincipal(principal: Principal | null | undefined): UserPrincipal | null {
  return principal?.type === "user" ? principal : null;
}

export function getUserOrganization(
  principal: UserPrincipal,
  organizationSlug?: string,
): UserPrincipal["organizations"][number] | null {
  if (organizationSlug) {
    return principal.organizations.find((org) => org.slug === organizationSlug) ?? null;
  }

  return principal.organizations[0] ?? null;
}

export function withActiveOrganization(
  principal: UserPrincipal,
  organizationSlug?: string,
): UserPrincipal | null {
  const organization = getUserOrganization(principal, organizationSlug);
  if (!organization) return null;

  return {
    ...principal,
    organizations: [
      organization,
      ...principal.organizations.filter((org) => org.id !== organization.id),
    ],
  };
}

export function normalizeActiveOrganizationAuth(principal: UserPrincipal): ActiveOrganizationAuth {
  const organization = principal.organizations[0];
  if (!organization) {
    throw new Error("Expected authenticated user principal with an organization.");
  }

  return {
    userId: principal.userId,
    sessionId: principal.sessionId ?? principal.userId,
    orgId: organization.id,
    orgRole: organization.role,
    orgSlug: organization.slug,
    orgPermissions: [],
  };
}

export function resolveActiveOrganizationAuth(
  context: Pick<AppContext, "config" | "principal" | "rawRequest">,
): ActiveOrganizationAuth | null {
  const userPrincipal = getUserPrincipal(context.principal);
  if (userPrincipal?.organizations.length) {
    return normalizeActiveOrganizationAuth(userPrincipal);
  }

  if (context.principal?.type === "admin") {
    return adminApiActiveOrganization;
  }

  if (context.rawRequest && authenticateAdminApiSecret(context, context.rawRequest)) {
    return adminApiActiveOrganization;
  }

  return null;
}

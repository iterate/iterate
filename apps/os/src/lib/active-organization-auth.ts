import type { UserPrincipal } from "~/auth/principal.ts";

export interface ActiveOrganizationAuth {
  isAdminApi?: boolean;
  userId: string;
  sessionId: string;
  orgId: string;
  orgRole: string | null;
  orgSlug: string;
  orgPermissions: string[];
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

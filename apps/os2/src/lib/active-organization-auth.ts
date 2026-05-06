import type { ClerkAuth } from "~/context.ts";

export interface ActiveOrganizationAuth {
  isAdminApi?: boolean;
  userId: string;
  sessionId: string;
  orgId: string;
  orgRole: string | null;
  orgSlug: string;
  orgPermissions: string[];
}

export function normalizeActiveOrganizationAuth(session: ClerkAuth): ActiveOrganizationAuth {
  if (!session.isAuthenticated || !session.orgId || !session.orgSlug) {
    throw new Error("Expected authenticated Clerk session with active organization.");
  }

  return {
    userId: session.userId,
    sessionId: session.sessionId,
    orgId: session.orgId,
    orgRole: session.orgRole ?? null,
    orgSlug: session.orgSlug,
    orgPermissions: session.orgPermissions ?? [],
  };
}

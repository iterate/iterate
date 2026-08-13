import type { AuthenticatedIdentity } from "@iterate-com/auth/server";
import {
  type IterateAuthAccessTokenOrganizationClaim,
  type IterateAuthProjectClaim,
} from "@iterate-com/shared/auth-claims";

export type UserPrincipal = {
  type: "user";
  userId: string;
  sessionId?: string;
  /** The user's verified login email, when the token/session carried one.
   * Used to seed per-project state that wants the owner's address (e.g. the
   * project email sender allowlist). */
  email?: string;
  isAdmin: boolean;
  organizations: IterateAuthAccessTokenOrganizationClaim[];
  projects: IterateAuthProjectClaim[];
};

export type AdminPrincipal = {
  type: "admin";
};

export type Principal = UserPrincipal | AdminPrincipal;

export const adminPrincipal: AdminPrincipal = {
  type: "admin",
};

export function getUserPrincipal(principal: Principal | null | undefined): UserPrincipal | null {
  return principal?.type === "user" ? principal : null;
}

export function createUserPrincipal(input: {
  userId: string;
  sessionId?: string;
  email?: string;
  isAdmin?: boolean;
  organizations: IterateAuthAccessTokenOrganizationClaim[];
  projects: IterateAuthProjectClaim[];
}): UserPrincipal {
  return {
    type: "user",
    userId: input.userId,
    sessionId: input.sessionId,
    ...(input.email && { email: input.email }),
    isAdmin: input.isAdmin ?? false,
    organizations: input.organizations,
    projects: input.projects,
  };
}

/** Adapt auth's credential-independent identity to OS capability authority. */
export function principalFromIdentity(identity: AuthenticatedIdentity): UserPrincipal {
  return createUserPrincipal({
    userId: identity.userId,
    sessionId: identity.sessionId,
    email: identity.email,
    isAdmin: identity.isAdmin,
    organizations: identity.organizations,
    projects: identity.projects,
  });
}

export function principalIsAdmin(principal: Principal): boolean {
  return principal.type === "admin" || principal.isAdmin;
}

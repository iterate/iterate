import type { AccessTokenClaims, AuthenticatedSession } from "@iterate-com/auth/server";
import {
  ITERATE_ACCESS_TOKEN_ORGANIZATIONS_CLAIM,
  ITERATE_ACCESS_TOKEN_PROJECTS_CLAIM,
  ITERATE_IS_ADMIN_CLAIM,
  ITERATE_ROLE_CLAIM,
  type IterateAuthAccessTokenOrganizationClaim,
  type IterateAuthProjectClaim,
} from "@iterate-com/shared/auth-claims";

export type UserPrincipal = {
  type: "user";
  userId: string;
  sessionId?: string;
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
  isAdmin?: boolean;
  organizations: IterateAuthAccessTokenOrganizationClaim[];
  projects: IterateAuthProjectClaim[];
}): UserPrincipal {
  return {
    type: "user",
    userId: input.userId,
    sessionId: input.sessionId,
    isAdmin: input.isAdmin ?? false,
    organizations: input.organizations,
    projects: input.projects,
  };
}

export function principalFromSession(session: AuthenticatedSession): UserPrincipal {
  return createUserPrincipal({
    userId: session.user.id,
    sessionId: session.session.sessionId,
    isAdmin: isAdminRole(session.user),
    organizations: session.session.organizations.map((organization) => ({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      role: organization.role,
    })),
    projects: session.session.projects,
  });
}

export function principalFromAccessToken(accessToken: AccessTokenClaims): UserPrincipal {
  return createUserPrincipal({
    userId: accessToken.sub,
    sessionId: accessToken.sid,
    isAdmin: isAdminRole({
      isAdmin: accessToken[ITERATE_IS_ADMIN_CLAIM],
      role: accessToken[ITERATE_ROLE_CLAIM],
    }),
    organizations: accessToken[ITERATE_ACCESS_TOKEN_ORGANIZATIONS_CLAIM] ?? [],
    projects: accessToken[ITERATE_ACCESS_TOKEN_PROJECTS_CLAIM] ?? [],
  });
}

export function principalIsAdmin(principal: Principal): boolean {
  return principal.type === "admin" || principal.isAdmin;
}

function isAdminRole(input: { isAdmin?: unknown; role?: unknown } | null | undefined): boolean {
  return input?.isAdmin === true || input?.role === "admin";
}

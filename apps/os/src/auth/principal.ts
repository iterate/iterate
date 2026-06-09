import type { AccessTokenClaims, AuthenticatedSession } from "@iterate-com/auth/server";
import {
  ITERATE_ACCESS_TOKEN_ORGANIZATIONS_CLAIM,
  ITERATE_ACCESS_TOKEN_PROJECTS_CLAIM,
  type IterateAuthAccessTokenOrganizationClaim,
  type IterateAuthProjectClaim,
} from "@iterate-com/shared/auth-claims";

export type PrincipalResource = {
  projectId?: string;
  orgId?: string;
};

export type UserPrincipal = {
  type: "user";
  userId: string;
  sessionId?: string;
  organizations: IterateAuthAccessTokenOrganizationClaim[];
  projects: IterateAuthProjectClaim[];
  can(action: string, resource?: PrincipalResource): boolean;
};

export type AdminPrincipal = {
  type: "admin";
  can(): true;
};

export type Principal = UserPrincipal | AdminPrincipal;

export const adminPrincipal: AdminPrincipal = {
  type: "admin",
  can: () => true,
};

export function getUserPrincipal(principal: Principal | null | undefined): UserPrincipal | null {
  return principal?.type === "user" ? principal : null;
}

export function createUserPrincipal(input: {
  userId: string;
  sessionId?: string;
  organizations: IterateAuthAccessTokenOrganizationClaim[];
  projects: IterateAuthProjectClaim[];
}): UserPrincipal {
  return {
    type: "user",
    userId: input.userId,
    sessionId: input.sessionId,
    organizations: input.organizations,
    projects: input.projects,
    can: (_action, resource) => canAccessResource(input, resource),
  };
}

export function principalFromSession(session: AuthenticatedSession): UserPrincipal {
  return createUserPrincipal({
    userId: session.user.id,
    sessionId: session.session.sessionId,
    organizations: session.session.organizations.map((organization) => ({
      id: organization.id,
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
    organizations: accessToken[ITERATE_ACCESS_TOKEN_ORGANIZATIONS_CLAIM] ?? [],
    projects: accessToken[ITERATE_ACCESS_TOKEN_PROJECTS_CLAIM] ?? [],
  });
}

function canAccessResource(
  principal: Pick<UserPrincipal, "organizations" | "projects">,
  resource: PrincipalResource | undefined,
) {
  if (!resource?.orgId && !resource?.projectId) return true;

  if (resource.orgId && principal.organizations.some((org) => org.id === resource.orgId)) {
    return true;
  }

  if (
    resource.projectId &&
    principal.projects.some((project) => project.id === resource.projectId)
  ) {
    return true;
  }

  return false;
}

import { z } from "zod/v4";

export const ITERATE_IS_ADMIN_CLAIM = "https://iterate.com/claims/is_admin";
export const ITERATE_ROLE_CLAIM = "https://iterate.com/claims/role";
export const ITERATE_ACTIVE_ORGANIZATION_ID_CLAIM =
  "https://iterate.com/claims/active_organization_id";
export const ITERATE_ORGANIZATIONS_CLAIM = "https://iterate.com/claims/organizations";
export const ITERATE_ACCESS_TOKEN_ORGANIZATIONS_CLAIM = "organizations";
export const ITERATE_ACCESS_TOKEN_PROJECTS_CLAIM = "projects";
export const ITERATE_PROJECT_SELECTION_SCOPE = "project";
export const ITERATE_PROJECT_SCOPE_PREFIX = `${ITERATE_PROJECT_SELECTION_SCOPE}:` as const;
// Server-granted only: the auth worker strips this scope from tokens unless the
// user's role is "admin", and OS grants it to admin-API-secret callers.
export const ITERATE_SUPERADMIN_SCOPE = "superadmin";

export const IterateAuthOrganizationClaim = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  role: z.enum(["member", "admin", "owner"]),
});
export type IterateAuthOrganizationClaim = z.infer<typeof IterateAuthOrganizationClaim>;

export const IterateAuthAccessTokenOrganizationClaim = IterateAuthOrganizationClaim.extend({
  name: z.string().optional(),
});
export type IterateAuthAccessTokenOrganizationClaim = z.infer<
  typeof IterateAuthAccessTokenOrganizationClaim
>;

export const IterateAuthProjectClaim = z.object({
  id: z.string(),
  slug: z.string(),
  organizationId: z.string(),
});
export type IterateAuthProjectClaim = z.infer<typeof IterateAuthProjectClaim>;

export function listProjectScopeIds(scopes: Iterable<string>) {
  const projectIds = new Set<string>();

  for (const scope of scopes) {
    if (!scope.startsWith(ITERATE_PROJECT_SCOPE_PREFIX)) {
      continue;
    }

    const projectId = scope.slice(ITERATE_PROJECT_SCOPE_PREFIX.length).trim();
    if (projectId.length === 0) {
      continue;
    }

    projectIds.add(projectId);
  }

  return Array.from(projectIds);
}

export function hasSuperadminScope(scopes: Iterable<string>) {
  for (const scope of scopes) {
    if (scope === ITERATE_SUPERADMIN_SCOPE) return true;
  }
  return false;
}

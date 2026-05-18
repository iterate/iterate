import { z } from "zod/v4";

export const ITERATE_IS_ADMIN_CLAIM = "https://iterate.com/claims/is_admin";
export const ITERATE_ROLE_CLAIM = "https://iterate.com/claims/role";
export const ITERATE_ACTIVE_ORGANIZATION_ID_CLAIM =
  "https://iterate.com/claims/active_organization_id";
export const ITERATE_ORGANIZATIONS_CLAIM = "https://iterate.com/claims/organizations";
export const ITERATE_PROJECT_SELECTION_SCOPE = "project";
export const ITERATE_PROJECT_SCOPE_PREFIX = `${ITERATE_PROJECT_SELECTION_SCOPE}:` as const;
const ITERATE_PROJECT_WILDCARD_SCOPE = `${ITERATE_PROJECT_SCOPE_PREFIX}*` as const;

export const IterateAuthOrganizationClaim = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  role: z.enum(["member", "admin", "owner"]),
});
export type IterateAuthOrganizationClaim = z.infer<typeof IterateAuthOrganizationClaim>;

export function listProjectScopeIds(scopes: Iterable<string>) {
  const projectIds = new Set<string>();

  for (const scope of scopes) {
    if (!scope.startsWith(ITERATE_PROJECT_SCOPE_PREFIX)) {
      continue;
    }

    const projectId = scope.slice(ITERATE_PROJECT_SCOPE_PREFIX.length).trim();
    if (projectId.length === 0 || projectId === "*") {
      continue;
    }

    projectIds.add(projectId);
  }

  return Array.from(projectIds);
}

export function hasWildcardProjectScope(scopes: Iterable<string>) {
  for (const scope of scopes) {
    if (scope === ITERATE_PROJECT_WILDCARD_SCOPE) return true;
  }
  return false;
}

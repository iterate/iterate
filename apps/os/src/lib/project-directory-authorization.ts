import type { Principal } from "~/auth/principal.ts";

/**
 * Decide whether a route may recover a missing project claim from the shared
 * project directory. A project-scoped operator's one claim is its complete
 * authority and may never be widened through organization membership.
 */
export function canReadDirectoryProject(input: {
  isProjectScopedOperator: boolean;
  principal: Principal | null | undefined;
  recordOrganizationId: string | null;
}): boolean {
  if (input.isProjectScopedOperator || !input.principal) return false;
  if (input.principal.type === "admin" || input.principal.isAdmin) return true;
  return input.principal.organizations.some(
    (organization) => organization.id === input.recordOrganizationId,
  );
}

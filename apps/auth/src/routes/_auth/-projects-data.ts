import { queryOptions } from "@tanstack/react-query";
import { orpcClient } from "../../utils/query.tsx";

type Organization = Awaited<ReturnType<typeof orpcClient.user.myOrganizations>>[number];
export type Project = Awaited<ReturnType<typeof orpcClient.project.list>>[number];
export type InventoryOrganization = Organization & { projects: Project[] };

export const organizationManagementSections = ["projects", "members", "invitations"] as const;
export type OrganizationManagementSection = (typeof organizationManagementSections)[number];

export function organizationMembersQueryKey(organizationId: string) {
  return ["better-auth", "organization", organizationId, "members"] as const;
}

export function organizationInvitationsQueryKey(organizationId: string) {
  return ["better-auth", "organization", organizationId, "invitations"] as const;
}

export function inventoryQueryOptions() {
  return queryOptions({
    queryKey: ["auth", "workspace-inventory"] as const,
    queryFn: loadInventory,
  });
}

async function loadInventory(): Promise<InventoryOrganization[]> {
  const organizations = await orpcClient.user.myOrganizations();
  return await Promise.all(
    organizations.map(async (organization) => ({
      ...organization,
      projects: await orpcClient.project.list({ organizationSlug: organization.slug }),
    })),
  );
}

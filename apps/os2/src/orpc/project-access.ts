import { ORPCError } from "@orpc/server";
import type { AppContext } from "~/context.ts";
import { getProjectById } from "~/db/queries/.generated/index.ts";
import type { ActiveOrganizationAuth } from "~/lib/active-organization-auth.ts";

/**
 * Confirms a project belongs to the caller's active Clerk organization before
 * exposing project-scoped capabilities such as Code Mode or stream access.
 */
export async function requireActiveOrganizationProject(input: {
  activeOrganization: ActiveOrganizationAuth;
  context: AppContext;
  projectId: string;
}) {
  const project = await getProjectById(input.context.db, {
    clerkOrgId: input.activeOrganization.orgId,
    id: input.projectId,
  });

  if (!project) {
    throw new ORPCError("NOT_FOUND", {
      message: `Project ${input.projectId} not found`,
    });
  }

  return project;
}

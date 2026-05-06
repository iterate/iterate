import { ORPCError } from "@orpc/server";
import type { AppContext } from "~/context.ts";
import { getProjectById, getProjectPermission } from "~/db/queries/.generated/index.ts";
import type { ActiveOrganizationAuth } from "~/lib/active-organization-auth.ts";

/**
 * Confirms a caller can access an ownerless project before exposing
 * project-scoped capabilities such as Code Mode or stream access. Projects are
 * deliberately not owned by Clerk organizations; the permission table is the
 * current claim/grant layer, and admin API callers bypass it for operator work.
 */
export async function requireActiveOrganizationProject(input: {
  activeOrganization: ActiveOrganizationAuth;
  context: AppContext;
  projectId: string;
}) {
  const project = await getProjectById(input.context.db, {
    id: input.projectId,
  });

  if (!project) {
    throw new ORPCError("NOT_FOUND", {
      message: `Project ${input.projectId} not found`,
    });
  }

  if (input.activeOrganization.isAdminApi) {
    return project;
  }

  const permission = await getProjectPermission(input.context.db, {
    principalId: input.activeOrganization.orgId,
    principalType: "clerk_organization",
    projectId: input.projectId,
  });

  if (!permission) {
    throw new ORPCError("NOT_FOUND", {
      message: `Project ${input.projectId} not found`,
    });
  }

  return project;
}

import { ORPCError } from "@orpc/server";
import { os, protectedMiddleware } from "../orpc.ts";
import {
  listOrganizationsForUser,
  listProjectsByOrganizationId,
  upsertOAuthProjectSelectionReturning,
} from "../../db/queries/index.ts";
import { toMembershipRole } from "../../records.ts";

const myOrganizations = os.user.myOrganizations
  .use(protectedMiddleware)
  .handler(async ({ context }) => {
    const memberships = await listOrganizationsForUser(context.db, {
      userId: context.user.id,
    });

    return memberships.map((membership) => ({
      id: membership.id,
      name: membership.name,
      slug: membership.slug,
      role: toMembershipRole(membership.role),
    }));
  });

// Step 1 of the OAuth project-selection handoff — see the walkthrough in
// ../../oauth-project-selection.ts. The /project-access page stores the
// user's chosen project ids here; token minting later narrows the token to
// them and deletes the row.
const storeOAuthProjectSelection = os.user.storeOAuthProjectSelection
  .use(protectedMiddleware)
  .handler(async ({ context, input }) => {
    const organizations = await listOrganizationsForUser(context.db, {
      userId: context.user.id,
    });

    const projectsByOrg = await Promise.all(
      organizations.map((organization) =>
        listProjectsByOrganizationId(context.db, { organizationId: organization.id }),
      ),
    );
    const accessibleProjectIds = new Set<string>(
      projectsByOrg.flatMap((projects) => projects.map((project) => project.id)),
    );

    const selectedProjectIds = Array.from(new Set(input.projectIds)).sort();
    const invalidProjectId = selectedProjectIds.find(
      (projectId) => !accessibleProjectIds.has(projectId),
    );
    if (invalidProjectId) {
      throw new ORPCError("FORBIDDEN", {
        message: `You do not have access to project ${invalidProjectId}`,
      });
    }

    const now = Date.now();
    await upsertOAuthProjectSelectionReturning(context.db, {
      sessionId: context.session.session.id,
      clientId: input.clientId,
      userId: context.user.id,
      projectIds: JSON.stringify(selectedProjectIds),
      createdAt: now,
      updatedAt: now,
    });

    return { success: true as const };
  });

export const user = os.user.router({
  myOrganizations,
  storeOAuthProjectSelection,
});

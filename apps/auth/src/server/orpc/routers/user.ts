import { ORPCError } from "@orpc/server";
import { os, protectedMiddleware } from "../orpc.ts";
import {
  listOrganizationsForUser,
  listProjectsByOrganizationId,
  upsertOAuthProjectSelectionReturning,
} from "../../db/queries/index.ts";
import { toMembershipRole, toUserRecord } from "./_shared.ts";

const me = os.user.me.handler(async ({ context }) => {
  if (context.session) {
    return toUserRecord(context.session.user);
  }

  if (context.projectIngressUser) {
    return toUserRecord(context.projectIngressUser);
  }

  throw new ORPCError("UNAUTHORIZED", { message: "Not authorized" });
});

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
  me,
  myOrganizations,
  storeOAuthProjectSelection,
});

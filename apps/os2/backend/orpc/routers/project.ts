import { z } from "zod/v4";
import { eq, and } from "drizzle-orm";
import { ORPCError, protectedProcedure, orgProtectedProcedure, projectProtectedProcedure, OrgInput, ProjectInput } from "../orpc.ts";
import { project, organizationUserMembership, organization } from "../../db/schema.ts";
import { generateSlug } from "../../utils/slug.ts";
import type { Context } from "../context.ts";

const orgLookup = async (
  db: Context["db"],
  organizationSlug: string,
  userId: string,
  userRole: string | null | undefined,
) => {
  const org = await db.query.organization.findFirst({
    where: eq(organization.slug, organizationSlug),
  });

  if (!org) {
    throw new ORPCError("NOT_FOUND", {
      message: `Organization with slug ${organizationSlug} not found`,
    });
  }

  const membership = await db.query.organizationUserMembership.findFirst({
    where: and(
      eq(organizationUserMembership.organizationId, org.id),
      eq(organizationUserMembership.userId, userId),
    ),
  });

  if (!membership && userRole !== "admin") {
    throw new ORPCError("FORBIDDEN", {
      message: "User does not have access to organization",
    });
  }

  return { org, membership };
};

const checkAdmin = (membership: { role: string } | undefined, userRole: string | null | undefined) => {
  if (userRole === "admin") return;
  const role = membership?.role;
  if (!role || (role !== "owner" && role !== "admin")) {
    throw new ORPCError("FORBIDDEN", {
      message: "Only owners and admins can perform this action",
    });
  }
};

export const projectRouter = {
  list: orgProtectedProcedure.handler(async ({ context }) => {
    const projects = await context.db.query.project.findMany({
      where: eq(project.organizationId, context.organization.id),
      orderBy: (proj, { desc }) => [desc(proj.createdAt)],
    });

    return projects;
  }),

  bySlug: projectProtectedProcedure.handler(async ({ context }) => {
    return context.project;
  }),

  create: protectedProcedure
    .input(OrgInput.extend({ name: z.string().min(1).max(100) }))
    .handler(async ({ context, input }) => {
      const { org, membership } = await orgLookup(context.db, input.organizationSlug, context.user.id, context.user.role);
      checkAdmin(membership, context.user.role);

      const slug = generateSlug(input.name);

      const [newProject] = await context.db
        .insert(project)
        .values({
          name: input.name,
          slug,
          organizationId: org.id,
        })
        .returning();

      if (!newProject) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message: "Failed to create project",
        });
      }

      return newProject;
    }),

  update: protectedProcedure
    .input(ProjectInput.extend({ name: z.string().min(1).max(100).optional() }))
    .handler(async ({ context, input }) => {
      const { org } = await orgLookup(context.db, input.organizationSlug, context.user.id, context.user.role);

      const proj = await context.db.query.project.findFirst({
        where: and(eq(project.organizationId, org.id), eq(project.slug, input.projectSlug)),
      });

      if (!proj) {
        throw new ORPCError("NOT_FOUND", {
          message: "Project not found",
        });
      }

      const [updated] = await context.db
        .update(project)
        .set({
          ...(input.name && { name: input.name }),
        })
        .where(eq(project.id, proj.id))
        .returning();

      return updated;
    }),

  delete: projectProtectedProcedure.handler(async ({ context }) => {
    const projectCount = await context.db.query.project.findMany({
      where: eq(project.organizationId, context.organization.id),
    });

    if (projectCount.length <= 1) {
      throw new ORPCError("FORBIDDEN", {
        message: "Cannot delete the last project in an organization",
      });
    }

    await context.db.delete(project).where(eq(project.id, context.project.id));

    return { success: true };
  }),
};

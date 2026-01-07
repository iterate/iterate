import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, orgProtectedProcedure, projectProtectedProcedure, orgAdminProcedure } from "../trpc.ts";
import { project } from "../../db/schema.ts";
import { generateSlug } from "../../utils/slug.ts";

export const projectRouter = router({
  // List projects in organization
  list: orgProtectedProcedure.query(async ({ ctx }) => {
    const projects = await ctx.db.query.project.findMany({
      where: eq(project.organizationId, ctx.organization.id),
      orderBy: (proj, { desc }) => [desc(proj.createdAt)],
    });

    return projects;
  }),

  // Get project by slug
  bySlug: projectProtectedProcedure.query(async ({ ctx }) => {
    return ctx.project;
  }),

  // Create a new project
  create: orgAdminProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const slug = generateSlug(input.name);

      const [newProject] = await ctx.db
        .insert(project)
        .values({
          name: input.name,
          slug,
          organizationId: ctx.organization.id,
        })
        .returning();

      if (!newProject) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create project",
        });
      }

      return newProject;
    }),

  // Update project settings
  update: projectProtectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(project)
        .set({
          ...(input.name && { name: input.name }),
        })
        .where(eq(project.id, ctx.project.id))
        .returning();

      return updated;
    }),

  // Delete project
  delete: projectProtectedProcedure.mutation(async ({ ctx }) => {
    // Check if this is the last project in the organization
    const projectCount = await ctx.db.query.project.findMany({
      where: eq(project.organizationId, ctx.organization.id),
    });

    if (projectCount.length <= 1) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Cannot delete the last project in an organization",
      });
    }

    await ctx.db.delete(project).where(eq(project.id, ctx.project.id));

    return { success: true };
  }),
});

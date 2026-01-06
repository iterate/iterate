import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { router, orgProtectedProcedure, projectProtectedProcedure } from "../trpc.ts";
import { project } from "../../db/schema.ts";
import { generateProjectSlug } from "../../utils/slug.ts";

export const projectRouter = router({
  list: orgProtectedProcedure.query(async ({ ctx }) => {
    return ctx.db.query.project.findMany({
      where: eq(project.organizationId, ctx.organization.id),
    });
  }),

  create: orgProtectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        slug: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const slug = input.slug || generateProjectSlug(input.name);

      const [proj] = await ctx.db
        .insert(project)
        .values({
          name: input.name,
          slug,
          organizationId: ctx.organization.id,
        })
        .returning();

      return proj;
    }),

  get: projectProtectedProcedure.query(async ({ ctx }) => {
    return ctx.project;
  }),

  update: projectProtectedProcedure
    .input(
      z.object({
        name: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(project)
        .set(input)
        .where(eq(project.id, ctx.project.id))
        .returning();

      return updated;
    }),

  delete: projectProtectedProcedure.mutation(async ({ ctx }) => {
    await ctx.db.delete(project).where(eq(project.id, ctx.project.id));
    return { success: true };
  }),
});

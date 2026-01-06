import { z } from "zod/v4";
import { eq, and } from "drizzle-orm";
import { router, protectedProcedure, orgProtectedProcedure, orgAdminProcedure } from "../trpc.ts";
import { organization, organizationUserMembership, UserRole } from "../../db/schema.ts";
import { generateSlugFromEmail } from "../../utils/slug.ts";

export const organizationRouter = router({
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        slug: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const slug = input.slug || generateSlugFromEmail(ctx.user.email);

      const [org] = await ctx.db
        .insert(organization)
        .values({ name: input.name, slug })
        .returning();

      await ctx.db.insert(organizationUserMembership).values({
        organizationId: org.id,
        userId: ctx.user.id,
        role: "owner",
      });

      return org;
    }),

  get: orgProtectedProcedure.query(async ({ ctx }) => {
    return ctx.organization;
  }),

  update: orgAdminProcedure
    .input(
      z.object({
        name: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(organization)
        .set(input)
        .where(eq(organization.id, ctx.organization.id))
        .returning();

      return updated;
    }),

  members: orgProtectedProcedure.query(async ({ ctx }) => {
    const members = await ctx.db.query.organizationUserMembership.findMany({
      where: eq(organizationUserMembership.organizationId, ctx.organization.id),
      with: {
        user: true,
      },
    });

    return members;
  }),

  updateMemberRole: orgAdminProcedure
    .input(
      z.object({
        userId: z.string(),
        role: z.enum(UserRole),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(organizationUserMembership)
        .set({ role: input.role })
        .where(
          and(
            eq(organizationUserMembership.organizationId, ctx.organization.id),
            eq(organizationUserMembership.userId, input.userId),
          ),
        )
        .returning();

      return updated;
    }),

  removeMember: orgAdminProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .delete(organizationUserMembership)
        .where(
          and(
            eq(organizationUserMembership.organizationId, ctx.organization.id),
            eq(organizationUserMembership.userId, input.userId),
          ),
        );

      return { success: true };
    }),
});

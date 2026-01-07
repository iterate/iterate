import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { router, protectedProcedure } from "../trpc.ts";
import { user, organizationUserMembership } from "../../db/schema.ts";

export const userRouter = router({
  // Get current user
  me: protectedProcedure.query(async ({ ctx }) => {
    return ctx.user;
  }),

  // Get user's organizations
  myOrganizations: protectedProcedure.query(async ({ ctx }) => {
    const memberships = await ctx.db.query.organizationUserMembership.findMany({
      where: eq(organizationUserMembership.userId, ctx.user.id),
      with: {
        organization: {
          with: {
            instances: true,
          },
        },
      },
    });

    return memberships.map((m) => ({
      ...m.organization,
      role: m.role,
    }));
  }),

  // Update user settings
  updateSettings: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).optional(),
        image: z.string().url().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(user)
        .set({
          ...(input.name && { name: input.name }),
          ...(input.image && { image: input.image }),
        })
        .where(eq(user.id, ctx.user.id))
        .returning();

      return updated;
    }),
});

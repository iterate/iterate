import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { router, protectedProcedure, getUserOrganizationsWithInstances } from "../trpc.ts";
import * as schema from "../../db/schema.ts";

export const userRouter = router({
  me: protectedProcedure.query(async ({ ctx }) => {
    return ctx.user;
  }),

  getOrganizations: protectedProcedure.query(async ({ ctx }) => {
    const memberships = await getUserOrganizationsWithInstances(ctx.db, ctx.user.id);
    return memberships.map((m) => ({
      ...m.organization,
      role: m.role,
      instances: m.organization.instances,
    }));
  }),

  updateProfile: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(schema.user)
        .set({
          name: input.name,
        })
        .where(eq(schema.user.id, ctx.user.id))
        .returning();
      return updated;
    }),
});

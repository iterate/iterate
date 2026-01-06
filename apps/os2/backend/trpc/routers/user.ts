import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { router, protectedProcedure, getUserOrganizationsWithProjects } from "../trpc.ts";
import { user } from "../../db/schema.ts";

export const userRouter = router({
  me: protectedProcedure.query(async ({ ctx }) => {
    return ctx.user;
  }),

  update: protectedProcedure
    .input(
      z.object({
        name: z.string().optional(),
        debugMode: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(user)
        .set(input)
        .where(eq(user.id, ctx.user.id))
        .returning();

      return updated;
    }),

  organizationsWithProjects: protectedProcedure.query(async ({ ctx }) => {
    return getUserOrganizationsWithProjects(ctx.db, ctx.user.id);
  }),
});

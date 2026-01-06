import { z } from "zod/v4";
import { router, adminProcedure, protectedProcedure } from "../trpc.ts";

export const adminRouter = router({
  getSessionInfo: protectedProcedure.query(async ({ ctx }) => {
    return {
      user: ctx.user,
      session: ctx.session,
    };
  }),

  impersonate: adminProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const targetUser = await ctx.db.query.user.findFirst({
        where: (user, { eq }) => eq(user.id, input.userId),
      });

      if (!targetUser) {
        throw new Error("User not found");
      }

      return { success: true, targetUser };
    }),

  stopImpersonating: protectedProcedure.mutation(async () => {
    return { success: true };
  }),

  listUsers: adminProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(50),
        offset: z.number().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      const users = await ctx.db.query.user.findMany({
        limit: input.limit,
        offset: input.offset,
        orderBy: (user, { desc }) => [desc(user.createdAt)],
      });

      return users;
    }),

  listOrganizations: adminProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(50),
        offset: z.number().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      const organizations = await ctx.db.query.organization.findMany({
        limit: input.limit,
        offset: input.offset,
        orderBy: (org, { desc }) => [desc(org.createdAt)],
        with: {
          instances: true,
          members: {
            with: {
              user: true,
            },
          },
        },
      });

      return organizations;
    }),
});

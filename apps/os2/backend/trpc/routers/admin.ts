import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { router, adminProcedure, protectedProcedure } from "../trpc.ts";
import { user, session } from "../../db/schema.ts";

export const adminRouter = router({
  impersonate: adminProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const targetUser = await ctx.db.query.user.findFirst({
        where: eq(user.id, input.userId),
      });

      if (!targetUser) {
        throw new Error("User not found");
      }

      await ctx.db
        .update(session)
        .set({ impersonatedBy: ctx.user.id, userId: input.userId })
        .where(eq(session.id, ctx.session.session.id));

      return { success: true, user: targetUser };
    }),

  stopImpersonating: protectedProcedure.mutation(async ({ ctx }) => {
    if (!ctx.session.session.impersonatedBy) {
      throw new Error("Not impersonating anyone");
    }

    await ctx.db
      .update(session)
      .set({ impersonatedBy: null, userId: ctx.session.session.impersonatedBy })
      .where(eq(session.id, ctx.session.session.id));

    return { success: true };
  }),

  listUsers: adminProcedure.query(async ({ ctx }) => {
    return ctx.db.query.user.findMany({
      orderBy: (u, { desc }) => desc(u.createdAt),
      limit: 100,
    });
  }),
});

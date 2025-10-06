import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { protectedProcedure, router } from "../trpc.ts";
import { user } from "../../db/schema.ts";

export const userRouter = router({
  // Get current user information
  me: protectedProcedure.query(async ({ ctx }) => {
    return ctx.user;
  }),

  // Update user profile
  updateProfile: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1, "Name cannot be empty").max(100, "Name too long").optional(),
        debugMode: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;

      // Update the user
      const [updatedUser] = await ctx.db
        .update(user)
        .set(input)
        .where(eq(user.id, userId))
        .returning();

      if (!updatedUser) {
        throw new Error("Failed to update user");
      }

      return updatedUser;
    }),
});

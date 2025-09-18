import { protectedProcedure, router } from "../trpc.ts";

export const userRouter = router({
  // Get current user information
  me: protectedProcedure.query(async ({ ctx }) => {
    return {
      id: ctx.user.id,
      name: ctx.user.name,
      email: ctx.user.email,
      image: ctx.user.image,
      emailVerified: ctx.user.emailVerified,
    };
  }),
});

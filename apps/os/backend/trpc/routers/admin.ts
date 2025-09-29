import { z } from "zod";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../trpc.ts";
import { schema } from "../../db/client.ts";

const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You are not authorized to access this resource",
    });
  }
  return next({ ctx });
});

const findUserByEmail = adminProcedure
  .input(z.object({ email: z.string() }))
  .query(async ({ ctx, input }) => {
    const user = await ctx.db.query.user.findFirst({
      where: eq(schema.user.email, input.email),
    });
    return user;
  });

export const adminRouter = router({
  findUserByEmail,
  impersonationInfo: protectedProcedure.query(async ({ ctx }) => {
    // || undefined means non-admins and non-impersonated users get `{}` from this endpoint, revealing no information
    // important because it's available to anyone signed in
    const impersonatedBy = ctx?.session?.session.impersonatedBy || undefined;
    const isAdmin = ctx?.user?.role === "admin" || undefined;
    return { impersonatedBy, isAdmin };
  }),
});

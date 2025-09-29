import { z } from "zod";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, publicProcedure, router } from "../trpc.ts";
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
  impersonationInfo: publicProcedure.query(async ({ ctx }) => {
    const isImpersonating = Boolean(ctx?.session?.session.impersonatedBy);
    const impersonatedBy = ctx?.session?.session.impersonatedBy || undefined;
    const isAdmin = ctx?.user?.role === "admin";
    return { isImpersonating, impersonatedBy, isAdmin };
  }),
  checkAuth: publicProcedure.query(async ({ ctx }) => {
    if (ctx?.user?.role === "admin") {
      return { message: "admin" as const, user: ctx.user, session: ctx.session };
    }
    if (!ctx?.user?.email) {
      return { message: "not_logged_in" as const };
    }
    return {
      message: "logged_in" as const,
      impersonatedBy: ctx?.session?.session.impersonatedBy || undefined,
    };
  }),
});

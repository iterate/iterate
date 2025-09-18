import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { organizationUserMembership } from "../db/schema.ts";
import type { DB } from "../db/client.ts";
import type { Context } from "./context.ts";

const t = initTRPC.context<Context>().create();

// Base router and procedure helpers
export const router = t.router;
export const publicProcedure = t.procedure;

// Protected procedure that requires authentication
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session || !ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({
    ctx: {
      ...ctx,
      session: ctx.session,
      user: ctx.user,
    },
  });
});

// Helper function to get user's estate if they have access
export async function getUserEstateAccess(
  db: DB,
  userId: string,
  estateId: string,
  organizationId?: string,
): Promise<{ hasAccess: boolean; estate: any | null }> {
  const userWithEstates = await db.query.organizationUserMembership.findFirst({
    where: eq(organizationUserMembership.userId, userId),
    with: {
      organization: {
        with: {
          estates: true,
        },
      },
    },
  });

  if (!userWithEstates?.organization?.estates) {
    return { hasAccess: false, estate: null };
  }

  // Check if the estate belongs to the user's organization
  const userEstate = userWithEstates.organization.estates.find((e: any) => e.id === estateId);

  if (!userEstate) {
    return { hasAccess: false, estate: null };
  }

  // If organizationId is provided, verify it matches
  if (organizationId && userEstate.organizationId !== organizationId) {
    return { hasAccess: false, estate: null };
  }

  return { hasAccess: true, estate: userEstate };
}

// Estate protected procedure that requires both authentication and estate access
export const estateProtectedProcedure = protectedProcedure
  .input(z.object({ estateId: z.string() }))
  .use(async ({ ctx, input, next }) => {
    const { hasAccess, estate: userEstate } = await getUserEstateAccess(
      ctx.db,
      ctx.user.id,
      input.estateId,
    );

    if (!hasAccess || !userEstate) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Access denied: User does not have permission to access this estate",
      });
    }

    // Pass the estate data to the next middleware/resolver
    return next({
      ctx: {
        ...ctx,
        estate: userEstate,
      },
    });
  });

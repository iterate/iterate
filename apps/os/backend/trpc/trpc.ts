import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { organizationUserMembership } from "../db/schema.ts";
import type { DB } from "../db/client.ts";
import { invalidateOrganizationQueries, notifyOrganization } from "../utils/websocket-utils.ts";
import type { Context } from "./context.ts";

const t = initTRPC.context<Context>().create({
  // errorFormatter: (opts) => ({
  //   ...opts,
  //   shape: {
  //     ...opts.shape,
  //     // message: "bad",
  //   },
  // }),
});

// Base router and procedure helpers
export const router = t.router;
export const publicProcedure = t.procedure;

// Type for authenticated context
type AuthenticatedContext = Context & {
  user: NonNullable<Context["user"]>;
  session: NonNullable<Context["session"]>;
};

// Middleware to automatically invalidate queries after mutations
const autoInvalidateMiddleware = t.middleware(async ({ ctx, next, type }) => {
  const authCtx = ctx as AuthenticatedContext;
  const result = await next({ ctx: authCtx });

  // Only invalidate on successful mutations
  if (type === "mutation" && result.ok && ctx.user) {
    // Cast context as authenticated since we know user exists here
    // Get the user's organization
    const membership = await authCtx.db.query.organizationUserMembership.findFirst({
      where: eq(organizationUserMembership.userId, authCtx.user.id),
    });

    if (membership?.organizationId) {
      // Just invalidate everything
      await invalidateOrganizationQueries(ctx.env, membership.organizationId, {
        type: "INVALIDATE",
        invalidateInfo: {
          type: "ALL", // Invalidate all queries
        },
      }).catch((error) => {
        // Log but don't fail the mutation if invalidation fails
        console.error("Failed to invalidate queries:", error);
      });
    }
  }

  return result;
});

// Protected procedure that requires authentication
export const protectedProcedure = t.procedure
  .use(({ ctx, next }) => {
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
  })
  .use(autoInvalidateMiddleware); // Add auto-invalidation to all protected procedures

// Create a version of protectedProcedure without auto-invalidation for special cases
export const protectedProcedureNoAutoInvalidate = t.procedure.use(({ ctx, next }) => {
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

// Helper to notify organization from within mutations
export async function notifyOrganizationFromContext(
  ctx: Context & { user: NonNullable<Context["user"]> },
  type: "success" | "error" | "info" | "warning",
  message: string,
  extraArgs?: Record<string, unknown>,
) {
  const membership = await ctx.db.query.organizationUserMembership.findFirst({
    where: eq(organizationUserMembership.userId, ctx.user.id),
  });

  if (membership?.organizationId) {
    await notifyOrganization(ctx.env, membership.organizationId, type, message, extraArgs).catch(
      (error) => {
        console.error("Failed to send notification:", error);
      },
    );
  }
}

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

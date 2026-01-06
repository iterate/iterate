import { initTRPC, TRPCError } from "@trpc/server";
import { prettifyError, z, ZodError } from "zod";
import { and, eq } from "drizzle-orm";
import superjson from "superjson";
import { organizationUserMembership, organization, instance } from "../db/schema.ts";
import type { DB } from "../db/client.ts";
import type { Context } from "./context.ts";

type StandardSchemaFailureResult = Parameters<typeof prettifyError>[0];
const looksLikeStandardSchemaFailureResult = (
  error: unknown,
): error is StandardSchemaFailureResult => {
  return typeof error === "object" && !!error && "issues" in error && Array.isArray(error.issues);
};

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter: (opts) => {
    const { shape, error } = opts;

    let zodFormatted: any;
    const zodError =
      error.cause instanceof ZodError ? error.cause : error instanceof ZodError ? error : undefined;

    if (zodError) {
      zodFormatted = {
        formErrors: zodError.issues
          .filter((issue) => issue.path.length === 0)
          .map((issue) => issue.message),
        fieldErrors: zodError.issues.reduce(
          (acc, issue) => {
            if (issue.path.length > 0) {
              const path = issue.path.join(".");
              if (!acc[path]) {
                acc[path] = [];
              }
              acc[path].push(issue.message);
            }
            return acc;
          },
          {} as Record<string, string[]>,
        ),
        issues: zodError.issues,
      };
    }

    return {
      ...shape,
      ...(looksLikeStandardSchemaFailureResult(error.cause) && {
        message: prettifyError(error.cause),
      }),
      data: {
        ...shape.data,
        stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
        zodFormatted,
        zodIssues: zodError?.issues,
      },
    };
  },
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
// This is now a no-op - individual procedures handle their own cache invalidation if needed
// Removing this because:
// 1. It added an extra DB query to EVERY mutation
// 2. The Durable Object broadcast in dev mode was slow
// 3. Clients already invalidate their own queries via queryClient.invalidateQueries
export const autoInvalidateMiddleware = t.middleware(async ({ ctx, next }) => {
  const authCtx = ctx as AuthenticatedContext;
  return next({ ctx: authCtx });
});

/** Protected procedure that requires authentication */
export const protectedProcedure = publicProcedure
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
  .use(autoInvalidateMiddleware);

// Helper function to get user's organizations
export async function getUserOrganizations(db: DB, userId: string) {
  return db.query.organizationUserMembership.findMany({
    where: eq(organizationUserMembership.userId, userId),
    with: {
      organization: true,
    },
  });
}

// Helper function to get user's organization access
export async function getUserOrganizationAccess(
  db: DB,
  userId: string,
  organizationId: string,
): Promise<{ hasAccess: boolean; organization: any | null; membership: any | null }> {
  const membership = await db.query.organizationUserMembership.findFirst({
    where: and(
      eq(organizationUserMembership.userId, userId),
      eq(organizationUserMembership.organizationId, organizationId),
    ),
    with: {
      organization: true,
    },
  });

  if (!membership) {
    return { hasAccess: false, organization: null, membership: null };
  }

  return { hasAccess: true, organization: membership.organization, membership };
}

// Helper to check instance access
export async function getUserInstanceAccess(db: DB, userId: string, instanceId: string) {
  const inst = await db.query.instance.findFirst({
    where: eq(instance.id, instanceId),
    with: {
      organization: true,
    },
  });

  if (!inst) {
    return { hasAccess: false, instance: null };
  }

  const { hasAccess, membership } = await getUserOrganizationAccess(
    db,
    userId,
    inst.organizationId,
  );

  return {
    hasAccess,
    instance: hasAccess ? inst : null,
    membership,
  };
}

// Organization protected procedure that requires both authentication and organization membership
// Uses slug instead of ID
export const orgProtectedProcedure = protectedProcedure
  .input(z.object({ organizationSlug: z.string() }))
  .use(async ({ ctx, input, next, path }) => {
    const org = await ctx.db.query.organization.findFirst({
      where: eq(organization.slug, input.organizationSlug),
    });

    if (!org) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Organization with slug ${input.organizationSlug} not found`,
      });
    }

    const membership = await ctx.db.query.organizationUserMembership.findFirst({
      where: and(
        eq(organizationUserMembership.organizationId, org.id),
        eq(organizationUserMembership.userId, ctx.user.id),
      ),
    });

    // Allow if user has membership OR is a system admin
    if (!membership && ctx.user.role !== "admin") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `Access to ${path} denied: User does not have access to organization`,
      });
    }

    return next({
      ctx: {
        ...ctx,
        organization: org,
        membership: membership ?? undefined,
      },
    });
  });

// Organization admin procedure that requires admin or owner role
export const orgAdminProcedure = orgProtectedProcedure.use(async ({ ctx, next, path }) => {
  // System admins always have access
  if (ctx.user.role === "admin") {
    return next({ ctx });
  }

  const role = ctx.membership?.role;
  if (!role || (role !== "owner" && role !== "admin")) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Access to ${path} denied: Only owners and admins can perform this action`,
    });
  }

  return next({ ctx });
});

// Instance protected procedure that requires authentication and instance access
// Uses slug instead of ID
export const instanceProtectedProcedure = orgProtectedProcedure
  .input(z.object({ instanceSlug: z.string() }))
  .use(async ({ ctx, input, next }) => {
    const inst = await ctx.db.query.instance.findFirst({
      where: and(
        eq(instance.organizationId, ctx.organization.id),
        eq(instance.slug, input.instanceSlug),
      ),
    });

    if (!inst) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Instance with slug ${input.instanceSlug} not found in organization`,
      });
    }

    return next({
      ctx: {
        ...ctx,
        instance: inst,
      },
    });
  });

// Admin procedure - requires system admin role
export const adminProcedure = protectedProcedure.use(async ({ ctx, next, path }) => {
  if (ctx.user.role !== "admin") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Access to ${path} denied: Admin role required`,
    });
  }
  return next({ ctx });
});

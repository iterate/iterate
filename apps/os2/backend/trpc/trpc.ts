import { initTRPC, TRPCError } from "@trpc/server";
import { prettifyError, z, ZodError } from "zod/v4";
import { and, eq } from "drizzle-orm";
import superjson from "superjson";
import { organizationUserMembership, organization, project as projectTable } from "../db/schema.ts";
import { invalidateQueriesForUser } from "../utils/query-invalidation.ts";
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

/** Protected procedure that requires authentication */
export const protectedProcedure = publicProcedure.use(({ ctx, next }) => {
  if (!ctx.session || !ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({
    ctx: {
      ...ctx,
      session: ctx.session as NonNullable<typeof ctx.session>,
      user: ctx.user as NonNullable<typeof ctx.user>,
    },
  });
});

/** Organization protected procedure that requires both authentication and organization membership */
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

// Project protected procedure that requires authentication and project access
// Uses slug instead of ID
export const projectProtectedProcedure = orgProtectedProcedure
  .input(z.object({ projectSlug: z.string() }))
  .use(async ({ ctx, input, next }) => {
    const proj = await ctx.db.query.project.findFirst({
      where: and(
        eq(projectTable.organizationId, ctx.organization.id),
        eq(projectTable.slug, input.projectSlug),
      ),
      with: {
        projectRepo: true,
        envVars: true,
        accessTokens: true,
        connections: true,
      },
    });

    if (!proj) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Project with slug ${input.projectSlug} not found in organization`,
      });
    }

    return next({
      ctx: {
        ...ctx,
        project: proj,
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

/** Middleware that invalidates all queries for the user's organizations after mutation */
const withQueryInvalidation = t.middleware(async ({ ctx, next }) => {
  const result = await next();
  if (result.ok && ctx.user) {
    invalidateQueriesForUser(ctx.db, ctx.env, ctx.user.id).catch(() => {});
  }
  return result;
});

/** Protected mutation procedure - invalidates queries after successful mutation */
export const protectedMutation = protectedProcedure.use(withQueryInvalidation);

/** Org protected mutation procedure - invalidates queries after successful mutation */
export const orgProtectedMutation = orgProtectedProcedure.use(withQueryInvalidation);

/** Org admin mutation procedure - invalidates queries after successful mutation */
export const orgAdminMutation = orgAdminProcedure.use(withQueryInvalidation);

/** Project protected mutation procedure - invalidates queries after successful mutation */
export const projectProtectedMutation = projectProtectedProcedure.use(withQueryInvalidation);

import { initTRPC, TRPCError } from "@trpc/server";
import { prettifyError, z, ZodError } from "zod";
import { and, eq, ne } from "drizzle-orm";
import { organizationUserMembership } from "../db/schema.ts";
import type { DB } from "../db/client.ts";
import { invalidateOrganizationQueries, notifyOrganization } from "../utils/websocket-utils.ts";
import { logger } from "../tag-logger.ts";
import { createPostProcedureConsumerPlugin } from "../outbox/pgmq-lib.ts";
import { waitUntil } from "../../env.ts";
import { recentActiveSources } from "../db/helpers.ts";
import { queuer } from "../outbox/outbox-queuer.ts";
import type { Context } from "./context.ts";

type StandardSchemaFailureResult = Parameters<typeof prettifyError>[0];
const looksLikeStandardSchemaFailureResult = (
  error: unknown,
): error is StandardSchemaFailureResult => {
  return typeof error === "object" && !!error && "issues" in error && Array.isArray(error.issues);
};

const t = initTRPC.context<Context>().create({
  errorFormatter: (opts) => {
    const { shape, error } = opts;

    // Check if this is a ZodError and format it nicely
    let zodFormatted: any;

    // Helper to extract ZodError from error or error.cause
    const zodError =
      error.cause instanceof ZodError ? error.cause : error instanceof ZodError ? error : undefined;

    if (zodError) {
      // Create a structured error format similar to flattenError
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
      // zod errors are big and ugly, but it ships a built-in pretty printer, so let's override the `message` with a more useful one if we can.
      //  we need to check that it's a zod error (or other standard schema failure) before using it though.
      ...(looksLikeStandardSchemaFailureResult(error.cause) && {
        message: prettifyError(error.cause),
      }),
      data: {
        ...shape.data,
        // Add stack trace in development
        stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
        // Add formatted Zod error details
        zodFormatted: zodFormatted,
        // Include raw issues for clients that want to format themselves
        zodIssues: zodError?.issues,
      },
    };
  },
});

export const eventsProcedure = createPostProcedureConsumerPlugin(queuer, { waitUntil });

// Base router and procedure helpers
export const router = t.router;
export const publicProcedure = t.procedure.concat(eventsProcedure);
// Type for authenticated context
type AuthenticatedContext = Context & {
  user: NonNullable<Context["user"]>;
  session: NonNullable<Context["session"]>;
};

// Middleware to automatically invalidate queries after mutations
export const autoInvalidateMiddleware = t.middleware(async ({ ctx, next, type }) => {
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
        logger.error("Failed to invalidate queries:", error);
      });
    }
  }

  return result;
});

/** Protected procedure that requires authentication - note that this just says that the user is signed in, not authorised to access any installation-specific resources */
export const protectedProcedureWithNoInstallationRestrictions = publicProcedure
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

export const protectedProcedure = protectedProcedureWithNoInstallationRestrictions.input(
  z.object({ installationId: z.never().optional() }).optional(),
);

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
        logger.error("Failed to send notification:", error);
      },
    );
  }
}

// Helper to create the non-external organization filter
function getNonExternalOrganizationFilter(userId: string) {
  return and(
    eq(organizationUserMembership.userId, userId),
    ne(organizationUserMembership.role, "external"),
  );
}

// Helper function to get user's non-external organizations
export async function getUserOrganizations(db: DB, userId: string) {
  return db.query.organizationUserMembership.findMany({
    where: getNonExternalOrganizationFilter(userId),
    with: {
      organization: true,
    },
  });
}

// Helper function to get user's non-external organizations with installations
export async function getUserOrganizationsWithInstallations(db: DB, userId: string) {
  return db.query.organizationUserMembership.findMany({
    where: getNonExternalOrganizationFilter(userId),
    with: {
      organization: {
        with: {
          installations: { with: recentActiveSources },
        },
      },
    },
  });
}

// Helper function to get user's organization access
export async function getUserOrganizationAccess(
  db: DB,
  userId: string,
  organizationId: string,
): Promise<{ hasAccess: boolean; organization: any | null }> {
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
    return { hasAccess: false, organization: null };
  }

  return { hasAccess: true, organization: membership.organization };
}

// Helper function to get user's installation if they have access
export async function getUserInstallationAccess(
  db: DB,
  userId: string,
  installationId: string,
  organizationId?: string,
) {
  const userWithInstallations = await db.query.organizationUserMembership.findMany({
    where: eq(organizationUserMembership.userId, userId),
    with: { organization: { with: { installations: { with: recentActiveSources } } } },
  });

  if (!userWithInstallations?.length) {
    return { hasAccess: false, installation: null } as const;
  }

  const allInstallations = userWithInstallations.flatMap(
    ({ organization }) => organization.installations,
  );

  const _userInstallation = allInstallations.find((i) => i.id === installationId);
  const userInstallation = _userInstallation && {
    ..._userInstallation,
    connectedRepoId: _userInstallation?.sources?.[0]?.repoId,
    connectedRepoPath: _userInstallation?.sources?.[0]?.path,
    connectedRepoRef: _userInstallation?.sources?.[0]?.branch,
    connectedRepoAccountId: _userInstallation?.sources?.[0]?.accountId,
  };

  if (!userInstallation) {
    return { hasAccess: false, installation: null } as const;
  }

  if (organizationId && userInstallation.organizationId !== organizationId) {
    return { hasAccess: false, installation: null } as const;
  }

  return { hasAccess: true, installation: userInstallation } as const;
}

// Organization protected procedure that requires both authentication and organization membership
// Admins can access any organization
export const orgProtectedProcedure = protectedProcedure
  .input(z.object({ organizationId: z.string() }))
  .use(async ({ ctx, input, next, path }) => {
    // Check if user has membership in the organization
    const membership = await ctx.db.query.organizationUserMembership.findFirst({
      where: and(
        eq(organizationUserMembership.organizationId, input.organizationId),
        eq(organizationUserMembership.userId, ctx.user.id),
      ),
      with: {
        organization: true,
      },
    });

    // Allow if user has membership OR is a system admin
    if (!membership && ctx.user.role !== "admin") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `Access to ${path} denied: User ${ctx.user.id} does not have access to organization ${input.organizationId}`,
      });
    }

    // If admin without membership, fetch organization separately
    if (!membership) {
      const organization = await ctx.db.query.organization.findFirst({
        where: (org, { eq }) => eq(org.id, input.organizationId),
      });

      if (!organization) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Organization ${input.organizationId} not found`,
        });
      }

      return next({
        ctx: {
          ...ctx,
          organization,
          membership: undefined,
        },
      });
    }

    // Pass the organization and membership data to the next middleware/resolver
    return next({
      ctx: {
        ...ctx,
        organization: membership.organization,
        membership,
      },
    });
  });

// Organization admin procedure that requires admin or owner role
export const orgAdminProcedure = orgProtectedProcedure.use(async ({ ctx, next, path }) => {
  // System admins always have access
  if (ctx.user.role === "admin") {
    return next({ ctx });
  }

  // Otherwise check membership role (extract to local variable to help TypeScript narrow the type)
  const { membership } = ctx;
  const role = membership?.["role"];
  if (!role || (role !== "owner" && role !== "admin")) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Access to ${path} denied: Only owners and admins can perform this action`,
    });
  }

  return next({ ctx });
});

// Installation protected procedure that requires both authentication and installation access
export const installationProtectedProcedure = protectedProcedureWithNoInstallationRestrictions
  .use(autoInvalidateMiddleware)
  .input(z.object({ installationId: z.string() }))
  .use(async ({ ctx, input, next, path }) => {
    const { hasAccess, installation: userInstallation } = await getUserInstallationAccess(
      ctx.db,
      ctx.user.id,
      input.installationId,
    );

    if (!hasAccess || !userInstallation) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `Access to ${path} denied: User ${ctx.user.id} does not have permission to access this installation ${input.installationId}`,
      });
    }

    return next({
      ctx: {
        ...ctx,
        installation: userInstallation,
      },
    });
  });

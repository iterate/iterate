import "./tracked-mutations.ts";
import { initTRPC, TRPCError } from "@trpc/server";
import { prettifyError, z, ZodError } from "zod/v4";
import { and, eq } from "drizzle-orm";
import superjson from "superjson";
import { organizationUserMembership, organization, project as projectTable } from "../db/schema.ts";
import { broadcastInvalidation } from "../utils/query-invalidation.ts";
import { logger } from "../tag-logger.ts";
import { captureServerEvent } from "../lib/posthog.ts";
import { waitUntil } from "../../env.ts";
import { createPostProcedureConsumerPlugin } from "../outbox/pgmq-lib.ts";
import { queuer } from "../outbox/outbox-queuer.ts";
import { getTrackingConfig } from "./middleware/posthog.ts";
import type { Context } from "./context.ts";

// Import tracked mutations to register them on module load

type StandardSchemaFailureResult = Parameters<typeof prettifyError>[0];
const looksLikeStandardSchemaFailureResult = (
  error: unknown,
): error is StandardSchemaFailureResult => {
  return typeof error === "object" && !!error && "issues" in error && Array.isArray(error.issues);
};

export const t = initTRPC.context<Context>().create({
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

/** Outbox plugin - injects `ctx.sendTrpc(tx, output)` into every procedure */
const eventsProcedure = createPostProcedureConsumerPlugin(queuer, { waitUntil });
export const publicProcedure = t.procedure.concat(eventsProcedure);

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

// Project protected procedure that requires authentication and project access.
// Project slugs are globally unique, so only projectSlug is required.
export const projectProtectedProcedure = protectedProcedure
  .input(z.object({ projectSlug: z.string() }))
  .use(async ({ ctx, input, next, path }) => {
    const proj = await ctx.db.query.project.findFirst({
      where: eq(projectTable.slug, input.projectSlug),
      with: {
        organization: true,
        projectRepos: true,
        envVars: true,
        accessTokens: true,
        connections: true,
      },
    });

    if (!proj) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Project with slug ${input.projectSlug} not found`,
      });
    }

    if (!proj.organization) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Project with slug ${input.projectSlug} has no organization`,
      });
    }

    // Check user has access to the project's organization
    const membership = await ctx.db.query.organizationUserMembership.findFirst({
      where: and(
        eq(organizationUserMembership.organizationId, proj.organizationId),
        eq(organizationUserMembership.userId, ctx.user.id),
      ),
    });

    if (!membership && ctx.user.role !== "admin") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `Access to ${path} denied: User does not have access to this project`,
      });
    }

    return next({
      ctx: {
        ...ctx,
        organization: proj.organization,
        membership: membership ?? undefined,
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

/** Middleware that broadcasts query invalidation to all connected clients after mutation */
const withQueryInvalidation = t.middleware(async ({ ctx, next }) => {
  const result = await next();
  if (result.ok) {
    broadcastInvalidation(ctx.env).catch((error) => {
      logger.error("Failed to broadcast invalidation:", error);
    });
  }
  return result;
});

/** Middleware that tracks mutations to PostHog */
const withPostHogTracking = t.middleware(async ({ ctx, next, path, type, getRawInput }) => {
  // Only track mutations
  if (type !== "mutation") {
    return next();
  }

  // Check if this mutation should be tracked
  const config = getTrackingConfig(path);
  if (!config) {
    return next();
  }

  // Capture input BEFORE mutation to avoid blocking response path
  const rawInput = await getRawInput();

  // Execute the mutation
  const result = await next();

  // Only track successful mutations
  if (!result.ok) {
    return result;
  }

  // Wrap analytics in try-catch to prevent analytics errors from affecting the mutation response
  try {
    // Get user ID for distinct_id
    const userId = ctx.user?.id;
    if (!userId) {
      return result;
    }

    // Extract properties
    let properties: Record<string, unknown> = {
      procedure: path,
      success: true,
    };

    if (config.extractProperties) {
      const extracted = config.extractProperties(rawInput);
      if (extracted === undefined) {
        // Skip tracking this specific call
        return result;
      }
      properties = { ...properties, ...extracted };
    } else if (config.includeFullInput) {
      properties.input = rawInput;
    }

    if (config.staticProperties) {
      properties = { ...properties, ...config.staticProperties };
    }

    // Build groups
    const groups: Record<string, string> = {};

    if ("organization" in ctx && ctx.organization) {
      const org = ctx.organization as { id: string };
      groups.organization = org.id;
    }

    if ("project" in ctx && ctx.project) {
      const proj = ctx.project as { id: string };
      groups.project = proj.id;
    }

    // Capture the event using waitUntil to ensure delivery
    const eventName = config.eventName || `trpc.${path}`;
    waitUntil(
      captureServerEvent(ctx.env, {
        distinctId: userId,
        event: eventName,
        properties,
        groups: Object.keys(groups).length > 0 ? groups : undefined,
      }),
    );
  } catch (error) {
    logger.error("PostHog tracking error (mutation succeeded, analytics failed):", error);
  }

  return result;
});

/** Public mutation procedure - invalidates queries after successful mutation (for testing) */
export const publicMutation = publicProcedure.use(withQueryInvalidation).use(withPostHogTracking);

/** Protected mutation procedure - invalidates queries after successful mutation */
export const protectedMutation = protectedProcedure
  .use(withQueryInvalidation)
  .use(withPostHogTracking);

/** Org protected mutation procedure - invalidates queries after successful mutation */
export const orgProtectedMutation = orgProtectedProcedure
  .use(withQueryInvalidation)
  .use(withPostHogTracking);

/** Org admin mutation procedure - invalidates queries after successful mutation */
export const orgAdminMutation = orgAdminProcedure
  .use(withQueryInvalidation)
  .use(withPostHogTracking);

/** Project protected mutation procedure - invalidates queries after successful mutation */
export const projectProtectedMutation = projectProtectedProcedure
  .use(withQueryInvalidation)
  .use(withPostHogTracking);

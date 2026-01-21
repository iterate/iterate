import "./tracked-mutations.ts";
import { os, ORPCError, onError, ValidationError } from "@orpc/server";
import { prettifyError, z, ZodError } from "zod/v4";
import { and, eq } from "drizzle-orm";
import { organizationUserMembership, organization, project as projectTable } from "../db/schema.ts";
import { broadcastInvalidation } from "../utils/query-invalidation.ts";
import { logger } from "../tag-logger.ts";
import { captureServerEvent } from "../lib/posthog.ts";
import { waitUntil } from "../../env.ts";
import { getTrackingConfig } from "./middleware/posthog.ts";
import type { Context } from "./context.ts";

// Import tracked mutations to register them on module load

// Base oRPC instance with context
const base = os.$context<Context>();

// Validation error handling middleware - converts validation errors to friendlier format
const withValidationErrorHandling = base.middleware(
  onError((error) => {
    if (
      error instanceof ORPCError &&
      error.code === "BAD_REQUEST" &&
      error.cause instanceof ValidationError
    ) {
      // Convert to ZodError format for consistent error handling
      const zodError = new ZodError(error.cause.issues as z.core.$ZodIssue[]);
      throw new ORPCError("BAD_REQUEST", {
        message: prettifyError(zodError),
        data: {
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
        },
        cause: error.cause,
      });
    }
  }),
);

// Public procedure - no auth required
export const publicProcedure = base.use(withValidationErrorHandling);

/** Protected procedure that requires authentication */
export const protectedProcedure = publicProcedure.use(({ context, next }) => {
  if (!context.session || !context.user) {
    throw new ORPCError("UNAUTHORIZED");
  }
  return next({
    context: {
      ...context,
      session: context.session as NonNullable<typeof context.session>,
      user: context.user as NonNullable<typeof context.user>,
    },
  });
});

// Admin procedure - requires system admin role
export const adminProcedure = protectedProcedure.use(async ({ context, next, path }) => {
  if (context.user.role !== "admin") {
    throw new ORPCError("FORBIDDEN", {
      message: `Access to ${path.join(".")} denied: Admin role required`,
    });
  }
  return next({ context });
});

/** Middleware that broadcasts query invalidation to all connected clients after handler */
const withQueryInvalidation = base.middleware(async ({ context, next }) => {
  const result = await next();
  broadcastInvalidation(context.env).catch((error) => {
    logger.error("Failed to broadcast invalidation:", error);
  });
  return result;
});

/** Middleware that tracks procedure calls to PostHog */
const withPostHogTracking = base.middleware(async ({ context, next, path }) => {
  // Check if this path should be tracked
  const pathStr = path.join(".");
  const config = getTrackingConfig(pathStr);
  if (!config) {
    return next();
  }

  // Execute the handler
  const result = await next();

  // Wrap analytics in try-catch to prevent analytics errors from affecting the response
  try {
    // Get user ID for distinct_id
    const userId = context.user?.id;
    if (!userId) {
      return result;
    }

    // Extract properties
    let properties: Record<string, unknown> = {
      procedure: pathStr,
      success: true,
    };

    if (config.staticProperties) {
      properties = { ...properties, ...config.staticProperties };
    }

    // Build groups
    const groups: Record<string, string> = {};

    if ("organization" in context && context.organization) {
      const org = context.organization as { id: string };
      groups.organization = org.id;
    }

    if ("project" in context && context.project) {
      const proj = context.project as { id: string };
      groups.project = proj.id;
    }

    // Capture the event using waitUntil to ensure delivery
    const eventName = config.eventName || `orpc.${pathStr}`;
    waitUntil(
      captureServerEvent(context.env, {
        distinctId: userId,
        event: eventName,
        properties,
        groups: Object.keys(groups).length > 0 ? groups : undefined,
      }),
    );
  } catch (error) {
    logger.error("PostHog tracking error (handler succeeded, analytics failed):", error);
  }

  return result;
});

/** Public mutation procedure - invalidates queries after successful mutation (for testing) */
export const publicMutation = publicProcedure.use(withQueryInvalidation).use(withPostHogTracking);

/** Protected mutation procedure - invalidates queries after successful mutation */
export const protectedMutation = protectedProcedure
  .use(withQueryInvalidation)
  .use(withPostHogTracking);

// ============================================================================
// Organization & Project protected procedures
//
// In oRPC, input is set once and middleware after .input() can access it.
// We define these with their input schema built-in.
// ============================================================================

/** Schema for organization-scoped inputs */
export const OrgInput = z.object({ organizationSlug: z.string() });

/** Schema for project-scoped inputs (extends org) */
export const ProjectInput = z.object({
  organizationSlug: z.string(),
  projectSlug: z.string(),
});

// Types for extended contexts
type AuthenticatedContext = Context & {
  session: NonNullable<Context["session"]>;
  user: NonNullable<Context["user"]>;
};

type OrgContext = AuthenticatedContext & {
  organization: typeof organization.$inferSelect;
  membership: typeof organizationUserMembership.$inferSelect | undefined;
};

type _ProjectContext = OrgContext & {
  project: typeof projectTable.$inferSelect & {
    projectRepos: unknown[];
    envVars: unknown[];
    accessTokens: unknown[];
    connections: unknown[];
  };
};

/** Middleware to check org access - use after input is defined */
async function checkOrgAccess(
  context: AuthenticatedContext,
  organizationSlug: string,
  path: readonly string[],
): Promise<{
  organization: typeof organization.$inferSelect;
  membership: typeof organizationUserMembership.$inferSelect | undefined;
}> {
  const org = await context.db.query.organization.findFirst({
    where: eq(organization.slug, organizationSlug),
  });

  if (!org) {
    throw new ORPCError("NOT_FOUND", {
      message: `Organization with slug ${organizationSlug} not found`,
    });
  }

  const membership = await context.db.query.organizationUserMembership.findFirst({
    where: and(
      eq(organizationUserMembership.organizationId, org.id),
      eq(organizationUserMembership.userId, context.user.id),
    ),
  });

  // Allow if user has membership OR is a system admin
  if (!membership && context.user.role !== "admin") {
    throw new ORPCError("FORBIDDEN", {
      message: `Access to ${path.join(".")} denied: User does not have access to organization`,
    });
  }

  return { organization: org, membership: membership ?? undefined };
}

/** Middleware to check admin access */
function checkOrgAdmin(context: OrgContext, path: readonly string[]): void {
  // System admins always have access
  if (context.user.role === "admin") return;

  const role = context.membership?.role;
  if (!role || (role !== "owner" && role !== "admin")) {
    throw new ORPCError("FORBIDDEN", {
      message: `Access to ${path.join(".")} denied: Only owners and admins can perform this action`,
    });
  }
}

/** Organization protected procedure - includes organizationSlug input */
export const orgProtectedProcedure = protectedProcedure
  .input(OrgInput)
  .use(async ({ context, next, path }, input: z.infer<typeof OrgInput>) => {
    const { organization: org, membership } = await checkOrgAccess(
      context,
      input.organizationSlug,
      path,
    );
    return next({
      context: {
        ...context,
        organization: org,
        membership,
      },
    });
  });

/** Organization admin procedure */
export const orgAdminProcedure = orgProtectedProcedure.use(async ({ context, next, path }) => {
  checkOrgAdmin(context as OrgContext, path);
  return next({ context });
});

/** Project protected procedure - includes organizationSlug + projectSlug input */
export const projectProtectedProcedure = protectedProcedure
  .input(ProjectInput)
  .use(async ({ context, next, path }, input: z.infer<typeof ProjectInput>) => {
    const { organization: org, membership } = await checkOrgAccess(
      context,
      input.organizationSlug,
      path,
    );

    const proj = await context.db.query.project.findFirst({
      where: and(eq(projectTable.organizationId, org.id), eq(projectTable.slug, input.projectSlug)),
      with: {
        projectRepos: true,
        envVars: true,
        accessTokens: true,
        connections: true,
      },
    });

    if (!proj) {
      throw new ORPCError("NOT_FOUND", {
        message: `Project with slug ${input.projectSlug} not found in organization`,
      });
    }

    return next({
      context: {
        ...context,
        organization: org,
        membership,
        project: proj,
      },
    });
  });

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

// Re-export ORPCError for use in routers
export { ORPCError };

// ============================================================================
// Factory functions for procedures with additional input
// These merge the base schema (org/project) with additional fields
// ============================================================================

/** Create org-protected procedure with additional input fields */
export function withOrgInput<T extends z.ZodRawShape>(additionalFields: T) {
  const mergedSchema = OrgInput.extend(additionalFields);
  type MergedInput = z.infer<typeof mergedSchema> & { organizationSlug: string };
  return protectedProcedure.input(mergedSchema).use(async ({ context, next, path }, input) => {
    const typedInput = input as MergedInput;
    const { organization: org, membership } = await checkOrgAccess(
      context,
      typedInput.organizationSlug,
      path,
    );
    return next({
      context: { ...context, organization: org, membership },
    });
  });
}

/** Create org-admin procedure with additional input fields */
export function withOrgAdminInput<T extends z.ZodRawShape>(additionalFields: T) {
  const mergedSchema = OrgInput.extend(additionalFields);
  type MergedInput = z.infer<typeof mergedSchema> & { organizationSlug: string };
  return protectedProcedure
    .input(mergedSchema)
    .use(async ({ context, next, path }, input) => {
      const typedInput = input as MergedInput;
      const { organization: org, membership } = await checkOrgAccess(
        context,
        typedInput.organizationSlug,
        path,
      );
      return next({
        context: { ...context, organization: org, membership },
      });
    })
    .use(async ({ context, next, path }) => {
      checkOrgAdmin(context as OrgContext, path);
      return next({ context });
    });
}

/** Create project-protected procedure with additional input fields */
export function withProjectInput<T extends z.ZodRawShape>(additionalFields: T) {
  const mergedSchema = ProjectInput.extend(additionalFields);
  type MergedInput = z.infer<typeof mergedSchema> & {
    organizationSlug: string;
    projectSlug: string;
  };
  return protectedProcedure.input(mergedSchema).use(async ({ context, next, path }, input) => {
    const typedInput = input as MergedInput;
    const { organization: org, membership } = await checkOrgAccess(
      context,
      typedInput.organizationSlug,
      path,
    );

    const proj = await context.db.query.project.findFirst({
      where: and(
        eq(projectTable.organizationId, org.id),
        eq(projectTable.slug, typedInput.projectSlug),
      ),
      with: {
        projectRepos: true,
        envVars: true,
        accessTokens: true,
        connections: true,
      },
    });

    if (!proj) {
      throw new ORPCError("NOT_FOUND", {
        message: `Project with slug ${typedInput.projectSlug} not found in organization`,
      });
    }

    return next({
      context: { ...context, organization: org, membership, project: proj },
    });
  });
}

/** Create org-protected mutation with additional input fields */
export function withOrgMutationInput<T extends z.ZodRawShape>(additionalFields: T) {
  return withOrgInput(additionalFields).use(withQueryInvalidation).use(withPostHogTracking);
}

/** Create org-admin mutation with additional input fields */
export function withOrgAdminMutationInput<T extends z.ZodRawShape>(additionalFields: T) {
  return withOrgAdminInput(additionalFields).use(withQueryInvalidation).use(withPostHogTracking);
}

/** Create project-protected mutation with additional input fields */
export function withProjectMutationInput<T extends z.ZodRawShape>(additionalFields: T) {
  return withProjectInput(additionalFields).use(withQueryInvalidation).use(withPostHogTracking);
}

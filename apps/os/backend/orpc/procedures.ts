import "./tracked-mutations.ts";
import { os, ORPCError } from "@orpc/server";
import { z } from "zod/v4";
import { and, eq } from "drizzle-orm";
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

// Base procedure builder with context
const base = os.$context<Context>();

/** Outbox plugin - injects `ctx.sendEvent(tx, output)` into every procedure */
const outboxMiddleware = createPostProcedureConsumerPlugin(queuer, { waitUntil });
export const publicProcedure = base.use(outboxMiddleware);

/** Protected procedure that requires authentication */
const withAuth = base.middleware(async ({ context, next }) => {
  if (!context.session || !context.user) {
    throw new ORPCError("UNAUTHORIZED");
  }
  return next({
    context: {
      session: context.session as NonNullable<typeof context.session>,
      user: context.user as NonNullable<typeof context.user>,
    },
  });
});
export const protectedProcedure = publicProcedure.use(withAuth);

/**
 * Input schemas for org/project-scoped procedures.
 * oRPC's `.input()` replaces rather than merges, so each procedure must include
 * the relevant slug field(s) in its own `.input()` schema.
 * Use `OrgInput` / `ProjectInput` as a spread base:
 *   `.input(z.object({ ...OrgInput.shape, name: z.string() }))`
 * Or for procedures that only need the slug:
 *   `.input(OrgInput)`
 */
export const OrgInput = z.object({ organizationSlug: z.string() });
export const ProjectInput = z.object({ projectSlug: z.string() });

/** Organization protected procedure that requires both authentication and organization membership.
 *  Reads `organizationSlug` from the raw input — callers MUST include it in their `.input()` schema. */
export const orgProtectedProcedure = protectedProcedure.use(
  async ({ context, next, path }, input: unknown) => {
    const slug = (input as Record<string, unknown>)?.organizationSlug as string | undefined;
    if (!slug) {
      throw new ORPCError("BAD_REQUEST", {
        message: `organizationSlug is required`,
      });
    }

    const org = await context.db.query.organization.findFirst({
      where: eq(organization.slug, slug),
    });

    if (!org) {
      throw new ORPCError("NOT_FOUND", {
        message: `Organization with slug ${slug} not found`,
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
        message: `Access to ${path} denied: User does not have access to organization`,
      });
    }

    return next({
      context: {
        organization: org,
        membership: membership ?? undefined,
      },
    });
  },
);

// Organization admin procedure that requires admin or owner role
export const orgAdminProcedure = orgProtectedProcedure.use(async ({ context, next, path }) => {
  // System admins always have access
  if (context.user.role === "admin") {
    return next({ context: {} });
  }

  const role = context.membership?.role;
  if (!role || (role !== "owner" && role !== "admin")) {
    throw new ORPCError("FORBIDDEN", {
      message: `Access to ${path} denied: Only owners and admins can perform this action`,
    });
  }

  return next({ context: {} });
});

/** Project protected procedure that requires authentication and project access.
 *  Project slugs are globally unique, so only projectSlug is required.
 *  Reads `projectSlug` from the raw input — callers MUST include it in their `.input()` schema. */
export const projectProtectedProcedure = protectedProcedure.use(
  async ({ context, next, path }, input: unknown) => {
    const slug = (input as Record<string, unknown>)?.projectSlug as string | undefined;
    if (!slug) {
      throw new ORPCError("BAD_REQUEST", {
        message: `projectSlug is required`,
      });
    }

    const proj = await context.db.query.project.findFirst({
      where: eq(projectTable.slug, slug),
      with: {
        organization: true,
        projectRepos: true,
        envVars: true,
        accessTokens: true,
        connections: true,
      },
    });

    if (!proj) {
      throw new ORPCError("NOT_FOUND", {
        message: `Project with slug ${slug} not found`,
      });
    }

    if (!proj.organization) {
      throw new ORPCError("NOT_FOUND", {
        message: `Project with slug ${slug} has no organization`,
      });
    }

    // Check user has access to the project's organization
    const membership = await context.db.query.organizationUserMembership.findFirst({
      where: and(
        eq(organizationUserMembership.organizationId, proj.organizationId),
        eq(organizationUserMembership.userId, context.user.id),
      ),
    });

    if (!membership && context.user.role !== "admin") {
      throw new ORPCError("FORBIDDEN", {
        message: `Access to ${path} denied: User does not have access to this project`,
      });
    }

    return next({
      context: {
        organization: proj.organization,
        membership: membership ?? undefined,
        project: proj,
      },
    });
  },
);

// Admin procedure - requires system admin role
export const adminProcedure = protectedProcedure.use(async ({ context, next, path }) => {
  if (context.user.role !== "admin") {
    throw new ORPCError("FORBIDDEN", {
      message: `Access to ${path} denied: Admin role required`,
    });
  }
  return next({ context: {} });
});

/** Middleware that broadcasts query invalidation to all connected clients after mutation */
const withQueryInvalidation = base.middleware(async ({ context, next }) => {
  const result = await next();
  // If we reach here, it succeeded (oRPC throws on error)
  broadcastInvalidation(context.env).catch((error) => {
    logger.error("Failed to broadcast invalidation:", error);
  });
  return result;
});

/** Middleware that tracks mutations to PostHog */
const withPostHogTracking = base.middleware(async ({ context, next, path }, input: unknown) => {
  // Check if this mutation should be tracked
  const config = getTrackingConfig(path.join("."));
  if (!config) {
    return next();
  }

  // Execute the handler
  const result = await next();

  // Only track successful calls (if we reach here, it succeeded)
  // Wrap analytics in try-catch to prevent analytics errors from affecting the response
  try {
    // Get user ID for distinct_id
    const userId = (context as any).user?.id;
    if (!userId) {
      return result;
    }

    // Extract properties
    let properties: Record<string, unknown> = {
      procedure: path.join("."),
      success: true,
    };

    if (config.extractProperties) {
      const extracted = config.extractProperties(input);
      if (extracted === undefined) {
        // Skip tracking this specific call
        return result;
      }
      properties = { ...properties, ...extracted };
    } else if (config.includeFullInput) {
      properties.input = input;
    }

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
    const eventName = config.eventName || `rpc.${path.join(".")}`;
    waitUntil(
      captureServerEvent(context.env, {
        distinctId: userId,
        event: eventName,
        properties,
        groups: Object.keys(groups).length > 0 ? groups : undefined,
      }),
    );
  } catch (error) {
    logger.error("PostHog tracking error (call succeeded, analytics failed):", error);
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

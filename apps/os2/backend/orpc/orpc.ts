import { os, ORPCError } from "@orpc/server";
import { z } from "zod/v4";
import { and, eq } from "drizzle-orm";
import { organizationUserMembership, organization, project as projectTable } from "../db/schema.ts";
import type { Context } from "./context.ts";
import { invalidateQueriesForUser } from "../utils/query-invalidation.ts";

export { ORPCError };

const o = os.$context<Context>();

export const publicProcedure = o;

export const protectedProcedure = o.use(({ context, next }) => {
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

const orgLookupMiddleware = async (
  context: Context & { user: NonNullable<Context["user"]> },
  organizationSlug: string,
  path: readonly string[],
) => {
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

  if (!membership && context.user.role !== "admin") {
    throw new ORPCError("FORBIDDEN", {
      message: `Access to ${path.join(".")} denied: User does not have access to organization`,
    });
  }

  return {
    organization: org,
    membership: membership ?? undefined,
  };
};

export const OrgInput = z.object({ organizationSlug: z.string() });

export const orgProtectedProcedure = protectedProcedure
  .input(OrgInput)
  .use(async (opts) => {
    const { context, next, path } = opts;
    const input = (opts as unknown as { input: { organizationSlug: string } }).input;
    const orgData = await orgLookupMiddleware(context, input.organizationSlug, path);
    return next({
      context: {
        ...context,
        ...orgData,
      },
    });
  });

export const orgAdminProcedure = orgProtectedProcedure.use(async ({ context, next, path }) => {
  if (context.user.role === "admin") {
    return next({ context });
  }

  const role = context.membership?.role;
  if (!role || (role !== "owner" && role !== "admin")) {
    throw new ORPCError("FORBIDDEN", {
      message: `Access to ${path.join(".")} denied: Only owners and admins can perform this action`,
    });
  }

  return next({ context });
});

export const ProjectInput = z.object({ organizationSlug: z.string(), projectSlug: z.string() });

export const projectProtectedProcedure = protectedProcedure
  .input(ProjectInput)
  .use(async (opts) => {
    const { context, next, path } = opts;
    const input = (opts as unknown as { input: { organizationSlug: string; projectSlug: string } }).input;
    const orgData = await orgLookupMiddleware(context, input.organizationSlug, path);

    const proj = await context.db.query.project.findFirst({
      where: and(
        eq(projectTable.organizationId, orgData.organization.id),
        eq(projectTable.slug, input.projectSlug),
      ),
      with: {
        repo: true,
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
        ...orgData,
        project: proj,
      },
    });
  });

export const adminProcedure = protectedProcedure.use(async ({ context, next, path }) => {
  if (context.user.role !== "admin") {
    throw new ORPCError("FORBIDDEN", {
      message: `Access to ${path.join(".")} denied: Admin role required`,
    });
  }
  return next({ context });
});

const withQueryInvalidation = o.middleware(async ({ context, next }) => {
  const result = await next();
  if (context.user) {
    invalidateQueriesForUser(context.db, context.env, context.user.id).catch(() => {});
  }
  return result;
});

export const protectedMutation = protectedProcedure.use(withQueryInvalidation);
export const orgProtectedMutation = orgProtectedProcedure.use(withQueryInvalidation);
export const projectProtectedMutation = projectProtectedProcedure.use(withQueryInvalidation);

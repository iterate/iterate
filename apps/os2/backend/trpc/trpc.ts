import { initTRPC, TRPCError } from "@trpc/server";
import { prettifyError, z, ZodError } from "zod/v4";
import { and, eq } from "drizzle-orm";
import { organizationUserMembership, organization, instance } from "../db/schema.ts";
import type { DB } from "../db/client.ts";
import { logger } from "../tag-logger.ts";
import { invalidateOrganizationQueries } from "../utils/websocket-utils.ts";
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

    let zodFormatted: unknown;

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

export const router = t.router;
export const publicProcedure = t.procedure;

type AuthenticatedContext = Context & {
  user: NonNullable<Context["user"]>;
  session: NonNullable<Context["session"]>;
};

export const autoInvalidateMiddleware = t.middleware(async ({ ctx, next, type }) => {
  const authCtx = ctx as AuthenticatedContext;
  const result = await next({ ctx: authCtx });

  if (type === "mutation" && result.ok && ctx.user) {
    const membership = await authCtx.db.query.organizationUserMembership.findFirst({
      where: eq(organizationUserMembership.userId, authCtx.user.id),
    });

    if (membership?.organizationId) {
      await invalidateOrganizationQueries(ctx.env, membership.organizationId, {
        type: "INVALIDATE",
        invalidateInfo: {
          type: "ALL",
        },
      }).catch((error) => {
        logger.error("Failed to invalidate queries:", error);
      });
    }
  }

  return result;
});

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

export async function getUserOrganizations(db: DB, userId: string) {
  return db.query.organizationUserMembership.findMany({
    where: eq(organizationUserMembership.userId, userId),
    with: {
      organization: true,
    },
  });
}

export async function getUserOrganizationsWithInstances(db: DB, userId: string) {
  return db.query.organizationUserMembership.findMany({
    where: eq(organizationUserMembership.userId, userId),
    with: {
      organization: {
        with: {
          instances: true,
        },
      },
    },
  });
}

export async function getUserOrganizationAccess(
  db: DB,
  userId: string,
  organizationSlug: string,
): Promise<{
  hasAccess: boolean;
  organization: typeof organization.$inferSelect | null;
  membership: typeof organizationUserMembership.$inferSelect | null;
}> {
  const org = await db.query.organization.findFirst({
    where: eq(organization.slug, organizationSlug),
  });

  if (!org) {
    return { hasAccess: false, organization: null, membership: null };
  }

  const membership = await db.query.organizationUserMembership.findFirst({
    where: and(
      eq(organizationUserMembership.userId, userId),
      eq(organizationUserMembership.organizationId, org.id),
    ),
  });

  if (!membership) {
    return { hasAccess: false, organization: null, membership: null };
  }

  return { hasAccess: true, organization: org, membership };
}

export async function getUserInstanceAccess(
  db: DB,
  userId: string,
  organizationSlug: string,
  instanceSlug: string,
) {
  const orgAccess = await getUserOrganizationAccess(db, userId, organizationSlug);
  if (!orgAccess.hasAccess || !orgAccess.organization) {
    return { hasAccess: false, instance: null, organization: null };
  }

  const inst = await db.query.instance.findFirst({
    where: and(
      eq(instance.organizationId, orgAccess.organization.id),
      eq(instance.slug, instanceSlug),
    ),
  });

  if (!inst) {
    return { hasAccess: false, instance: null, organization: orgAccess.organization };
  }

  return { hasAccess: true, instance: inst, organization: orgAccess.organization };
}

export const orgProtectedProcedure = protectedProcedure
  .input(z.object({ organizationSlug: z.string() }))
  .use(async ({ ctx, input, next, path }) => {
    const {
      hasAccess,
      organization: org,
      membership,
    } = await getUserOrganizationAccess(ctx.db, ctx.user.id, input.organizationSlug);

    if (!hasAccess && ctx.user.role !== "admin") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `Access to ${path} denied: User ${ctx.user.id} does not have access to organization ${input.organizationSlug}`,
      });
    }

    if (!org) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Organization ${input.organizationSlug} not found`,
      });
    }

    return next({
      ctx: {
        ...ctx,
        organization: org,
        membership,
      },
    });
  });

export const orgAdminProcedure = orgProtectedProcedure.use(async ({ ctx, next, path }) => {
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

export const instanceProtectedProcedure = protectedProcedure
  .input(z.object({ organizationSlug: z.string(), instanceSlug: z.string() }))
  .use(async ({ ctx, input, next, path }) => {
    const {
      hasAccess,
      instance: inst,
      organization: org,
    } = await getUserInstanceAccess(
      ctx.db,
      ctx.user.id,
      input.organizationSlug,
      input.instanceSlug,
    );

    if (!hasAccess || !inst) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `Access to ${path} denied: User ${ctx.user.id} does not have permission to access this instance`,
      });
    }

    return next({
      ctx: {
        ...ctx,
        instance: inst,
        organization: org,
      },
    });
  });

export const adminProcedure = protectedProcedure.use(async ({ ctx, next, path }) => {
  if (ctx.user.role !== "admin") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Access to ${path} denied: Admin privileges required`,
    });
  }
  return next({ ctx });
});

import { initTRPC, TRPCError } from "@trpc/server";
import { prettifyError, z, ZodError } from "zod/v4";
import { and, eq } from "drizzle-orm";
import { organizationUserMembership, organization, project } from "../db/schema.ts";
import type { DB } from "../db/client.ts";
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

    let zodFormatted: ReturnType<typeof formatZodError> | undefined;

    const zodError =
      error.cause instanceof ZodError ? error.cause : error instanceof ZodError ? error : undefined;

    if (zodError) {
      zodFormatted = formatZodError(zodError);
    }

    return {
      ...shape,
      ...(looksLikeStandardSchemaFailureResult(error.cause) && {
        message: prettifyError(error.cause),
      }),
      data: {
        ...shape.data,
        stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
        zodFormatted: zodFormatted,
        zodIssues: zodError?.issues,
      },
    };
  },
});

function formatZodError(zodError: ZodError) {
  return {
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

export const router = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = publicProcedure.use(({ ctx, next }) => {
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

export async function getUserOrganizations(db: DB, userId: string) {
  return db.query.organizationUserMembership.findMany({
    where: eq(organizationUserMembership.userId, userId),
    with: {
      organization: true,
    },
  });
}

export async function getUserOrganizationsWithProjects(db: DB, userId: string) {
  return db.query.organizationUserMembership.findMany({
    where: eq(organizationUserMembership.userId, userId),
    with: {
      organization: {
        with: {
          projects: true,
        },
      },
    },
  });
}

export async function getUserOrganizationAccess(
  db: DB,
  userId: string,
  organizationId: string,
): Promise<{ hasAccess: boolean; organization: typeof organization.$inferSelect | null }> {
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

export async function getUserProjectAccess(db: DB, userId: string, projectId: string) {
  const userWithProjects = await db.query.organizationUserMembership.findMany({
    where: eq(organizationUserMembership.userId, userId),
    with: { organization: { with: { projects: true } } },
  });

  if (!userWithProjects?.length) {
    return { hasAccess: false, project: null } as const;
  }

  const allProjects = userWithProjects.flatMap(({ organization }) => organization.projects);
  const userProject = allProjects.find((p) => p.id === projectId);

  if (!userProject) {
    return { hasAccess: false, project: null } as const;
  }

  return { hasAccess: true, project: userProject } as const;
}

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

    if (!membership && ctx.user.role !== "admin") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `Access to ${path} denied: User ${ctx.user.id} does not have access to organization ${org.id}`,
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

  const { membership } = ctx;
  const role = membership?.role;
  if (!role || (role !== "owner" && role !== "admin")) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Access to ${path} denied: Only owners and admins can perform this action`,
    });
  }

  return next({ ctx });
});

export const projectProtectedProcedure = protectedProcedure
  .input(z.object({ organizationSlug: z.string(), projectSlug: z.string() }))
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

    if (!membership && ctx.user.role !== "admin") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `Access to ${path} denied: User ${ctx.user.id} does not have access to organization ${org.id}`,
      });
    }

    const proj = await ctx.db.query.project.findFirst({
      where: and(eq(project.organizationId, org.id), eq(project.slug, input.projectSlug)),
    });

    if (!proj) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Project with slug ${input.projectSlug} not found in organization ${org.slug}`,
      });
    }

    return next({
      ctx: {
        ...ctx,
        organization: org,
        project: proj,
        membership,
      },
    });
  });

export const adminProcedure = protectedProcedure.use(async ({ ctx, next, path }) => {
  if (ctx.user.role !== "admin") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Access to ${path} denied: Admin access required`,
    });
  }
  return next({ ctx });
});

import { ORPCError } from "@orpc/server";
import { z } from "zod/v4";
import { and, eq } from "drizzle-orm";
import { organizationUserMembership, organization, project as projectTable } from "../db/schema.ts";
import { getAuth } from "../auth/auth.ts";
import type { AuthSession, AuthUser } from "../auth/auth.ts";
import { invalidateQueriesForUser } from "../utils/query-invalidation.ts";
import { base, type Context } from "./context.ts";

export { ORPCError };

type SessionData = NonNullable<AuthSession>;

type AuthContext = Context & { session: SessionData; user: AuthUser };

type SessionResult = AuthSession | { data: AuthSession | null } | null | undefined;

export const publicProcedure = base;

export const authMiddleware = base.middleware(async ({ context, next }) => {
  const auth = getAuth(context.db);
  const sessionResult = await auth.api.getSession({ headers: context.headers });
  const sessionData = unwrapSessionResult(sessionResult);

  if (!sessionData?.session || !sessionData.user) {
    throw new ORPCError("UNAUTHORIZED");
  }

  return next({
    context: {
      ...context,
      session: sessionData,
      user: sessionData.user,
    },
  });
});

export const protectedProcedure = base.use(authMiddleware);

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

const withQueryInvalidation = base.middleware(async ({ context, next }) => {
  const result = await next();
  const userId = getUserId(context);
  if (userId) {
    invalidateQueriesForUser(context.db, context.env, userId).catch(() => {});
  }
  return result;
});

export const protectedMutation = protectedProcedure.use(withQueryInvalidation);
export const orgProtectedMutation = orgProtectedProcedure.use(withQueryInvalidation);
export const projectProtectedMutation = projectProtectedProcedure.use(withQueryInvalidation);

function unwrapSessionResult(sessionResult: SessionResult): AuthSession {
  if (sessionResult && typeof sessionResult === "object" && "data" in sessionResult) {
    return sessionResult.data ?? null;
  }

  return sessionResult ?? null;
}

async function orgLookupMiddleware(
  context: AuthContext,
  organizationSlug: string,
  path: readonly string[],
) {
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
}

function getUserId(context: Context): string | null {
  if (!("user" in context)) {
    return null;
  }

  const user = context.user;
  if (!user || typeof user !== "object") {
    return null;
  }

  if (!("id" in user)) {
    return null;
  }

  const userId = user.id;
  return typeof userId === "string" ? userId : null;
}

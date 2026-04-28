import { ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { authContract } from "@iterate-com/auth-contract";
import { implement } from "@orpc/server";
import type { RequestHeadersPluginContext } from "@orpc/server/plugins";
import { schema } from "../db/index.ts";
import type { Variables } from "../utils/hono.ts";
import type { CloudflareEnv } from "../env.ts";

type ORPCContext = RequestHeadersPluginContext & Variables & { env: CloudflareEnv };

export const os = implement(authContract).$context<ORPCContext>();

export const protectedMiddleware = os.middleware(async ({ context, next }) => {
  const { session } = context;
  if (!session) {
    throw new ORPCError("UNAUTHORIZED", { message: "Not authorized" });
  }
  return next({
    context: {
      session,
      user: session.user,
      reqHeaders: context.reqHeaders,
    },
  });
});

export const superadminOnlyMiddleware = os.middleware(async ({ context, next }) => {
  const { session } = context;
  if (!session || session.user.role !== "admin") {
    throw new ORPCError("UNAUTHORIZED", { message: "Not authorized" });
  }
  return next({
    context: {
      session,
      user: session.user,
      reqHeaders: context.reqHeaders,
    },
  });
});

export const serviceMiddleware = os.middleware(async ({ context, next }) => {
  if (!context.serviceAuthorized) {
    throw new ORPCError("UNAUTHORIZED", { message: "Not authorized" });
  }

  return next({
    context: {
      serviceAuthorized: true,
    },
  });
});

async function loadOrganization(params: {
  db: ORPCContext["db"];
  organizationSlug: string;
  user: { id: string; role?: string | null };
}) {
  const organization = await params.db.query.organization.findFirst({
    where: eq(schema.organization.slug, params.organizationSlug),
  });
  if (!organization) {
    throw new ORPCError("NOT_FOUND", { message: "Organization not found" });
  }

  const membership = await params.db.query.member.findFirst({
    where: and(
      eq(schema.member.organizationId, organization.id),
      eq(schema.member.userId, params.user.id),
    ),
  });
  if (!membership && params.user.role !== "admin") {
    throw new ORPCError("FORBIDDEN", { message: "You do not have access to this organization" });
  }

  return { organization, membership: membership ?? null };
}

function assertOrganizationAdmin(params: {
  user: { role?: string | null };
  membership: { role: string } | null;
}) {
  const isSystemAdmin = params.user.role === "admin";
  const role = params.membership?.role;
  if (!isSystemAdmin && role !== "owner" && role !== "admin") {
    throw new ORPCError("FORBIDDEN", { message: "Admin role required" });
  }
}

export const organizationScopedMiddleware = os.middleware(
  async ({ context, next }, input: { organizationSlug: string }) => {
    const { session } = context;
    if (!session) {
      throw new ORPCError("UNAUTHORIZED", { message: "Not authorized" });
    }

    const { organization, membership } = await loadOrganization({
      db: context.db,
      organizationSlug: input.organizationSlug,
      user: session.user,
    });

    return next({
      context: {
        session,
        user: session.user,
        reqHeaders: context.reqHeaders,
        organization,
        membership,
      },
    });
  },
);

export const organizationAdminMiddleware = os.middleware(
  async ({ context, next }, input: { organizationSlug: string }) => {
    const { session } = context;
    if (!session) {
      throw new ORPCError("UNAUTHORIZED", { message: "Not authorized" });
    }

    const { organization, membership } = await loadOrganization({
      db: context.db,
      organizationSlug: input.organizationSlug,
      user: session.user,
    });
    assertOrganizationAdmin({ user: session.user, membership });

    return next({
      context: {
        session,
        user: session.user,
        reqHeaders: context.reqHeaders,
        organization,
        membership,
      },
    });
  },
);

async function loadProject(params: {
  db: ORPCContext["db"];
  projectSlug: string;
  user: { id: string; role?: string | null };
}) {
  const projectRow = await params.db.query.project.findFirst({
    where: eq(schema.project.slug, params.projectSlug),
    with: { organization: true },
  });
  if (!projectRow) {
    throw new ORPCError("NOT_FOUND", { message: "Project not found" });
  }
  const { organization, ...project } = projectRow;

  const membership = await params.db.query.member.findFirst({
    where: and(
      eq(schema.member.organizationId, organization.id),
      eq(schema.member.userId, params.user.id),
    ),
  });
  if (!membership && params.user.role !== "admin") {
    throw new ORPCError("FORBIDDEN", { message: "You do not have access to this project" });
  }

  return { project, organization, membership: membership ?? null };
}

export const projectScopedMiddleware = os.middleware(
  async ({ context, next }, input: { projectSlug: string }) => {
    const { session } = context;
    if (!session) {
      throw new ORPCError("UNAUTHORIZED", { message: "Not authorized" });
    }

    const { project, organization, membership } = await loadProject({
      db: context.db,
      projectSlug: input.projectSlug,
      user: session.user,
    });

    return next({
      context: {
        session,
        user: session.user,
        reqHeaders: context.reqHeaders,
        project,
        organization,
        membership,
      },
    });
  },
);

export const projectAdminMiddleware = os.middleware(
  async ({ context, next }, input: { projectSlug: string }) => {
    const { session } = context;
    if (!session) {
      throw new ORPCError("UNAUTHORIZED", { message: "Not authorized" });
    }

    const { project, organization, membership } = await loadProject({
      db: context.db,
      projectSlug: input.projectSlug,
      user: session.user,
    });
    assertOrganizationAdmin({ user: session.user, membership });

    return next({
      context: {
        session,
        user: session.user,
        reqHeaders: context.reqHeaders,
        project,
        organization,
        membership,
      },
    });
  },
);

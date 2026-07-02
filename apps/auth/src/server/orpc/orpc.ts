import { ORPCError } from "@orpc/server";
import { authContract } from "@iterate-com/auth-contract";
import { implement } from "@orpc/server";
import type { RequestHeadersPluginContext } from "@orpc/server/plugins";
import {
  getMembershipByOrganizationAndUserId,
  getOrganizationBySlug,
  getProjectWithOrganizationBySlug,
} from "../db/queries/index.ts";
import type { Variables } from "../utils/hono.ts";
import type { CloudflareEnv } from "../env.ts";
import { isPlatformAdminUser } from "../platform-admin.ts";
import { toProjectRecordFromReturnedRow } from "../records.ts";

// Two role namespaces appear below; don't mix them up:
// - `session.user.role` is the system-wide better-auth admin-plugin role.
//   "admin" there means platform admin and bypasses every
//   membership check.
// - `membership.role` is scoped to one organization and is one of
//   "owner" | "admin" | "member".

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

export const platformAdminOnlyMiddleware = os.middleware(async ({ context, next }) => {
  const { session } = context;
  if (!session || !isPlatformAdminUser(session.user)) {
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

// Deploy-time scripts presenting SERVICE_AUTH_TOKEN (see hono.ts). Runtime
// OS→auth calls do NOT come through here anymore — they use the Workers RPC
// methods on the worker entrypoint, where the service binding is the
// credential.
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
  const organization = await getOrganizationBySlug(params.db, {
    slug: params.organizationSlug,
  });
  if (!organization) {
    throw new ORPCError("NOT_FOUND", { message: "Organization not found" });
  }

  const membership = await getMembershipByOrganizationAndUserId(params.db, {
    organizationId: organization.id,
    userId: params.user.id,
  });
  if (!membership && !isPlatformAdminUser(params.user)) {
    throw new ORPCError("FORBIDDEN", { message: "You do not have access to this organization" });
  }

  return { organization, membership };
}

function assertOrganizationAdmin(params: {
  user: { role?: string | null };
  membership: { role: string } | null;
}) {
  const role = params.membership?.role;
  if (!isPlatformAdminUser(params.user) && role !== "owner" && role !== "admin") {
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

// Same context as organizationScopedMiddleware plus the admin-role assertion:
// https://orpc.unnoq.com/docs/middleware#concatenation
export const organizationAdminMiddleware = organizationScopedMiddleware.concat(
  async ({ context, next }) => {
    assertOrganizationAdmin({ user: context.user, membership: context.membership });
    return next();
  },
);

export const projectAdminMiddleware = os.middleware(
  async ({ context, next }, input: { projectSlug: string }) => {
    const { session } = context;
    if (!session) {
      throw new ORPCError("UNAUTHORIZED", { message: "Not authorized" });
    }

    const projectRow = await getProjectWithOrganizationBySlug(context.db, {
      slug: input.projectSlug,
    });
    if (!projectRow) {
      throw new ORPCError("NOT_FOUND", { message: "Project not found" });
    }
    const organization = {
      id: projectRow.organizationRecordId,
      name: projectRow.organizationName,
      slug: projectRow.organizationSlug,
    };

    const membership = await getMembershipByOrganizationAndUserId(context.db, {
      organizationId: organization.id,
      userId: session.user.id,
    });
    if (!membership && !isPlatformAdminUser(session.user)) {
      throw new ORPCError("FORBIDDEN", { message: "You do not have access to this project" });
    }
    assertOrganizationAdmin({ user: session.user, membership });

    return next({
      context: {
        session,
        user: session.user,
        reqHeaders: context.reqHeaders,
        project: toProjectRecordFromReturnedRow(projectRow),
        organization,
        membership,
      },
    });
  },
);

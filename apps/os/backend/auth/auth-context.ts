import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.ts";
import type {
  OrganizationMemberRecord,
  OrganizationRole,
} from "../../../auth-contract/src/index.ts";
import type { DB } from "../db/client.ts";
import { type AuthWorkerClient, createAuthWorkerClient } from "../utils/auth-worker-client.ts";
import { ensureLocalUserMirror } from "./auth-worker-session.ts";

type LocalOrganization = typeof schema.organization.$inferSelect;
type LocalProjectWithRelations = typeof schema.project.$inferSelect & {
  organization: LocalOrganization | null;
  envVars: Array<typeof schema.projectEnvVar.$inferSelect>;
  accessTokens: Array<typeof schema.projectAccessToken.$inferSelect>;
  connections: Array<typeof schema.projectConnection.$inferSelect>;
};

function rethrowAuthWorkerError(error: unknown, fallbackMessage: string): never {
  if (error instanceof ORPCError) {
    throw error;
  }
  throw new ORPCError("INTERNAL_SERVER_ERROR", { message: fallbackMessage, cause: error });
}

export async function ensureLocalOrganizationShadow(
  db: DB,
  authOrganization: { id: string; name: string; slug: string },
): Promise<LocalOrganization> {
  const existingByAuthId = await db.query.organization.findFirst({
    where: eq(schema.organization.authOrganizationId, authOrganization.id),
  });

  if (existingByAuthId) {
    if (
      existingByAuthId.name !== authOrganization.name ||
      existingByAuthId.slug !== authOrganization.slug
    ) {
      const [updated] = await db
        .update(schema.organization)
        .set({
          name: authOrganization.name,
          slug: authOrganization.slug,
        })
        .where(eq(schema.organization.id, existingByAuthId.id))
        .returning();

      return updated ?? existingByAuthId;
    }

    return existingByAuthId;
  }

  const existingBySlug = await db.query.organization.findFirst({
    where: eq(schema.organization.slug, authOrganization.slug),
  });

  if (existingBySlug) {
    const [updated] = await db
      .update(schema.organization)
      .set({
        authOrganizationId: authOrganization.id,
        name: authOrganization.name,
      })
      .where(eq(schema.organization.id, existingBySlug.id))
      .returning();

    return updated ?? existingBySlug;
  }

  const [created] = await db
    .insert(schema.organization)
    .values({
      authOrganizationId: authOrganization.id,
      name: authOrganization.name,
      slug: authOrganization.slug,
    })
    .returning();

  if (!created) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: `Failed to create local organization shadow for ${authOrganization.slug}`,
    });
  }

  return created;
}

async function writeMembershipShadows(
  db: DB,
  localOrganizationId: string,
  authMembers: OrganizationMemberRecord[],
) {
  const localUsers = await Promise.all(
    authMembers.map((member) => ensureLocalUserMirror(db, member.user)),
  );

  await db
    .delete(schema.organizationUserMembership)
    .where(eq(schema.organizationUserMembership.organizationId, localOrganizationId));

  if (localUsers.length > 0) {
    await db.insert(schema.organizationUserMembership).values(
      localUsers.map((localUser, index) => ({
        organizationId: localOrganizationId,
        userId: localUser.id,
        role: authMembers[index].role,
      })),
    );
  }
}

export async function syncOrganizationMembershipShadowsFromAuthWorker(params: {
  db: DB;
  authUserId: string;
  organizationSlug: string;
  authOrganization?: { id: string; name: string; slug: string };
}): Promise<LocalOrganization> {
  const authClient = createAuthWorkerClient({ asUser: { authUserId: params.authUserId } });
  const authOrganization =
    params.authOrganization ??
    (await authClient.organization.bySlug({ organizationSlug: params.organizationSlug }));
  const localOrganization = await ensureLocalOrganizationShadow(params.db, authOrganization);
  const authMembers = await authClient.organization.members({
    organizationSlug: authOrganization.slug,
  });
  await writeMembershipShadows(params.db, localOrganization.id, authMembers);
  return localOrganization;
}

export async function syncOrganizationMembershipShadowsFromServiceAuth(params: {
  db: DB;
  serviceToken: string;
  organizationSlug: string;
  authOrganization?: { id: string; name: string; slug: string };
}): Promise<LocalOrganization> {
  const authClient: AuthWorkerClient = createAuthWorkerClient({
    serviceToken: params.serviceToken,
  });
  const authOrganization =
    params.authOrganization ??
    (await authClient.organization.bySlug({ organizationSlug: params.organizationSlug }));
  const localOrganization = await ensureLocalOrganizationShadow(params.db, authOrganization);
  const authMembers = await authClient.internal.organization.members({
    organizationSlug: authOrganization.slug,
  });
  await writeMembershipShadows(params.db, localOrganization.id, authMembers);
  return localOrganization;
}

export async function listOrganizationsFromAuthWorker(params: {
  db: DB;
  authUserId: string;
}): Promise<
  Array<
    (LocalOrganization & {
      role: OrganizationRole;
    }) & {
      projects: Array<typeof schema.project.$inferSelect>;
    }
  >
> {
  const authClient = createAuthWorkerClient({ asUser: { authUserId: params.authUserId } });

  let organizations: Awaited<ReturnType<typeof authClient.user.myOrganizations>>;
  try {
    organizations = await authClient.user.myOrganizations();
  } catch (error) {
    rethrowAuthWorkerError(error, "Failed to load organizations from auth worker");
  }

  return Promise.all(
    organizations.map(async (organization) => {
      const localOrganization = await ensureLocalOrganizationShadow(params.db, organization);
      const organizationWithProjects = await params.db.query.organization.findFirst({
        where: eq(schema.organization.id, localOrganization.id),
        with: {
          projects: true,
        },
      });

      return {
        ...(organizationWithProjects ?? { ...localOrganization, projects: [] }),
        role: organization.role,
      };
    }),
  );
}

export async function getOrganizationAccessFromAuthWorker(params: {
  db: DB;
  authUserId: string;
  organizationSlug: string;
}) {
  const authClient = createAuthWorkerClient({ asUser: { authUserId: params.authUserId } });

  let authOrganization: Awaited<ReturnType<typeof authClient.organization.bySlug>>;
  try {
    authOrganization = await authClient.organization.bySlug({
      organizationSlug: params.organizationSlug,
    });
  } catch (error) {
    rethrowAuthWorkerError(error, "Failed to load organization from auth worker");
  }

  const organization = await ensureLocalOrganizationShadow(params.db, authOrganization);

  return {
    organization,
    membership: { role: authOrganization.role as OrganizationRole },
    authOrganization,
  };
}

export async function getProjectAccessFromAuthWorker(params: {
  db: DB;
  authUserId: string;
  projectSlug: string;
}): Promise<{
  project: LocalProjectWithRelations;
  organization: LocalOrganization;
}> {
  const authClient = createAuthWorkerClient({ asUser: { authUserId: params.authUserId } });

  let authProject: Awaited<ReturnType<typeof authClient.project.bySlug>>;
  try {
    authProject = await authClient.project.bySlug({
      projectSlug: params.projectSlug,
    });
  } catch (error) {
    rethrowAuthWorkerError(error, "Failed to load project from auth worker");
  }

  let project = await params.db.query.project.findFirst({
    where: eq(schema.project.authProjectId, authProject.id),
    with: {
      organization: true,
      envVars: true,
      accessTokens: true,
      connections: true,
    },
  });

  if (!project) {
    const existingBySlug = await params.db.query.project.findFirst({
      where: eq(schema.project.slug, authProject.slug),
      with: {
        organization: true,
        envVars: true,
        accessTokens: true,
        connections: true,
      },
    });

    if (existingBySlug) {
      const [updated] = await params.db
        .update(schema.project)
        .set({
          authProjectId: authProject.id,
          name: authProject.name,
        })
        .where(eq(schema.project.id, existingBySlug.id))
        .returning();

      project = updated &&
        existingBySlug.organization && {
          ...existingBySlug,
          ...updated,
        };
    }
  }

  if (!project || !project.organization) {
    throw new ORPCError("NOT_FOUND", {
      message: `Project ${authProject.slug} exists in auth but is not provisioned in os`,
    });
  }

  return {
    project,
    organization: project.organization,
  };
}

export async function requireProjectAccessBySlugFromAuthWorker(params: {
  db: DB;
  authUserId: string;
  projectSlug: string;
}) {
  return getProjectAccessFromAuthWorker(params);
}

export async function requireLocalProjectAccessFromAuthWorker(params: {
  db: DB;
  authUserId: string;
  projectId: string;
}) {
  const localProject = await params.db.query.project.findFirst({
    where: eq(schema.project.id, params.projectId),
  });

  if (!localProject) {
    throw new ORPCError("NOT_FOUND", {
      message: `Project ${params.projectId} not found`,
    });
  }

  return getProjectAccessFromAuthWorker({
    db: params.db,
    authUserId: params.authUserId,
    projectSlug: localProject.slug,
  });
}

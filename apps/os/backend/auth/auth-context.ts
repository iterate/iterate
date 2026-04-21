import { ORPCError } from "@orpc/server";
import { desc, eq, inArray } from "drizzle-orm";
import type { OrganizationRole, OrganizationSummary } from "../../../auth-contract/src/index.ts";
import * as schema from "../db/schema.ts";
import type { DB } from "../db/client.ts";
import { createAuthWorkerClient } from "../utils/auth-worker-client.ts";

type AuthOrganization = OrganizationSummary;
type LocalProjectWithRelations = typeof schema.project.$inferSelect & {
  envVars: Array<typeof schema.projectEnvVar.$inferSelect>;
  accessTokens: Array<typeof schema.projectAccessToken.$inferSelect>;
  connections: Array<typeof schema.projectConnection.$inferSelect>;
};

function throwProjectAuthDriftError(params: {
  projectSlug: string;
  message: string;
  details: Record<string, unknown>;
}): never {
  throw new ORPCError("INTERNAL_SERVER_ERROR", {
    message: `Auth/OS project drift for ${params.projectSlug}: ${params.message}`,
    cause: params.details,
  });
}

function rethrowAuthWorkerError(error: unknown, fallbackMessage: string): never {
  if (error instanceof ORPCError) {
    throw error;
  }
  throw new ORPCError("INTERNAL_SERVER_ERROR", { message: fallbackMessage, cause: error });
}

async function listLocalProjectsByAuthProjectIds(params: {
  db: DB;
  authProjectIds: string[];
}): Promise<Array<typeof schema.project.$inferSelect>> {
  if (params.authProjectIds.length === 0) {
    return [];
  }

  return params.db.query.project.findMany({
    where: inArray(schema.project.authProjectId, params.authProjectIds),
    orderBy: desc(schema.project.createdAt),
  });
}

async function getOrganizationForProject(params: {
  authUserId: string;
  authOrganizationId: string;
}): Promise<AuthOrganization> {
  const authClient = createAuthWorkerClient({ asUser: { authUserId: params.authUserId } });
  const organizations = await authClient.user.myOrganizations();
  const organization = organizations.find(
    (candidate) => candidate.id === params.authOrganizationId,
  );

  if (!organization) {
    throw new ORPCError("FORBIDDEN", {
      message: `No organization access for ${params.authOrganizationId}`,
    });
  }

  return organization;
}

export async function listOrganizationsFromAuthWorker(params: {
  db: DB;
  authUserId: string;
}): Promise<
  Array<
    AuthOrganization & {
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
      const authProjects = await authClient.project.list({
        organizationSlug: organization.slug,
      });
      const projects = await listLocalProjectsByAuthProjectIds({
        db: params.db,
        authProjectIds: authProjects.map((authProject) => authProject.id),
      });

      return {
        ...organization,
        projects,
      };
    }),
  );
}

export async function getOrganizationAccessFromAuthWorker(params: {
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

  return {
    organization: authOrganization,
    membership: { role: authOrganization.role as OrganizationRole },
    authOrganization,
  };
}

export async function listProjectsForOrganizationFromAuthWorker(params: {
  db: DB;
  authUserId: string;
  organizationSlug: string;
}): Promise<Array<typeof schema.project.$inferSelect>> {
  const authClient = createAuthWorkerClient({ asUser: { authUserId: params.authUserId } });

  let authProjects: Awaited<ReturnType<typeof authClient.project.list>>;
  try {
    authProjects = await authClient.project.list({
      organizationSlug: params.organizationSlug,
    });
  } catch (error) {
    rethrowAuthWorkerError(error, "Failed to load projects from auth worker");
  }

  return listLocalProjectsByAuthProjectIds({
    db: params.db,
    authProjectIds: authProjects.map((authProject) => authProject.id),
  });
}

export async function getProjectAccessFromAuthWorker(params: {
  db: DB;
  authUserId: string;
  projectSlug: string;
}): Promise<{
  project: LocalProjectWithRelations;
  organization: AuthOrganization;
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

  const organization = await getOrganizationForProject({
    authUserId: params.authUserId,
    authOrganizationId: authProject.organizationId,
  });

  const project = await params.db.query.project.findFirst({
    where: eq(schema.project.authProjectId, authProject.id),
    with: {
      envVars: true,
      accessTokens: true,
      connections: true,
    },
  });

  if (!project) {
    const existingBySlug = await params.db.query.project.findFirst({
      where: eq(schema.project.slug, authProject.slug),
      with: {
        envVars: true,
        accessTokens: true,
        connections: true,
      },
    });

    if (existingBySlug) {
      throwProjectAuthDriftError({
        projectSlug: authProject.slug,
        message: "local project exists by slug but is not bound to the auth project id",
        details: {
          localProjectId: existingBySlug.id,
          localAuthProjectId: existingBySlug.authProjectId,
          authProjectId: authProject.id,
          localAuthOrganizationId: existingBySlug.authOrganizationId,
          authOrganizationId: organization.id,
        },
      });
    }
  }

  if (!project) {
    throw new ORPCError("NOT_FOUND", {
      message: `Project ${authProject.slug} exists in auth but is not provisioned in os`,
    });
  }

  if (
    project.authOrganizationId !== organization.id ||
    project.authOrganizationSlug !== organization.slug ||
    project.name !== authProject.name
  ) {
    throwProjectAuthDriftError({
      projectSlug: authProject.slug,
      message: "local project metadata does not match auth worker state",
      details: {
        localProjectId: project.id,
        localName: project.name,
        authName: authProject.name,
        localAuthOrganizationId: project.authOrganizationId,
        authOrganizationId: organization.id,
        localAuthOrganizationSlug: project.authOrganizationSlug,
        authOrganizationSlug: organization.slug,
      },
    });
  }

  return {
    project,
    organization,
  };
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

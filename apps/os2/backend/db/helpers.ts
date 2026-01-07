import { and, eq } from "drizzle-orm";
import type { DB } from "./client.ts";
import { organization, organizationUserMembership, project, machine } from "./schema.ts";

/**
 * Get user's organizations where they are not external
 */
export async function getUserOrganizations(db: DB, userId: string) {
  return db.query.organizationUserMembership.findMany({
    where: eq(organizationUserMembership.userId, userId),
    with: {
      organization: true,
    },
  });
}

/**
 * Get user's organizations with projects
 */
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

/**
 * Get organization by slug
 */
export async function getOrganizationBySlug(db: DB, slug: string) {
  return db.query.organization.findFirst({
    where: eq(organization.slug, slug),
    with: {
      projects: true,
    },
  });
}

/**
 * Get project by slug within an organization
 */
export async function getProjectBySlug(db: DB, organizationId: string, slug: string) {
  return db.query.project.findFirst({
    where: and(eq(project.organizationId, organizationId), eq(project.slug, slug)),
  });
}

/**
 * Get machines for a project
 */
export async function getProjectMachines(db: DB, projectId: string, includeArchived = false) {
  return db.query.machine.findMany({
    where: includeArchived
      ? eq(machine.projectId, projectId)
      : and(eq(machine.projectId, projectId), eq(machine.state, "started")),
    orderBy: (machine, { desc }) => [desc(machine.createdAt)],
  });
}

/**
 * Check if user has access to organization
 */
export async function checkOrganizationAccess(db: DB, userId: string, organizationId: string) {
  const membership = await db.query.organizationUserMembership.findFirst({
    where: and(
      eq(organizationUserMembership.userId, userId),
      eq(organizationUserMembership.organizationId, organizationId),
    ),
    with: {
      organization: true,
    },
  });

  return {
    hasAccess: !!membership,
    membership,
    organization: membership?.organization ?? null,
  };
}

/**
 * Check if user has access to project
 */
export async function checkProjectAccess(db: DB, userId: string, projectId: string) {
  const proj = await db.query.project.findFirst({
    where: eq(project.id, projectId),
    with: {
      organization: true,
    },
  });

  if (!proj) {
    return { hasAccess: false, project: null };
  }

  const { hasAccess, membership } = await checkOrganizationAccess(db, userId, proj.organizationId);

  return {
    hasAccess,
    project: hasAccess ? proj : null,
    membership,
  };
}

import { eq } from "drizzle-orm";
import { organization, organizationUserMembership } from "./schema.ts";
import type { DB } from "./client.ts";

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

export async function getOrganizationBySlug(db: DB, slug: string) {
  return db.query.organization.findFirst({
    where: eq(organization.slug, slug),
    with: {
      projects: true,
    },
  });
}

export async function getProjectBySlug(db: DB, organizationId: string, projectSlug: string) {
  return db.query.project.findFirst({
    where: (p, { and, eq }) => and(eq(p.organizationId, organizationId), eq(p.slug, projectSlug)),
  });
}

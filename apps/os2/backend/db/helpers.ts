import { eq } from "drizzle-orm";
import type { DB } from "./client.ts";
import * as schema from "./schema.ts";

export async function getOrganizationBySlug(db: DB, slug: string) {
  return db.query.organization.findFirst({
    where: eq(schema.organization.slug, slug),
  });
}

export async function getInstanceBySlug(db: DB, organizationId: string, slug: string) {
  return db.query.instance.findFirst({
    where: (instance, { and, eq }) =>
      and(eq(instance.organizationId, organizationId), eq(instance.slug, slug)),
  });
}

export async function getUserOrganizations(db: DB, userId: string) {
  return db.query.organizationUserMembership.findMany({
    where: eq(schema.organizationUserMembership.userId, userId),
    with: {
      organization: {
        with: {
          instances: true,
        },
      },
    },
  });
}

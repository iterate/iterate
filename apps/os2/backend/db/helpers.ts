import { and, eq } from "drizzle-orm";
import type { DB } from "./client.ts";
import { organization, organizationUserMembership, instance, machine } from "./schema.ts";

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
 * Get user's organizations with instances
 */
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

/**
 * Get organization by slug
 */
export async function getOrganizationBySlug(db: DB, slug: string) {
  return db.query.organization.findFirst({
    where: eq(organization.slug, slug),
    with: {
      instances: true,
    },
  });
}

/**
 * Get instance by slug within an organization
 */
export async function getInstanceBySlug(db: DB, organizationId: string, slug: string) {
  return db.query.instance.findFirst({
    where: and(eq(instance.organizationId, organizationId), eq(instance.slug, slug)),
  });
}

/**
 * Get machines for an instance
 */
export async function getInstanceMachines(db: DB, instanceId: string, includeArchived = false) {
  return db.query.machine.findMany({
    where: includeArchived
      ? eq(machine.instanceId, instanceId)
      : and(eq(machine.instanceId, instanceId), eq(machine.state, "started")),
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
 * Check if user has access to instance
 */
export async function checkInstanceAccess(db: DB, userId: string, instanceId: string) {
  const inst = await db.query.instance.findFirst({
    where: eq(instance.id, instanceId),
    with: {
      organization: true,
    },
  });

  if (!inst) {
    return { hasAccess: false, instance: null };
  }

  const { hasAccess, membership } = await checkOrganizationAccess(db, userId, inst.organizationId);

  return {
    hasAccess,
    instance: hasAccess ? inst : null,
    membership,
  };
}

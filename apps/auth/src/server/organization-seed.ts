import type {
  InternalEnsureOrganizationInput,
  OrganizationRecord,
} from "@iterate-com/auth-contract";
import type { DB } from "./db/index.ts";
import {
  getMembershipByOrganizationAndUserId,
  getOrganizationBySlug,
  getUserById,
  insertMembership,
  insertOrganization,
  updateMembershipRoleByOrganizationAndUserId,
  updateOrganizationNameById,
} from "./db/queries/index.ts";
import { generateId } from "./id.ts";

/**
 * Converge the identity data a project seed needs. Declared members are a
 * minimum desired set: omitted memberships are never deleted, while every
 * declared role is made exact. This keeps a stale seed from silently removing
 * a developer who joined later.
 */
export async function ensureOrganizationForProjectSeed(
  db: DB,
  input: InternalEnsureOrganizationInput,
): Promise<OrganizationRecord> {
  for (const member of input.members) {
    if (!(await getUserById(db, { id: member.userId }))) {
      throw new Error(`Cannot seed organization "${input.slug}": user ${member.userId} not found.`);
    }
  }

  let organization = await getOrganizationBySlug(db, { slug: input.slug });
  if (!organization) {
    organization = {
      id: generateId("org"),
      name: input.name,
      slug: input.slug,
    };
    const now = Date.now();
    await db.transaction(async (tx) => {
      await insertOrganization(tx, {
        id: organization!.id,
        name: organization!.name,
        slug: organization!.slug,
        createdAt: now,
        metadata: null,
        logo: null,
      });
      for (const member of input.members) {
        await insertMembership(tx, {
          id: generateId("member"),
          organizationId: organization!.id,
          userId: member.userId,
          role: member.role,
          createdAt: now,
        });
      }
    });
    return organization;
  }

  await db.transaction(async (tx) => {
    if (organization!.name !== input.name) {
      await updateOrganizationNameById(tx, { name: input.name }, { id: organization!.id });
    }
    for (const member of input.members) {
      const existing = await getMembershipByOrganizationAndUserId(tx, {
        organizationId: organization!.id,
        userId: member.userId,
      });
      if (!existing) {
        await insertMembership(tx, {
          id: generateId("member"),
          organizationId: organization!.id,
          userId: member.userId,
          role: member.role,
          createdAt: Date.now(),
        });
      } else if (existing.role !== member.role) {
        await updateMembershipRoleByOrganizationAndUserId(
          tx,
          { role: member.role },
          {
            organizationId: organization!.id,
            userId: member.userId,
          },
        );
      }
    }
  });

  return { ...organization, name: input.name };
}

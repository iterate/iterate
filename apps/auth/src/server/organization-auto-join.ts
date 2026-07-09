import type { Client } from "sqlfu";
import {
  getMembershipByOrganizationAndUserId,
  getOrganizationBySlug,
  getUserById,
  insertMembershipIfMissing,
  insertOrganizationIfMissing,
} from "./db/queries/index.ts";

export const NUSTOM_AUTO_JOIN_EMAIL_DOMAIN = "nustom.com";
export const NUSTOM_AUTO_JOIN_ORGANIZATION_NAME = "Iterate";
export const NUSTOM_AUTO_JOIN_ORGANIZATION_SLUG = "iterate";
export const NUSTOM_AUTO_JOIN_ORGANIZATION_ROLE = "member";

export function shouldAutoJoinIterateOrganization(email: string | null | undefined) {
  const normalizedEmail = email?.trim().toLowerCase();
  if (!normalizedEmail) return false;

  const atIndex = normalizedEmail.lastIndexOf("@");
  if (atIndex < 0) return false;

  return normalizedEmail.slice(atIndex + 1) === NUSTOM_AUTO_JOIN_EMAIL_DOMAIN;
}

export async function ensureIterateOrganizationMembershipForNustomUserId(
  client: Client,
  userId: string | null | undefined,
) {
  if (!userId) return null;

  const user = await getUserById(client, { id: userId });
  if (!user) return null;

  return ensureIterateOrganizationMembershipForNustomUser(client, {
    id: user.id,
    email: user.email,
  });
}

export async function ensureIterateOrganizationMembershipForNustomUser(
  client: Client,
  user: { id: string; email: string },
) {
  if (!shouldAutoJoinIterateOrganization(user.email)) return null;

  const organization = await ensureIterateOrganization(client);
  const existingMembership = await getMembershipByOrganizationAndUserId(client, {
    organizationId: organization.id,
    userId: user.id,
  });
  if (existingMembership) {
    return { organization, membership: existingMembership };
  }

  await insertMembershipIfMissing(client, {
    id: generateId("member"),
    organizationId: organization.id,
    userId: user.id,
    role: NUSTOM_AUTO_JOIN_ORGANIZATION_ROLE,
    createdAt: Date.now(),
  });

  const membership = await getMembershipByOrganizationAndUserId(client, {
    organizationId: organization.id,
    userId: user.id,
  });
  if (!membership) {
    throw new Error(
      `Failed to create ${NUSTOM_AUTO_JOIN_ORGANIZATION_SLUG} organization membership for user ${user.id}`,
    );
  }

  return { organization, membership };
}

async function ensureIterateOrganization(client: Client) {
  const existing = await getOrganizationBySlug(client, {
    slug: NUSTOM_AUTO_JOIN_ORGANIZATION_SLUG,
  });
  if (existing) return existing;

  await insertOrganizationIfMissing(client, {
    id: generateId("org"),
    name: NUSTOM_AUTO_JOIN_ORGANIZATION_NAME,
    slug: NUSTOM_AUTO_JOIN_ORGANIZATION_SLUG,
    createdAt: Date.now(),
    metadata: null,
    logo: null,
  });

  const organization = await getOrganizationBySlug(client, {
    slug: NUSTOM_AUTO_JOIN_ORGANIZATION_SLUG,
  });
  if (!organization) {
    throw new Error(`Failed to create ${NUSTOM_AUTO_JOIN_ORGANIZATION_SLUG} organization`);
  }

  return organization;
}

function generateId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

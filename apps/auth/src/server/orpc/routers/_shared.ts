import { OrganizationRole } from "@iterate-com/auth-contract";

export function generateId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function toUserRecord(user: {
  id: string;
  name: string;
  email: string;
  image?: string | null;
  role?: string | null;
}) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    image: user.image ?? null,
    role: user.role ?? null,
  };
}

export function toOrganizationRecord(organization: { id: string; name: string; slug: string }) {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
  };
}

export function toProjectRecord(project: {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  metadata: Record<string, unknown>;
  archivedAt?: Date | null;
}) {
  return {
    id: project.id,
    organizationId: project.organizationId,
    name: project.name,
    slug: project.slug,
    metadata: project.metadata,
    archivedAt: project.archivedAt?.toISOString() ?? null,
  };
}

export function toMembershipRole(role: string | null | undefined): OrganizationRole {
  return OrganizationRole.parse(role ?? "member");
}

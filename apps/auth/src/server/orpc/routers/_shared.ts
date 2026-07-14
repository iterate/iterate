import { OrganizationRole } from "@iterate-com/auth-contract";

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

export function toMembershipRole(role: string | null | undefined): OrganizationRole {
  return OrganizationRole.parse(role ?? "member");
}

import { OrganizationRole } from "@iterate-com/auth-contract";
import { parseProjectMetadata, parseTimestampMs } from "../../db/helpers.ts";
import type {
  getProjectBySlug,
  insertProjectReturning,
  updateProjectReturning,
} from "../../db/queries/index.ts";

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

type ReturnedProjectRow = (
  | getProjectBySlug.Result
  | insertProjectReturning.Result
  | updateProjectReturning.Result
) &
  Partial<{ organizationId: string; archivedAt?: number }>;

export function toProjectRecordFromReturnedRow(project: ReturnedProjectRow) {
  const organizationId =
    "organization_id" in project && typeof project.organization_id === "string"
      ? project.organization_id
      : project.organizationId;
  const archivedAt =
    "archived_at" in project && typeof project.archived_at === "number"
      ? project.archived_at
      : project.archivedAt;
  if (!organizationId) {
    throw new Error(`Project ${project.id} is missing organization id`);
  }

  return toProjectRecord({
    id: project.id,
    organizationId,
    name: project.name,
    slug: project.slug,
    metadata: parseProjectMetadata(project.metadata),
    archivedAt: parseTimestampMs(archivedAt),
  });
}

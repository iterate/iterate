import { OrganizationRole } from "@iterate-com/auth-contract";
import { parseProjectMetadata, parseTimestampMs } from "./db/helpers.ts";
import type { getProjectBySlug, insertProjectReturning } from "./db/queries/index.ts";

// DB row -> wire record mappers shared by the oRPC routers and the Workers
// RPC surface (project-directory.ts). Rows come back from sqlfu in snake_case
// or camelCase depending on the query's SELECT aliases; records are always
// the camelCase shapes declared in @iterate-com/auth-contract.

export function generateId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
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

type ReturnedProjectRow = (getProjectBySlug.Result | insertProjectReturning.Result) &
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

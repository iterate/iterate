import { OrganizationRole } from "@iterate-com/auth-contract";
import { parseProjectMetadata, parseTimestampMs } from "./db/helpers.ts";
import type { getProjectBySlug, insertProjectReturning } from "./db/queries/index.ts";

// DB row -> wire record mappers shared by the oRPC routers and the Workers
// RPC surface (project-directory.ts). Records are always the camelCase shapes
// declared in @iterate-com/auth-contract.

export function generateId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function toMembershipRole(role: string | null | undefined): OrganizationRole {
  return OrganizationRole.parse(role ?? "member");
}

// sqlfu 0.0.3-14 types INSERT ... RETURNING rows from the raw table columns,
// ignoring the `AS camelCase` aliases in project.sql — but at runtime SQLite
// honors aliases in RETURNING exactly like SELECT result columns
// (https://www.sqlite.org/lang_returning.html), so every row this function
// sees has the same camelCase shape as the SELECT queries. The cast papers
// over the generator gap until it is fixed and the types regenerated.
export function toProjectRecordFromReturnedRow(
  row: getProjectBySlug.Result | insertProjectReturning.Result,
) {
  const project = row as getProjectBySlug.Result;
  return {
    id: project.id,
    organizationId: project.organizationId,
    name: project.name,
    slug: project.slug,
    metadata: parseProjectMetadata(project.metadata),
    archivedAt: parseTimestampMs(project.archivedAt)?.toISOString() ?? null,
  };
}

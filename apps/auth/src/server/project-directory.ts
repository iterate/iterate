import {
  InternalCreateProjectForOrganizationInput,
  ProjectInput,
  type ProjectRecord,
} from "@iterate-com/auth-contract";
import type { ProjectCreationResult, UserProjectRecord } from "@iterate-com/auth-contract/worker";
import { slugify } from "@iterate-com/shared/slug";
import { z } from "zod";
import type { DB } from "./db/index.ts";
import { parseProjectMetadata, parseTimestampMs } from "./db/helpers.ts";
import {
  getOrganizationBySlug,
  getProjectAccessForUser,
  getProjectById,
  getProjectBySlug as getProjectBySlugQuery,
  getProjectWithOrganizationBySlug,
  insertProjectReturning,
  listProjectsForUser as listProjectsForUserQuery,
  type getProjectBySlug as GetProjectBySlugQuery,
  type updateProjectReturning,
} from "./db/queries/index.ts";
import type { insertProjectReturning as InsertProjectReturningQuery } from "./db/queries/index.ts";
import { generateId } from "./id.ts";
import { isPlatformAdminUser } from "./platform-admin.ts";

// Auth owns the project directory and is the only authority that mints prj_
// ids. Both the public oRPC router and the private Workers RPC entrypoint call
// these operations, so project identity and collision behavior have one home.

export async function mintProjectId(): Promise<{ id: string }> {
  return { id: generateId("prj") };
}

export async function createProjectForOrganization(
  rawInput: InternalCreateProjectForOrganizationInput,
  client: DB,
): Promise<ProjectCreationResult> {
  const input = InternalCreateProjectForOrganizationInput.parse(rawInput);
  const organization = await getOrganizationBySlug(client, {
    slug: input.organizationSlug,
  });
  if (!organization) {
    return {
      ok: false,
      reason: "organization_not_found",
      message: "Organization not found",
    };
  }

  return createProject(client, {
    id: input.id,
    name: input.name,
    organizationId: organization.id,
    slug: input.slug,
    metadata: input.metadata,
  });
}

export async function createProject(
  client: DB,
  input: {
    id?: string;
    name: string;
    organizationId: string;
    slug?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<ProjectCreationResult> {
  const target = await resolveProjectCreateTarget(client, input);
  if (target.kind === "conflict") {
    return { ok: false, reason: "conflict", message: target.message };
  }
  if (target.kind === "existing") {
    return { ok: true, project: toProjectRecordFromReturnedRow(target.project) };
  }

  const now = Date.now();
  const created = await insertProjectReturning(client, {
    id: input.id ?? generateId("prj"),
    organizationId: input.organizationId,
    name: input.name,
    slug: target.slug,
    metadata: JSON.stringify(input.metadata ?? {}),
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  return { ok: true, project: toProjectRecordFromReturnedRow(created) };
}

type ProjectCreateTarget =
  | { kind: "existing"; project: GetProjectBySlugQuery.Result }
  | { kind: "new"; slug: string }
  | { kind: "conflict"; message: string };

async function resolveProjectCreateTarget(
  client: DB,
  input: { id?: string; name: string; organizationId: string; slug?: string },
): Promise<ProjectCreateTarget> {
  const slug = slugify(input.slug ?? input.name);
  const existingById = input.id ? await getProjectById(client, { id: input.id }) : null;
  if (existingById) {
    if (existingById.organizationId !== input.organizationId) {
      return { kind: "conflict", message: "Project identity is already taken." };
    }
    if (existingById.slug !== slug) {
      return {
        kind: "conflict",
        message: `Project ${input.id} already exists with slug ${existingById.slug}.`,
      };
    }
    return { kind: "existing", project: existingById };
  }

  const existingBySlug = await getProjectBySlugQuery(client, { slug });
  if (!existingBySlug) return { kind: "new", slug };
  if (existingBySlug.organizationId !== input.organizationId) {
    return { kind: "conflict", message: `Project slug ${slug} is already taken.` };
  }
  if (input.id && existingBySlug.id !== input.id) {
    return {
      kind: "conflict",
      message: `Project slug ${slug} already exists with id ${existingBySlug.id}.`,
    };
  }
  return { kind: "existing", project: existingBySlug };
}

export async function getProjectBySlug(
  rawInput: ProjectInput,
  client: DB,
): Promise<ProjectRecord | null> {
  const input = ProjectInput.parse(rawInput);
  const project = await getProjectWithOrganizationBySlug(client, {
    slug: input.projectSlug,
  });
  return project ? toProjectRecordFromReturnedRow(project) : null;
}

export async function listProjectsForUser(
  rawInput: { userId: string },
  client: DB,
): Promise<UserProjectRecord[]> {
  const input = z.object({ userId: z.string().trim().min(1) }).parse(rawInput);
  const projects = await listProjectsForUserQuery(client, { userId: input.userId });
  return projects.map((project) => ({
    id: project.id,
    slug: project.slug,
    organizationId: project.organizationId,
  }));
}

/**
 * Membership OR platform-admin role. Admin-lane projects (created through the
 * deployment admin secret) have no row in this directory at all — the access
 * query anchors on the user so the admin role still carries for them; plain
 * members always need both the project row and an organization membership.
 */
export async function userCanAccessProject(
  rawInput: { projectId: string; userId: string },
  client: DB,
): Promise<boolean> {
  const input = z
    .object({
      projectId: z.string().trim().min(1),
      userId: z.string().trim().min(1),
    })
    .parse(rawInput);
  const access = await getProjectAccessForUser(client, input);
  return (
    access !== null &&
    (isPlatformAdminUser({ role: access.userRole }) || access.hasMembership === 1)
  );
}

export function toProjectRecord(project: {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  metadata: Record<string, unknown>;
  archivedAt?: Date | null;
}): ProjectRecord {
  return {
    id: project.id,
    organizationId: project.organizationId,
    name: project.name,
    slug: project.slug,
    metadata: project.metadata,
    archivedAt: project.archivedAt?.toISOString() ?? null,
  };
}

type ReturnedProjectRow =
  | GetProjectBySlugQuery.Result
  | InsertProjectReturningQuery.Result
  | updateProjectReturning.Result;

export function toProjectRecordFromReturnedRow(project: ReturnedProjectRow): ProjectRecord {
  return toProjectRecord({
    id: project.id,
    organizationId: project.organizationId,
    name: project.name,
    slug: project.slug,
    metadata: parseProjectMetadata(project.metadata),
    archivedAt: parseTimestampMs(project.archivedAt),
  });
}

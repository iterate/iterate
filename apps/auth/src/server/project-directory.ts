import {
  InternalListProjectsInput,
  InternalRegisterProjectInput,
  ProjectIdInput,
  ProjectInput,
  type ProjectDirectoryRecord,
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
  getProjectById as getProjectByIdQuery,
  getProjectBySlug as getProjectBySlugQuery,
  insertProjectIfAbsent,
  listProjects as listProjectsQuery,
  listProjectsForUser as listProjectsForUserQuery,
  type updateProjectReturning,
} from "./db/queries/index.ts";
import type {
  getProjectById as GetProjectByIdQuery,
  getProjectBySlug as GetProjectBySlugQuery,
} from "./db/queries/index.ts";
import { generateId } from "./id.ts";
import { isPlatformAdminUser } from "./platform-admin.ts";

// Auth owns every project identity, including principal-less admin fixtures.
// Both the public oRPC router and the private Workers RPC entrypoint converge
// here, so slug races and retry adoption have one durable authority.
export async function registerProject(
  rawInput: InternalRegisterProjectInput,
  client: DB,
): Promise<ProjectCreationResult> {
  const input = InternalRegisterProjectInput.parse(rawInput);
  let organizationId: string | null = null;
  if (input.organizationSlug !== null) {
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
    organizationId = organization.id;
  }

  return createProject(client, {
    id: input.id,
    name: input.name,
    organizationId,
    slug: input.slug,
    creatorEmail: input.creatorEmail,
    metadata: input.metadata,
  });
}

export async function createProject(
  client: DB,
  input: {
    id?: string;
    name: string;
    organizationId: string | null;
    slug?: string;
    creatorEmail?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<ProjectCreationResult> {
  const id = input.id ?? generateId("prj");
  const slug = slugify(input.slug ?? input.name);
  const now = Date.now();
  await insertProjectIfAbsent(client, {
    id,
    organizationId: input.organizationId,
    creatorEmail: input.creatorEmail ?? null,
    name: input.name,
    slug,
    metadata: JSON.stringify(input.metadata ?? {}),
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  });

  // The unique id/slug constraints choose one winner under concurrency. Read
  // that canonical row after the insert attempt and either adopt it or report
  // a modelled identity conflict. Generated ids may lose a slug race and are
  // deliberately discarded; caller-managed ids must match exactly.
  const target = await resolveProjectCreateTarget(client, input);
  if (target.kind === "conflict") {
    return { ok: false, reason: "conflict", message: target.message };
  }
  if (target.kind === "existing") {
    return { ok: true, project: toProjectDirectoryRecordFromReturnedRow(target.project) };
  }
  throw new Error(`Project registration for slug "${slug}" produced no canonical row.`);
}

type ProjectCreateTarget =
  | { kind: "existing"; project: DirectoryProjectRow }
  | { kind: "new"; slug: string }
  | { kind: "conflict"; message: string };

async function resolveProjectCreateTarget(
  client: DB,
  input: { id?: string; name: string; organizationId: string | null; slug?: string },
): Promise<ProjectCreateTarget> {
  const slug = slugify(input.slug ?? input.name);
  const existingById = input.id ? await getProjectByIdQuery(client, { id: input.id }) : null;
  if (existingById) {
    if (organizationIdOf(existingById) !== input.organizationId) {
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
  if (organizationIdOf(existingBySlug) !== input.organizationId) {
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
): Promise<ProjectDirectoryRecord | null> {
  const input = ProjectInput.parse(rawInput);
  const project = await getProjectBySlugQuery(client, { slug: input.projectSlug });
  return project ? toProjectDirectoryRecordFromReturnedRow(project) : null;
}

export async function getProjectById(
  rawInput: ProjectIdInput,
  client: DB,
): Promise<ProjectDirectoryRecord | null> {
  const input = ProjectIdInput.parse(rawInput);
  const project = await getProjectByIdQuery(client, { id: input.projectId });
  return project ? toProjectDirectoryRecordFromReturnedRow(project) : null;
}

export async function listProjects(
  rawInput: InternalListProjectsInput,
  client: DB,
): Promise<ProjectDirectoryRecord[]> {
  const input = InternalListProjectsInput.parse(rawInput);
  const projects = await listProjectsQuery(client, input);
  return projects.map(toProjectDirectoryRecordFromReturnedRow);
}

export async function listProjectsForUser(
  rawInput: { userId: string },
  client: DB,
): Promise<UserProjectRecord[]> {
  const input = z.object({ userId: z.string().trim().min(1) }).parse(rawInput);
  const projects = await listProjectsForUserQuery(client, { userId: input.userId });
  return projects.map((project) => {
    const organizationId = organizationIdOf(project);
    if (organizationId === null) {
      throw new Error(`User project query returned unowned project ${project.id}.`);
    }
    return {
      id: project.id,
      slug: project.slug,
      organizationId,
    };
  });
}

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

export function toOwnedProjectRecord(project: ProjectDirectoryRecord): ProjectRecord {
  if (project.organizationId === null) {
    throw new Error(`Public project API cannot expose unowned project ${project.id}.`);
  }
  return {
    id: project.id,
    organizationId: project.organizationId,
    name: project.name,
    slug: project.slug,
    metadata: project.metadata,
    archivedAt: project.archivedAt,
  };
}

type DirectoryProjectRow = GetProjectByIdQuery.Result | GetProjectBySlugQuery.Result;

function organizationIdOf(project: { organizationId?: string | null }): string | null {
  return project.organizationId ?? null;
}

export function toProjectDirectoryRecordFromReturnedRow(
  project: DirectoryProjectRow | updateProjectReturning.Result,
): ProjectDirectoryRecord {
  const archivedAt = parseTimestampMs(project.archivedAt);
  return {
    id: project.id,
    organizationId: organizationIdOf(project),
    creatorEmail: project.creatorEmail ?? null,
    name: project.name,
    slug: project.slug,
    metadata: parseProjectMetadata(project.metadata),
    archivedAt: archivedAt?.toISOString() ?? null,
  };
}

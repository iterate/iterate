import {
  CreateProjectForOrganizationInput,
  ProjectInput,
  type ProjectRecord,
  type UserProjectRecord,
} from "@iterate-com/auth-contract";
import { ORPCError } from "@orpc/server";
import { z } from "zod/v4";
import { db } from "./db/index.ts";
import { parseProjectMetadata } from "./db/helpers.ts";
import {
  getOrganizationBySlug,
  getProjectWithOrganizationBySlug,
  insertProjectReturning,
  listProjectsForUser as listProjectsForUserQuery,
} from "./db/queries/index.ts";
import { resolveProjectCreateTarget } from "./project-slugs.ts";
import { generateId, toProjectRecord, toProjectRecordFromReturnedRow } from "./records.ts";

// The auth worker is the project DIRECTORY and the id AUTHORITY for the whole
// platform: it owns the org/project tables users manage through OAuth-time
// project selection, and it is the only minter of the `prj_` id space (OS
// never invents ids that could collide). OS workers call these functions over
// the AUTH service binding — see the AuthWorkerRpc doc in
// @iterate-com/auth-contract for the trust model, and
// apps/auth/src/server/worker.ts for the entrypoint that exposes them.
//
// Inputs are zod-parsed even though callers are first-party workers: RPC
// crosses a deploy boundary, and the two sides can be skewed mid-rollout.
//
// Errors are ORPCError so the conflict/not-found vocabulary stays shared with
// the oRPC routers (project-slugs.ts serves both). Over Workers RPC they
// arrive as plain Errors — the message survives, the code does not — and no
// OS caller branches on codes.

/** See AuthWorkerRpc.mintProjectId. */
export async function mintProjectId(): Promise<{ id: string }> {
  return { id: generateId("prj") };
}

/** See AuthWorkerRpc.createProjectForOrganization. */
export async function createProjectForOrganization(
  rawInput: CreateProjectForOrganizationInput,
): Promise<ProjectRecord> {
  const input = CreateProjectForOrganizationInput.parse(rawInput);
  const organization = await getOrganizationBySlug(db, {
    slug: input.organizationSlug,
  });
  if (!organization) {
    throw new ORPCError("NOT_FOUND", { message: "Organization not found" });
  }

  const target = await resolveProjectCreateTarget({
    db,
    id: input.id,
    name: input.name,
    organizationId: organization.id,
    slug: input.slug,
  });
  if (target.kind === "existing") {
    return toProjectRecordFromReturnedRow(target.project);
  }

  const now = Date.now();
  const created = await insertProjectReturning(db, {
    id: input.id ?? generateId("prj"),
    organizationId: organization.id,
    name: input.name,
    slug: target.slug,
    metadata: JSON.stringify(input.metadata ?? {}),
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  });

  return toProjectRecordFromReturnedRow(created);
}

/** See AuthWorkerRpc.getProjectBySlug. Callers enforce their own
 * authorization — OS ingress only maps slug -> id, and OS server reads check
 * the reader's org membership themselves. */
export async function getProjectBySlug(rawInput: ProjectInput): Promise<ProjectRecord | null> {
  const input = ProjectInput.parse(rawInput);
  const projectRow = await getProjectWithOrganizationBySlug(db, {
    slug: input.projectSlug,
  });
  if (!projectRow) return null;
  return toProjectRecord({
    id: projectRow.id,
    organizationId: projectRow.organizationId,
    name: projectRow.name,
    slug: projectRow.slug,
    metadata: parseProjectMetadata(projectRow.metadata),
    archivedAt: typeof projectRow.archivedAt === "number" ? new Date(projectRow.archivedAt) : null,
  });
}

const ListProjectsForUserInput = z.object({ userId: z.string().min(1) });

/** See AuthWorkerRpc.listProjectsForUser. Same query the OAuth project claims
 * are built from (auth-plugins.ts), so OS's stale-claims fallback and the
 * token claims can never disagree. */
export async function listProjectsForUser(
  rawInput: z.infer<typeof ListProjectsForUserInput>,
): Promise<UserProjectRecord[]> {
  const input = ListProjectsForUserInput.parse(rawInput);
  const projects = await listProjectsForUserQuery(db, { userId: input.userId });
  return projects.map((project) => ({
    id: project.id,
    slug: project.slug,
    organizationId: project.organizationId,
  }));
}

import { ORPCError } from "@orpc/server";
import { resolveUniqueSlug, slugify } from "@iterate-com/shared/slug";
import {
  organizationAdminMiddleware,
  organizationScopedMiddleware,
  os,
  projectAdminMiddleware,
  projectScopedMiddleware,
} from "../orpc.ts";
import { parseProjectMetadata, parseTimestampMs } from "../../db/helpers.ts";
import {
  deleteProjectById,
  getProjectBySlug,
  insertProjectReturning,
  listProjectsByOrganizationId,
  updateProjectReturning,
} from "../../db/queries/index.ts";
import { generateId, toProjectRecord } from "./_shared.ts";

const list = os.project.list.use(organizationScopedMiddleware).handler(async ({ context }) => {
  const projects = await listProjectsByOrganizationId(context.db, {
    organizationId: context.organization.id,
  });

  return projects.map((project) =>
    toProjectRecord({
      id: project.id,
      organizationId: project.organizationId,
      name: project.name,
      slug: project.slug,
      metadata: parseProjectMetadata(project.metadata),
      archivedAt: parseTimestampMs(project.archivedAt),
    }),
  );
});

const bySlug = os.project.bySlug.use(projectScopedMiddleware).handler(async ({ context }) => {
  return toProjectRecord(context.project);
});

const create = os.project.create
  .use(organizationAdminMiddleware)
  .handler(async ({ context, input }) => {
    const slug = await resolveUniqueSlug({
      name: input.name,
      slug: input.slug,
      isTaken: async (candidate) =>
        Boolean(await getProjectBySlug(context.db, { slug: candidate })),
    });
    const now = Date.now();
    const created = await insertProjectReturning(context.db, {
      id: generateId("prj"),
      organizationId: context.organization.id,
      name: input.name,
      slug,
      metadata: JSON.stringify(input.metadata ?? {}),
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    if (!created) {
      throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Failed to create project" });
    }

    return toProjectRecord({
      id: created.id,
      organizationId: created.organization_id,
      name: created.name,
      slug: created.slug,
      metadata: parseProjectMetadata(created.metadata),
      archivedAt: parseTimestampMs(created.archived_at),
    });
  });

const update = os.project.update.use(projectAdminMiddleware).handler(async ({ context, input }) => {
  const updated = await updateProjectReturning(
    context.db,
    {
      name: input.name ?? context.project.name,
      slug: input.slug ? slugify(input.slug) : context.project.slug,
      metadata: JSON.stringify(input.metadata ?? context.project.metadata),
      updatedAt: Date.now(),
    },
    {
      id: context.project.id,
    },
  );

  if (!updated) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Failed to update project" });
  }

  return toProjectRecord({
    id: updated.id,
    organizationId: updated.organization_id,
    name: updated.name,
    slug: updated.slug,
    metadata: parseProjectMetadata(updated.metadata),
    archivedAt: parseTimestampMs(updated.archived_at),
  });
});

const remove = os.project.delete.use(projectAdminMiddleware).handler(async ({ context }) => {
  await deleteProjectById(context.db, { id: context.project.id });

  return { success: true as const };
});

export const project = os.project.router({
  list,
  bySlug,
  create,
  update,
  delete: remove,
});

import { ORPCError } from "@orpc/server";
import {
  organizationAdminMiddleware,
  organizationScopedMiddleware,
  os,
  projectAdminMiddleware,
} from "../orpc.ts";
import {
  deleteProjectById,
  insertProjectReturning,
  listProjectsByOrganizationId,
} from "../../db/queries/index.ts";
import { generateId, toProjectRecordFromReturnedRow } from "../../records.ts";
import { resolveProjectCreateTarget } from "../../project-slugs.ts";

const list = os.project.list.use(organizationScopedMiddleware).handler(async ({ context }) => {
  const projects = await listProjectsByOrganizationId(context.db, {
    organizationId: context.organization.id,
  });

  return projects.map(toProjectRecordFromReturnedRow);
});

const create = os.project.create
  .use(organizationAdminMiddleware)
  .handler(async ({ context, input }) => {
    const target = await resolveProjectCreateTarget({
      db: context.db,
      name: input.name,
      organizationId: context.organization.id,
      slug: input.slug,
    });
    if (target.kind === "existing") {
      return toProjectRecordFromReturnedRow(target.project);
    }

    const now = Date.now();
    const created = await insertProjectReturning(context.db, {
      id: generateId("prj"),
      organizationId: context.organization.id,
      name: input.name,
      slug: target.slug,
      metadata: JSON.stringify({}),
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    if (!created) {
      throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Failed to create project" });
    }

    return toProjectRecordFromReturnedRow(created);
  });

const remove = os.project.delete.use(projectAdminMiddleware).handler(async ({ context }) => {
  await deleteProjectById(context.db, { id: context.project.id });

  return { success: true as const };
});

export const project = os.project.router({
  list,
  create,
  delete: remove,
});

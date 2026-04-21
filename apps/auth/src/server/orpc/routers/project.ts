import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { slugify, slugifyWithSuffix } from "@iterate-com/shared/slug";
import {
  organizationAdminMiddleware,
  organizationScopedMiddleware,
  os,
  projectAdminMiddleware,
  projectScopedMiddleware,
} from "../orpc.ts";
import { schema } from "../../db/index.ts";
import { generateId, toProjectRecord } from "./_shared.ts";

const list = os.project.list.use(organizationScopedMiddleware).handler(async ({ context }) => {
  const projects = await context.db.query.project.findMany({
    where: eq(schema.project.organizationId, context.organization.id),
  });

  return projects.map(toProjectRecord);
});

const bySlug = os.project.bySlug.use(projectScopedMiddleware).handler(async ({ context }) => {
  return toProjectRecord(context.project);
});

const create = os.project.create
  .use(organizationAdminMiddleware)
  .handler(async ({ context, input }) => {
    const baseSlug = input.slug ? slugify(input.slug) : slugify(input.name);
    const existing = await context.db.query.project.findFirst({
      where: eq(schema.project.slug, baseSlug),
    });

    const slug = existing ? slugifyWithSuffix(baseSlug) : baseSlug;
    const [created] = await context.db
      .insert(schema.project)
      .values({
        id: generateId("prj"),
        organizationId: context.organization.id,
        name: input.name,
        slug,
        metadata: input.metadata ?? {},
        archivedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    if (!created) {
      throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Failed to create project" });
    }

    return toProjectRecord(created);
  });

const update = os.project.update.use(projectAdminMiddleware).handler(async ({ context, input }) => {
  const [updated] = await context.db
    .update(schema.project)
    .set({
      ...(input.name ? { name: input.name } : {}),
      ...(input.slug ? { slug: slugify(input.slug) } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.project.id, context.project.id))
    .returning();

  if (!updated) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Failed to update project" });
  }

  return toProjectRecord(updated);
});

const remove = os.project.delete.use(projectAdminMiddleware).handler(async ({ context }) => {
  await context.db.delete(schema.project).where(eq(schema.project.id, context.project.id));

  return { success: true as const };
});

export const project = os.project.router({
  list,
  bySlug,
  create,
  update,
  delete: remove,
});

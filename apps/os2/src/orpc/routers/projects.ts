import { ORPCError } from "@orpc/server";
import { typeid } from "@iterate-com/shared/typeid";
import {
  countProjects,
  deleteProject,
  getProjectById,
  insertProject,
  listProjects,
} from "~/db/queries/.generated/index.ts";
import { os } from "~/orpc/orpc.ts";

type ProjectRow = {
  id: string;
  slug: string;
  metadata: string;
  created_at: string;
  updated_at: string;
};

function typeIdEnv(typeIdPrefix: string) {
  return { TYPEID_PREFIX: typeIdPrefix };
}

function toProject(row: ProjectRow) {
  return {
    id: row.id,
    slug: row.slug,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const projectsRouter = {
  projects: {
    create: os.projects.create.handler(async ({ context, input }) => {
      const id = typeid({
        env: typeIdEnv(context.config.typeIdPrefix.exposeSecret()),
        prefix: "proj",
      });

      const row = await insertProject(context.db, {
        id,
        slug: input.slug,
        metadata: JSON.stringify(input.metadata),
      });

      if (!row) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message: `Project ${id} was not returned after insert`,
        });
      }

      return toProject(row);
    }),
    list: os.projects.list.handler(async ({ context, input }) => {
      const [totalRow, rows] = await Promise.all([
        countProjects(context.db),
        listProjects(context.db, { limit: input.limit, offset: input.offset }),
      ]);

      return { projects: rows.map(toProject), total: totalRow?.total ?? 0 };
    }),
    find: os.projects.find.handler(async ({ context, input }) => {
      const row = await getProjectById(context.db, { id: input.id });

      if (!row) {
        throw new ORPCError("NOT_FOUND", { message: `Project ${input.id} not found` });
      }

      return toProject(row);
    }),
    remove: os.projects.remove.handler(async ({ context, input }) => {
      const existing = await getProjectById(context.db, { id: input.id });

      if (!existing) {
        return { ok: true as const, id: input.id, deleted: false };
      }

      await deleteProject(context.db, { id: input.id });
      return { ok: true as const, id: input.id, deleted: true };
    }),
  },
};

import { ORPCError } from "@orpc/server";
import { typeid } from "@iterate-com/shared/typeid";
import {
  countProjects,
  deleteProject,
  getProjectById,
  insertProject,
  listProjects,
  updateProjectConfig,
} from "~/db/queries/.generated/index.ts";
import {
  isReservedProjectHostname,
  isValidCustomHostname,
  normalizeCustomHostname,
} from "~/lib/project-host-routing.ts";
import { os } from "~/orpc/orpc.ts";

type ProjectRow = {
  id: string;
  slug: string;
  custom_hostname?: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
};

function toProject(row: ProjectRow) {
  return {
    id: row.id,
    slug: row.slug,
    customHostname: row.custom_hostname ?? null,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeConfigCustomHostname(
  input: string | null | undefined,
  projectHostnameBases: readonly string[],
) {
  if (input === undefined) return undefined;

  const customHostname = normalizeCustomHostname(input);
  if (customHostname === null) return null;

  if (!isValidCustomHostname(customHostname)) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Custom hostname must be a valid DNS hostname.",
    });
  }

  if (isReservedProjectHostname(customHostname, projectHostnameBases)) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Custom hostname cannot use a reserved OS project hostname.",
    });
  }

  return customHostname;
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed");
}

export const projectsRouter = {
  projects: {
    create: os.projects.create.handler(async ({ context, input }) => {
      const id = typeid({
        env: { TYPEID_PREFIX: context.config.typeIdPrefix.exposeSecret() },
        prefix: "proj",
      });

      try {
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
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new ORPCError("CONFLICT", {
            message: `A project with slug ${input.slug} already exists.`,
          });
        }

        throw error;
      }
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
    updateConfig: os.projects.updateConfig.handler(async ({ context, input }) => {
      const existing = await getProjectById(context.db, { id: input.id });

      if (!existing) {
        throw new ORPCError("NOT_FOUND", { message: `Project ${input.id} not found` });
      }

      const normalizedCustomHostname = normalizeConfigCustomHostname(
        input.customHostname,
        context.projectHostnameBases,
      );
      const nextCustomHostname =
        normalizedCustomHostname === undefined
          ? (existing.custom_hostname ?? null)
          : normalizedCustomHostname;
      const nextMetadata =
        input.metadata ?? (JSON.parse(existing.metadata) as Record<string, unknown>);

      try {
        await updateProjectConfig(
          context.db,
          {
            customHostname: nextCustomHostname,
            metadata: JSON.stringify(nextMetadata),
            updatedAt: new Date().toISOString(),
          },
          { id: input.id },
        );
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new ORPCError("CONFLICT", {
            message: `Custom hostname ${nextCustomHostname} is already assigned.`,
          });
        }

        throw error;
      }

      const row = await getProjectById(context.db, { id: input.id });
      if (!row) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message: `Project ${input.id} was not returned after update`,
        });
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

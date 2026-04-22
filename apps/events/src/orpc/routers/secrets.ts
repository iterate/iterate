import { ORPCError } from "@orpc/server";
import {
  countSecrets,
  deleteSecret,
  getSecretById,
  insertSecret,
  listSecrets,
} from "#sql/.generated/index.ts";
import { os, withProject } from "~/orpc/orpc.ts";

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /unique|UNIQUE constraint/i.test(error.message);
}

export const secretsRouter = {
  secrets: {
    create: os.secrets.create.use(withProject).handler(async ({ context, input }) => {
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const name = input.name.trim();

      try {
        await insertSecret(context.db, {
          id,
          projectSlug: context.projectSlug,
          name,
          value: input.value,
          description: input.description ?? null,
          createdAt: now,
          updatedAt: now,
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new ORPCError("CONFLICT", {
            message: `Secret name "${name}" already exists in project "${context.projectSlug}"`,
          });
        }
        throw error;
      }

      return {
        id,
        name,
        description: input.description ?? null,
        createdAt: now,
        updatedAt: now,
      };
    }),
    list: os.secrets.list.use(withProject).handler(async ({ context, input }) => {
      const [totalRow, rows] = await Promise.all([
        countSecrets(context.db, { projectSlug: context.projectSlug }),
        listSecrets(context.db, {
          projectSlug: context.projectSlug,
          limit: input.limit,
          offset: input.offset,
        }),
      ]);

      return {
        secrets: rows.map((row) => ({
          id: row.id,
          name: row.name,
          description: row.description ?? null,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
        total: totalRow?.total ?? 0,
      };
    }),
    remove: os.secrets.remove.use(withProject).handler(async ({ context, input }) => {
      const existing = await getSecretById(context.db, {
        id: input.id,
        projectSlug: context.projectSlug,
      });

      if (!existing) {
        return { ok: true as const, id: input.id, deleted: false };
      }

      await deleteSecret(context.db, { id: input.id, projectSlug: context.projectSlug });
      return { ok: true as const, id: input.id, deleted: true };
    }),
  },
};

import { and, desc, eq, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { secretsTable } from "~/db/schema.ts";
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
        await context.db.insert(secretsTable).values({
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
      const scopedTotalRow = await context.db
        .select({ value: sql<number>`count(*)` })
        .from(secretsTable)
        .where(eq(secretsTable.projectSlug, context.projectSlug));
      const rows = await context.db
        .select({
          id: secretsTable.id,
          name: secretsTable.name,
          description: secretsTable.description,
          createdAt: secretsTable.createdAt,
          updatedAt: secretsTable.updatedAt,
        })
        .from(secretsTable)
        .where(eq(secretsTable.projectSlug, context.projectSlug))
        .orderBy(desc(secretsTable.createdAt))
        .limit(input.limit)
        .offset(input.offset);

      return { secrets: rows, total: scopedTotalRow[0]?.value ?? 0 };
    }),
    remove: os.secrets.remove.use(withProject).handler(async ({ context, input }) => {
      const [existing] = await context.db
        .select()
        .from(secretsTable)
        .where(
          and(eq(secretsTable.id, input.id), eq(secretsTable.projectSlug, context.projectSlug)),
        )
        .limit(1);

      if (!existing) {
        return { ok: true as const, id: input.id, deleted: false };
      }

      await context.db
        .delete(secretsTable)
        .where(
          and(eq(secretsTable.id, input.id), eq(secretsTable.projectSlug, context.projectSlug)),
        );
      return { ok: true as const, id: input.id, deleted: true };
    }),
  },
};

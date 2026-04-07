import { desc, eq, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { secretsTable } from "~/db/schema.ts";
import { os } from "~/orpc/orpc.ts";

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /unique|UNIQUE constraint/i.test(error.message);
}

export const secretsRouter = {
  secrets: {
    create: os.secrets.create.handler(async ({ context, input }) => {
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const name = input.name.trim();

      try {
        await context.db.insert(secretsTable).values({
          id,
          name,
          value: input.value,
          description: input.description ?? null,
          createdAt: now,
          updatedAt: now,
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new ORPCError("CONFLICT", { message: `Env var name "${name}" already exists` });
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
    list: os.secrets.list.handler(async ({ context, input }) => {
      const [totalRow] = await context.db
        .select({ value: sql<number>`count(*)` })
        .from(secretsTable);
      const rows = await context.db
        .select({
          id: secretsTable.id,
          name: secretsTable.name,
          description: secretsTable.description,
          createdAt: secretsTable.createdAt,
          updatedAt: secretsTable.updatedAt,
        })
        .from(secretsTable)
        .orderBy(desc(secretsTable.createdAt))
        .limit(input.limit)
        .offset(input.offset);

      return { secrets: rows, total: totalRow?.value ?? 0 };
    }),
    remove: os.secrets.remove.handler(async ({ context, input }) => {
      const [existing] = await context.db
        .select()
        .from(secretsTable)
        .where(eq(secretsTable.id, input.id))
        .limit(1);

      if (!existing) {
        return { ok: true as const, id: input.id, deleted: false };
      }

      await context.db.delete(secretsTable).where(eq(secretsTable.id, input.id));
      return { ok: true as const, id: input.id, deleted: true };
    }),
  },
};

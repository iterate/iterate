import { desc, eq, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { codemodeSecretsTable } from "~/db/schema.ts";
import { os } from "~/orpc/orpc.ts";

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /unique|UNIQUE constraint/i.test(error.message);
}

export const secretsRouter = {
  secrets: {
    create: os.secrets.create.handler(async ({ context, input }) => {
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const key = input.key.trim();

      try {
        await context.db.insert(codemodeSecretsTable).values({
          id,
          key,
          value: input.value,
          description: input.description?.trim() || null,
          createdAt: now,
          updatedAt: now,
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new ORPCError("CONFLICT", {
            message: `Secret key "${key}" already exists`,
          });
        }

        throw error;
      }

      return {
        id,
        key,
        description: input.description?.trim() || null,
        createdAt: now,
        updatedAt: now,
      };
    }),
    list: os.secrets.list.handler(async ({ context, input }) => {
      const [totalRow] = await context.db
        .select({ value: sql<number>`count(*)` })
        .from(codemodeSecretsTable);
      const secrets = await context.db
        .select({
          id: codemodeSecretsTable.id,
          key: codemodeSecretsTable.key,
          description: codemodeSecretsTable.description,
          createdAt: codemodeSecretsTable.createdAt,
          updatedAt: codemodeSecretsTable.updatedAt,
        })
        .from(codemodeSecretsTable)
        .orderBy(desc(codemodeSecretsTable.createdAt))
        .limit(input.limit)
        .offset(input.offset);

      return {
        secrets,
        total: totalRow?.value ?? 0,
      };
    }),
    find: os.secrets.find.handler(async ({ context, input }) => {
      const [secret] = await context.db
        .select()
        .from(codemodeSecretsTable)
        .where(eq(codemodeSecretsTable.id, input.id))
        .limit(1);

      if (!secret) {
        throw new ORPCError("NOT_FOUND", {
          message: `Secret ${input.id} not found`,
        });
      }

      return {
        id: secret.id,
        key: secret.key,
        value: secret.value,
        description: secret.description,
        createdAt: secret.createdAt,
        updatedAt: secret.updatedAt,
      };
    }),
    remove: os.secrets.remove.handler(async ({ context, input }) => {
      const [existing] = await context.db
        .select()
        .from(codemodeSecretsTable)
        .where(eq(codemodeSecretsTable.id, input.id))
        .limit(1);

      if (!existing) {
        return {
          ok: true as const,
          id: input.id,
          deleted: false,
        };
      }

      await context.db.delete(codemodeSecretsTable).where(eq(codemodeSecretsTable.id, input.id));

      return {
        ok: true as const,
        id: input.id,
        deleted: true,
      };
    }),
  },
};

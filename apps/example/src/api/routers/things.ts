import { desc, eq, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { thingsTable } from "../db/schema.ts";
import { os } from "../base.ts";

export const thingsRouter = {
  things: {
    create: os.things.create.handler(async ({ context, input }) => {
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      await context.db.insert(thingsTable).values({
        id,
        thing: input.thing,
        createdAt: now,
        updatedAt: now,
      });
      return { id, thing: input.thing, createdAt: now, updatedAt: now };
    }),
    list: os.things.list.handler(async ({ context, input }) => {
      const [totalRow] = await context.db
        .select({ value: sql<number>`count(*)` })
        .from(thingsTable);
      const rows = await context.db
        .select()
        .from(thingsTable)
        .orderBy(desc(thingsTable.createdAt))
        .limit(input.limit)
        .offset(input.offset);
      return { things: rows, total: totalRow?.value ?? 0 };
    }),
    find: os.things.find.handler(async ({ context, input }) => {
      const [row] = await context.db
        .select()
        .from(thingsTable)
        .where(eq(thingsTable.id, input.id))
        .limit(1);
      if (!row) throw new ORPCError("NOT_FOUND", { message: `Thing ${input.id} not found` });
      return row;
    }),
    remove: os.things.remove.handler(async ({ context, input }) => {
      const [existing] = await context.db
        .select()
        .from(thingsTable)
        .where(eq(thingsTable.id, input.id))
        .limit(1);
      if (!existing) return { ok: true as const, id: input.id, deleted: false };
      await context.db.delete(thingsTable).where(eq(thingsTable.id, input.id));
      return { ok: true as const, id: input.id, deleted: true };
    }),
  },
};

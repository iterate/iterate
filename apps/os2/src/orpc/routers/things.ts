import { ORPCError } from "@orpc/server";
import {
  countThings,
  deleteThing,
  getThingById,
  insertThing,
  listThings,
} from "~/db/queries/.generated/index.ts";
import { os } from "~/orpc/orpc.ts";

function toThing(row: { id: string; thing: string; created_at: string; updated_at: string }) {
  return {
    id: row.id,
    thing: row.thing,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const thingsRouter = {
  things: {
    create: os.things.create.handler(async ({ context, input }) => {
      const now = new Date().toISOString();
      const id = crypto.randomUUID();

      await insertThing(context.db, {
        id,
        thing: input.thing,
        createdAt: now,
        updatedAt: now,
      });

      return { id, thing: input.thing, createdAt: now, updatedAt: now };
    }),
    list: os.things.list.handler(async ({ context, input }) => {
      const [totalRow, rows] = await Promise.all([
        countThings(context.db),
        listThings(context.db, { limit: input.limit, offset: input.offset }),
      ]);

      return { things: rows.map(toThing), total: totalRow?.total ?? 0 };
    }),
    find: os.things.find.handler(async ({ context, input }) => {
      const row = await getThingById(context.db, { id: input.id });

      if (!row) {
        throw new ORPCError("NOT_FOUND", { message: `Thing ${input.id} not found` });
      }

      return toThing(row);
    }),
    remove: os.things.remove.handler(async ({ context, input }) => {
      const existing = await getThingById(context.db, { id: input.id });

      if (!existing) {
        return { ok: true as const, id: input.id, deleted: false };
      }

      await deleteThing(context.db, { id: input.id });
      return { ok: true as const, id: input.id, deleted: true };
    }),
  },
};

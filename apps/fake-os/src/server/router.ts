import { os } from "@orpc/server";
import { z } from "zod";
import { db } from "./db/index.ts";
import { todosTable } from "./db/schema.ts";
import { eq } from "drizzle-orm";

const base = os.$context<object>();

export const router = base.router({
  health: base.handler(() => ({ ok: true as const, time: new Date().toISOString() })),

  todos: base.router({
    list: base.handler(async () => {
      return db.select().from(todosTable).all();
    }),

    create: base
      .input(z.object({ title: z.string().min(1) }))
      .handler(async ({ input }) => {
        return db.insert(todosTable).values({ title: input.title }).returning().get();
      }),

    toggle: base
      .input(z.object({ id: z.number() }))
      .handler(async ({ input }) => {
        const todo = db.select().from(todosTable).where(eq(todosTable.id, input.id)).get();
        if (!todo) throw new Error("Todo not found");
        return db
          .update(todosTable)
          .set({ completed: !todo.completed })
          .where(eq(todosTable.id, input.id))
          .returning()
          .get();
      }),

    delete: base
      .input(z.object({ id: z.number() }))
      .handler(async ({ input }) => {
        db.delete(todosTable).where(eq(todosTable.id, input.id)).run();
        return { ok: true as const };
      }),
  }),
});

export type Router = typeof router;

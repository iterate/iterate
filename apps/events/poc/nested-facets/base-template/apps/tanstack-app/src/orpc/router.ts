import { implement } from "@orpc/server";
import { desc, eq, sql } from "drizzle-orm";
import { appContract } from "./contract";
import type { AppContext } from "../context";
import { thingsTable } from "../db/schema";

const os = implement(appContract).$context<AppContext>();

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export const appRouter = os.router({
  ping: os.ping.handler(async () => ({
    message: "pong",
    time: new Date().toISOString(),
  })),

  things: {
    list: os.things.list.handler(async ({ context }) => {
      console.log("[oRPC] things.list called");
      const [countRow] = await context.db
        .select({ value: sql<number>`count(*)` })
        .from(thingsTable);
      const items = await context.db
        .select()
        .from(thingsTable)
        .orderBy(desc(thingsTable.createdAt));
      return { items, total: countRow?.value ?? 0 };
    }),

    create: os.things.create.handler(async ({ context, input }) => {
      console.log("[oRPC] things.create called:", input.name);
      const id = "thing_" + crypto.randomUUID().slice(0, 8);
      const createdAt = new Date().toISOString();
      await context.db.insert(thingsTable).values({
        id,
        name: input.name,
        createdAt,
      });
      return { id, name: input.name, createdAt };
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

  test: {
    randomLogStream: os.test.randomLogStream.handler(async function* ({ input, signal }) {
      for (let i = 0; i < input.count; i++) {
        if (signal?.aborted) return;
        const delay = randomInt(input.minDelayMs, input.maxDelayMs);
        await sleep(delay, signal);
        if (signal?.aborted) return;
        yield `${new Date().toISOString()} random[${i + 1}/${input.count}] delay=${delay}ms value=${Math.random().toFixed(6)}`;
      }
    }),
  },
});

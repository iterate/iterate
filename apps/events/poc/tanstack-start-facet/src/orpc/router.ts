import { implement } from "@orpc/server";
import { appContract } from "./contract";

const os = implement(appContract).$context<{}>();

// In-memory store (for plain worker demo; facet version uses DO SQLite)
const things: Array<{ id: string; name: string; createdAt: string }> = [];

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
    list: os.things.list.handler(async () => ({
      items: [...things].reverse(),
      total: things.length,
    })),

    create: os.things.create.handler(async ({ input }) => {
      const thing = {
        id: "thing_" + crypto.randomUUID().slice(0, 8),
        name: input.name,
        createdAt: new Date().toISOString(),
      };
      things.push(thing);
      return thing;
    }),

    remove: os.things.remove.handler(async ({ input }) => {
      const idx = things.findIndex((t) => t.id === input.id);
      if (idx === -1) return { ok: true as const, id: input.id, deleted: false };
      things.splice(idx, 1);
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

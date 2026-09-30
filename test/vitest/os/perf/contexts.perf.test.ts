// vitest/os/perf/contexts.perf.test.ts — THE COLD AND WARM PATHS OF ONE CONTEXT: a context's first append (the
// Durable Object born by it: constructor, `created`/`woken`, core state), a durable append on a warm
// one, loaded code's append on its own context and on another, the first call after the platform
// evicted an idle one, and a processor's cold start (the loader, the class, the first reduce). The
// bench (vitest/os/bench/api.bench.ts) explores the same paths by hand; these are the ones held to a budget.
// One warm session per row, as a client keeps one open, so a sample is the platform's and not a
// WebSocket handshake.

import { expect, test } from "vitest";
import {
  adminCredentials,
  freshCtx,
  openItx,
  readAll,
  session,
  sleep,
} from "../../../helpers/client.ts";
import { enableFixtureProcessor } from "../../../helpers/sources.ts";
import { recordLatency } from "./record.ts";

test("a context's first append, then durable appends on a warm context", async ({ task }) => {
  const api = session().authenticate(adminCredentials());
  const first: number[] = [];
  for (let i = 0; i < 10; i++) {
    const itx = api.projects.get(freshCtx("first"));
    first.push(await timed(() => itx.append({ type: "perf/first", payload: { i } })));
  }
  const warm = openItx(freshCtx("warm"));
  await warm.append({ type: "perf/warm-up" });
  const appends: number[] = [];
  for (let i = 0; i < 20; i++)
    appends.push(await timed(() => warm.append({ type: "perf/append", payload: { i } })));
  expect(await readAll(warm)).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: "perf/append", payload: { i: 19 } })]),
  );
  recordLatency(task, "context.first-append", first);
  recordLatency(task, "context.append", appends);
});

/** Loaded code that times its own appends inside its isolate: `Date.now` advances on I/O and each
 *  append is one, so a sample is the platform's hop and not the client's round trip. */
const APPENDER = {
  "package.json": '{"main":"worker.js"}',
  "worker.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  async timed(path, writers, each) {
    using itx = this.getItx();
    const ms = [];
    const started = Date.now();
    await Promise.all(Array.from({ length: writers }, async (_, w) => {
      for (let i = 0; i < each; i++) {
        const t = Date.now();
        await (path ? itx.cd(path) : itx).append({ type: "perf/loaded", payload: { w, i } });
        ms.push(Date.now() - t);
      }
    }));
    return { ms, wallMs: Date.now() - started };
  }
}`,
};

// Anyone appends anywhere: loaded code's `cd(path).append` writes another context's log, one Durable
// Object hop beyond its own append, and is how one agent's code speaks to another's.
test("loaded code's durable append: on its own context, through cd(path) to a sibling and to the root, and ten writers at once", async ({
  task,
}) => {
  const root = openItx(freshCtx("loaded-append"));
  for (const path of ["/", "/x", "/y"]) await root.cd(path).append({ type: "perf/warm-up" });
  const appender = () => root.cd("/x").workers.get({ source: APPENDER });
  await appender().timed(null, 1, 3);
  const own = await appender().timed(null, 1, 20);
  const sibling = await appender().timed("/y", 1, 20);
  const up = await appender().timed("/", 1, 20);
  const rates: number[] = [];
  for (let round = 0; round < 3; round++) {
    const { ms, wallMs } = await appender().timed("/y", 10, 10);
    rates.push((ms.length * 1000) / wallMs);
  }
  expect(
    (await readAll(root.cd("/y")))
      .filter((event) => event.type === "perf/loaded")
      .map((event) => event.source.origin),
    "every append landed at the sibling, stamped with the context whose code wrote it",
  ).toEqual(Array.from({ length: 320 }, () => "/x"));
  recordLatency(task, "context.append.loaded", own.ms);
  recordLatency(task, "context.append.cross", [...sibling.ms, ...up.ms]);
  recordLatency(task, "context.append.cross.x10", rates);
});

// The platform evicts an idle actor after ~10 s (client.ts `idleAcrossEvictions`: 0/6 at 10 s, 48/48
// at 12 s+, measured 2026-09-22), and each incarnation logs one `itx/woken`: a sample counts only
// when the log proves the context was evicted in between.
test("a context the platform evicted answers its first call", async ({ task }) => {
  const contexts = Array.from({ length: 5 }, () => openItx(freshCtx("wake")));
  await Promise.all(contexts.map((itx) => itx.whoami()));
  const before = await Promise.all(contexts.map(incarnations));
  await sleep(15_000);
  const woken = await Promise.all(
    contexts.map(async (itx, i) => {
      const ms = await timed(() => itx.whoami());
      return { ms, evicted: (await incarnations(itx)) > before[i]! };
    }),
  );
  const samples = woken.filter((wake) => wake.evicted).map((wake) => wake.ms);
  // fewer than 3 of 5 evicted in 15 s: the idle eviction this row relies on has moved
  expect(
    samples.length,
    `evicted after 15 s idle: ${JSON.stringify(woken)}`,
  ).toBeGreaterThanOrEqual(3);
  recordLatency(task, "context.wake", samples);
});

test("a processor's cold start: enabled on a fresh context until it reduced the first event", async ({
  task,
}) => {
  const api = session().authenticate(adminCredentials());
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    const itx = api.projects.get(freshCtx("cold"));
    samples.push(
      await timed(async () => {
        await enableFixtureProcessor(itx, "tally");
        await itx.invoke(
          `itx.facets.get('tally').waitUntilProcessed({ offset: 1, timeoutMs: 30000 })`,
        );
      }),
    );
  }
  recordLatency(task, "facet.cold-start", samples);
});

/** How many incarnations the context's log records: one `itx/woken` each. */
async function incarnations(itx: any) {
  return (await readAll(itx)).filter((e) => e.type === "events.iterate.com/itx/woken").length;
}

/** `ms` of `call`, started now. */
async function timed(call: () => Promise<unknown>) {
  const started = performance.now();
  await call();
  return performance.now() - started;
}

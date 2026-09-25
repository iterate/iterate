// perf/contexts.perf.test.ts — THE COLD AND WARM PATHS OF ONE CONTEXT: a context's first append (the
// Durable Object born by it: constructor, `created`/`woken`, core state), a durable append on a warm
// one, the first call after the platform evicted an idle one, and a processor's cold start (the
// loader, the class, the first reduce). The bench (bench/api.bench.ts) explores the same paths by
// hand; these are the ones held to a budget. One warm session per row, as a client keeps one open, so
// a sample is the platform's and not a WebSocket handshake.

import { expect, test } from "vitest";
import {
  adminCredentials,
  freshCtx,
  openItx,
  readAll,
  session,
  sleep,
} from "../e2e/support/client.ts";
import { enableFixtureProcessor } from "../e2e/support/sources.ts";
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

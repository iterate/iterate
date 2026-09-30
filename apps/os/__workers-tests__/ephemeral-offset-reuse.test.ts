// ephemeral-offset-reuse.test.ts — the zero-write contract under eviction, on the real DO: an
// ephemeral's offset is unique WITHIN an incarnation and a later incarnation may hand it to a
// durable, so NOTHING a reader persists (a facet's checkpoint, a stream-kept cursor) may name an
// offset beyond the durable mark — `read()`'s short-page proof stops there. Each test drives
// ephemerals to the head, releases the pins, evicts, re-mints durables at those offsets, and proves they
// are reduced / delivered exactly as at-least-once promises. (Found by the r1 correctness review;
// the same hunt found that an undisposed facet RPC RESULT pinned the parent after a release — the
// read-verb cases below are also the pin for that fix: they evict at once after ONE release.)
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import type { StreamPage, WorkerSource } from "iterate/api";
import type { ItxExpression } from "iterate/expression";
import { COUNTER_SOURCE, flakyCounter } from "./sources.ts";
import { releasePins, rowOf, snapshot, stub, until } from "./support.ts";

const DIGEST_MODULES = {
  "package.json": '{"main":"worker.js"}',
  "worker.js": /* js */ `
import { WorkerEntrypoint } from "cloudflare:workers";
export default class Digest extends WorkerEntrypoint {
  async processEventBatch(events, range) {
    using itx = this.getItx();
    const seen = JSON.parse((await itx.kv.get("digested")) ?? "[]");
    for (const e of events) seen.push(e.type + "@" + e.offset);
    await itx.kv.put("digested", JSON.stringify(seen));
  }
}
`,
};

test("a stream-kept durable cursor never persists an ephemeral offset across eviction", async () => {
  const ctx = "prj_rev_cursorskip";
  const s = stub(ctx);
  await s.append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "dig",
      target: ["itx", "workers", ["get", { source: DIGEST_MODULES }], "processEventBatch"],
      delivery: "durable",
      consumes: ["mark"],
    },
  });
  const mark = offsetOf(await s.append({ type: "mark" }));
  // The delivery is a worker call and its ack comes after it returns: wait for the cursor to reach
  // the mark, which is the call settled — never a guess at how long a call takes.
  const row0 = await cursorReaches(s, "dig", mark);
  expect(await digested(s)).toHaveLength(1);
  const p0 = await page(ctx);
  const highestDurableOffset = p0.events.at(-1)!.offset;
  expect(row0).toMatchObject({ cursor: { confirmedOffset: highestDurableOffset } }); // acked on durable ground ✓

  await s.append({ type: "blip", ephemeral: true }, { type: "blip", ephemeral: true });
  await releasePins(ctx);
  await evictDurableObject(s);

  // This native diagnostic begins the new incarnation but records no wake. It observes the private
  // context's persisted delivery KV before an external request can create a replacement `itx/woken` record or
  // asynchronous alarm traces. The cursor must still name the old durable mark exactly.
  const beforeWake = await runInDurableObject(s, (instance) =>
    instance.subscriptionDeliveryStatus(),
  );
  const configuredAtOffset = row0.configuredAtOffset;
  expect(beforeWake.snapshots[`dig@${configuredAtOffset}`]).toMatchObject({
    confirmedOffset: highestDurableOffset,
  });

  // The first ordinary append now creates woken@mark+1 and this mark@mark+2 in one synchronous
  // turn. It therefore reuses the two dead ephemeral offsets without relying on alarm timing.
  const secondMark = offsetOf(await s.append({ type: "mark" }));
  expect(secondMark).toBe(highestDurableOffset + 2);
  await cursorReaches(s, "dig", secondMark);
  const p1 = await page(ctx);
  expect(p1.events.at(-1)).toMatchObject({ offset: secondMark });
  // At-least-once: the mark minted where a dead ephemeral sat reaches the worker.
  expect(await digested(s)).toContain(`mark@${secondMark}`);
});

test("a processor subscription resolves a provided alias to a facet batch method before its platform call", async () => {
  const ctx = "prj_rev_processor_alias";
  const s = stub(ctx);
  const counter = hostedFacet(
    { "package.json": '{"main":"worker.js"}', "worker.js": COUNTER_SOURCE },
    "CounterDurableObject",
    "alias-counter",
  );
  await s.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.alias", target: [...counter, "processEventBatch"] },
  });
  await s.append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "alias",
      target: "itx.alias",
      delivery: "processor",
      consumes: ["tick", "poison"],
    },
  });

  const tick = offsetOf(await s.append({ type: "tick" }));
  await processedThrough(s, "alias-counter", tick);
  expect((await snapshot<{ n: number }>(ctx, "alias-counter")).state.n).toBeGreaterThan(0);

  const poison = hostedFacet(
    flakyCounter("alias processor refused", { code: "PERMANENT_FAILURE" }).source,
    "FlakyDurableObject",
    "alias-poison",
  );
  await s.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.alias", target: [...poison, "processEventBatch"] },
  });
  await s.append({ type: "poison" });
  const halted = await until(
    "the alias processor row halts",
    async () => (await rowOf(ctx, "alias"))?.halted,
  );
  expect(halted).toMatchObject({ attempts: 1, error: "alias processor refused" });
});

test("enable with a consumes filter: itx.facets.get(name) answers before the first consumed event (the facet is materialized at configure time)", async () => {
  const ctx = "prj_rev_nofacet";
  const s = stub(ctx);
  await s.append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "c2",
      target: [
        ...hostedFacet(
          { "package.json": '{"main":"worker.js"}', "worker.js": COUNTER_SOURCE },
          "CounterDurableObject",
          "c2",
        ),
        "processEventBatch",
      ],
      delivery: "processor",
      consumes: ["tick"],
    },
  });
  // No wait: the name alone answers — a hosting row recovers its facet's spec from the log that
  // configured it, whether or not onCommit's resolve of the target has run yet.
  const snap = await snapshot<{ n: number }>(ctx, "c2");
  expect(snap.state.n).toBeGreaterThanOrEqual(0);
});

test("processor: a read-driven catch-up (snapshot after the release) with ephemerals at head checkpoints the durable mark; after the release + evict the durable re-minted at an ephemeral's offset is reduced exactly once", async () => {
  const ctx = "prj_rev_procskip_b";
  const s = stub(ctx);
  const configured = offsetOf(
    await s.append({
      type: "events.iterate.com/itx/subscription-configured",
      payload: {
        name: "counter",
        target: [
          ...hostedFacet(
            { "package.json": '{"main":"worker.js"}', "worker.js": COUNTER_SOURCE },
            "CounterDurableObject",
            "counter",
          ),
          "processEventBatch",
        ],
        delivery: "processor",
        consumes: ["tick", "events.iterate.com/itx/subscription-configured"],
      },
    }),
  );
  await processedThrough(s, "counter", configured); // the configured event is consumed → push → facet materialized, cursor = its offset (durable ground)
  const tick = offsetOf(await s.append({ type: "tick" })); // pushed → reduced, cursor = tick offset (durable)
  await processedThrough(s, "counter", tick);
  await s.append({ type: "note" }); // NOT consumed by the subscription → not pushed → the facet now lags by one durable
  await s.append({ type: "blip", ephemeral: true }, { type: "blip", ephemeral: true }); // ephemeral tail of 2
  const p0 = await page(ctx);
  const highestDurableOffset = p0.events.at(-1)!.offset;
  expect(p0.events.at(-1)).toMatchObject({ type: "note" });
  await releasePins(ctx); // abort the idle facet (checkpoint = tick offset, durable)
  // the repo's own snapCounter shape: re-materialize by name → #pushedThroughOffset undefined → catchUpFromLog() → read(cursor) → [note], scannedThroughOffset = head
  const mid = await snapshot<{ n: number }>(ctx, "counter");
  // n = created + woken + configured + tick + note: gap repair reads the unsent
  // birth records, the push reduces tick, and this wake reads note.
  // read() proves the durable log only, so the checkpoint the wake persisted is the mark, not the head.
  expect(mid).toMatchObject({ state: { n: 5 }, offset: highestDurableOffset });
  expect(p0).toMatchObject({ scannedThroughOffset: highestDurableOffset });
  await releasePins(ctx);
  await evictDurableObject(s);
  const secondTick = offsetOf(await s.append({ type: "tick" })); // woken@mark+1 (the constructor's), tick@mark+2 — durable, at the dead ephemerals' offsets
  await processedThrough(s, "counter", secondTick);
  const p1 = await page(ctx);
  expect(p1.events.map((e) => e.offset).slice(-2)).toEqual([
    highestDurableOffset + 1,
    highestDurableOffset + 2,
  ]);
  const after = await snapshot<{ n: number }>(ctx, "counter");
  // the pushed tick@mark+2 is reduced exactly once, and the new incarnation's woken@mark+1 — a
  // durable event like any other, pushed to the "*" row — once → n grows by exactly 2.
  expect(after).toMatchObject({ state: { n: mid.state.n + 2 } });
});

async function page(ctx: string) {
  return (await stub(ctx).invoke(["itx", ["readEvents", 0, 500]])) as StreamPage;
}

/** The stream-kept cursor of subscription `name` once it stands at or past `offset` — the ack of
 *  the call that delivered it, which lands only after the call returned. */
async function cursorReaches(
  s: ReturnType<typeof stub>,
  name: string,
  offset: number,
): Promise<{ configuredAtOffset: number; cursor?: { confirmedOffset: number } }> {
  return until(`subscription ${name} acked through ${offset}`, async () => {
    const row = (await s.invoke(`itx.subscriptions.get('${name}')`)) as {
      configuredAtOffset: number;
      cursor?: { confirmedOffset: number };
    };
    return (row.cursor?.confirmedOffset ?? -1) >= offset && row;
  });
}

/** What the digest worker has recorded, `type@offset` per delivered event. */
async function digested(s: ReturnType<typeof stub>): Promise<string[]> {
  return JSON.parse(((await s.invoke(["itx", "kv", ["get", "digested"]])) as string) || "[]");
}

/** The offset the one event `append` was handed committed at (the stub's RPC typing drops the
 *  return's shape). */
function offsetOf(appended: unknown): number {
  return (appended as { offset: number }[])[0]!.offset;
}

/** The processor facet's own barrier: resolves once it has reduced through `offset`. */
async function processedThrough(s: ReturnType<typeof stub>, facet: string, offset: number) {
  await s.invoke(["itx", "facets", ["get", facet], ["waitUntilProcessed", { offset }]]);
}

/** The hosting call as an expression: `itx.facets.get(name, { source, className })` — the source is
 *  the worker's modules, literally. */
function hostedFacet(source: WorkerSource, cls: string, name: string): ItxExpression {
  return ["itx", "facets", ["get", name, { source, className: cls }]];
}

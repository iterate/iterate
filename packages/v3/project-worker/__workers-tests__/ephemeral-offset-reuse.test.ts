// ephemeral-offset-reuse.test.ts — the zero-write contract under eviction, on the real DO: an
// ephemeral's offset is unique WITHIN an incarnation and a later incarnation may hand it to a
// durable, so NOTHING a reader persists (a facet's checkpoint, a stream-kept cursor) may name an
// offset beyond the durable mark — `read()`'s short-page proof stops there. Each test drives
// ephemerals to the head, quiesces, evicts, re-mints durables at those offsets, and proves they
// are reduced / delivered exactly as at-least-once promises. (Found by the r1 correctness review;
// the same hunt found that an undisposed facet RPC RESULT pinned the parent after a quiesce — the
// read-verb cases below are also the pin for that fix: they evict at once after ONE quiesce.)
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import type { ItxExpression } from "../src/context/expression.ts";
import { quiesce, stub } from "./support.ts";

const COUNTER_SRC = /* js */ `
import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "./processor.js";
const contract = defineProcessorContract({
  slug: "counter", version: "1.0.0", description: "counts durable events",
  stateSchema: z.object({ n: z.number().default(0) }), events: {}, consumes: ["*"], emits: [],
});
class CounterProcessor extends StreamProcessor {
  contract = contract;
  reduce({ state }) { return { n: state.n + 1 }; }
}
export class CounterDurableObject extends StreamProcessorDurableObject {
  processor = new CounterProcessor();
}
`;
const DIGEST_SRC = /* js */ `
import { WorkerEntrypoint } from "cloudflare:workers";
export default class Digest extends WorkerEntrypoint {
  async processEventBatch(events, range) {
    const itx = await this.env.ITX.get();
    const seen = JSON.parse((await itx.kv.get("digested")) ?? "[]");
    for (const e of events) seen.push(e.type + "@" + e.offset);
    await itx.kv.put("digested", JSON.stringify(seen));
  }
}
`;
type Page = { events: { type: string; offset: number }[]; scannedThroughOffset: number };
const page = async (ctx: string): Promise<Page> =>
  (await stub(ctx).invoke(["itx", ["read", 0, 500]])) as Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The DO's scheduled alarm instant, or null. The quiet clock arms ONLY while a facet is live or an
 *  rpc stub is borrowed, so a pin that fires the alarm must first create one of the two and read
 *  this back — otherwise runDurableObjectAlarm fires into an empty schedule and proves nothing. */
const alarmAt = (ctx: string): Promise<number | null> =>
  runInDurableObject(stub(ctx), (_inst, state) => state.storage.getAlarm());

const loadChain = (src: string, cls: string, name: string): ItxExpression => [
  "itx",
  ["load", `itx.kv.get('${src}')`],
  ["getDurableObjectClass", cls],
  ["get", name],
];

test("processor: a fresh facet's first snapshot (wake) with ephemerals at head checkpoints the durable mark; after quiesce + evict the tick re-minted at a dead ephemeral's offset is reduced exactly once", async () => {
  const ctx = "prj_rev_procskip";
  const s = stub(ctx);
  await s.invoke(["itx", "kv", ["put", "procsrc", COUNTER_SRC]]);
  // enable with a consumes FILTER: the configured event is not pushed; the facet is materialized and woken at configure time
  await s.configureSubscription({
    name: "counter",
    target: [...loadChain("procsrc", "CounterDurableObject", "counter"), "processEventBatch"],
    consumes: ["tick"],
  });
  // core's live-state delta (the configured row changed core) already sits at head (ephemeral); add one more so the tail is ≥ 2
  await s.append({ type: "blip", ephemeral: true });
  const p0 = await page(ctx);
  const highestDurableOffset = p0.events.at(-1)!.offset; // last durable row
  expect(p0.scannedThroughOffset).toBe(highestDurableOffset); // the ephemeral tail (≥ 2 offsets) is NOT proven by a read

  // READ-DRIVEN catch-up through the load chain: snapshot → catchUpFromLog() → read → durables ≤ mark
  const before = (await s.invoke([
    ...loadChain("procsrc", "CounterDurableObject", "counter"),
    ["snapshot"],
  ])) as { offset: number; state: { n: number } };
  expect(before.state.n).toBe(p0.events.length); // reduced every durable
  expect(before.offset).toBe(highestDurableOffset); // the persisted checkpoint is the durable mark, not the ephemeral head

  await sleep(400); // let the facet's fire-and-forget live-state delta land before the clock jumps (else #lastActivityMs reads fresh and the quiesce skips)
  await quiesce(ctx); // abort the facet (un-pin) — its checkpoint (the durable mark) is durable in its own storage
  await evictDurableObject(s); // fresh incarnation: offsets resume from the durable mark

  // The fresh incarnation's constructor wrote woken@mark+1 (its commit's core live-state delta took
  // mark+2, ephemeral); tick lands at mark+3 — all at offsets the dead ephemerals held.
  await s.append({ type: "tick" });
  await sleep(400); // let the push land and the facet re-materialize
  const p1 = await page(ctx);
  expect(p1.events.map((e) => e.offset).slice(-2)).toEqual([
    highestDurableOffset + 1,
    highestDurableOffset + 3,
  ]); // the log is exact
  const after = (await s.invoke(["itx", "facets", ["get", "counter"], ["snapshot"]])) as {
    offset: number;
    state: { n: number };
  };
  // The pushed tick@mark+3 is reduced exactly once — and so is the new incarnation's woken@mark+1,
  // ONCE, by a different path: the subscription's consumes filter never SENDS it (its own commit
  // is filtered to nothing, and empty sends are skipped), so the tick's push range starts one past
  // the facet's cursor and the engine's durable gap repair reads woken from the log and reduces it
  // (the contract consumes "*") — the two-filter rule: the subscription decides what is PUSHED, the
  // contract decides what is FOLDED. (The first incarnation's wake read the log from 0 — created,
  // woken, configured — hence `before`.)
  expect(after.state.n).toBe(before.state.n + 2);
});

test("stream-kept cursor: an alarm pump with ephemerals at head leaves the cursor on the durable mark; after quiesce + evict the durables re-minted at those offsets are delivered", async () => {
  const ctx = "prj_rev_cursorskip";
  const s = stub(ctx);
  await s.invoke(["itx", "kv", ["put", "digsrc", DIGEST_SRC]]);
  await s.configureSubscription({
    name: "dig",
    target: ["itx", ["load", "itx.kv.get('digsrc')"], ["getEntrypoint"], "processEventBatch"],
    consumes: ["mark"],
  });
  await s.append({ type: "mark" });
  await sleep(400);
  expect(
    JSON.parse(((await s.invoke(["itx", "kv", ["get", "digested"]])) as string) ?? "[]"),
  ).toHaveLength(1);
  const row0 = (await s.invoke("itx.subscriptions.get('dig')")) as {
    cursor?: { confirmedOffset: number };
  };
  const p0 = await page(ctx);
  const highestDurableOffset = p0.events.at(-1)!.offset;
  expect(row0.cursor!.confirmedOffset).toBe(highestDurableOffset); // acked on durable ground ✓

  await s.append({ type: "blip", ephemeral: true }, { type: "blip", ephemeral: true }); // head = mark+2, mark unchanged
  // ARM THE ALARM FIRST. `dig` is a CURSOR subscription onto a stateless entrypoint: it schedules an
  // alarm only for a RETRY, and nothing here failed — so this context has no live facet, no borrowed
  // stub and therefore no alarm at all. Materialize an unrelated facet to arm the quiet clock (it
  // consumes nothing of `dig`'s and writes no durable row — its live-state delta is ephemeral, so the
  // durable mark this pin is about does not move) and read the schedule back before firing.
  await s.invoke(["itx", "kv", ["put", "procsrc", COUNTER_SRC]]);
  await s.invoke([...loadChain("procsrc", "CounterDurableObject", "armer"), ["snapshot"]]);
  expect(await alarmAt(ctx)).not.toBeNull();
  // The alarm really runs: deliverEveryCursorSubscription → read(mark) proves only through the mark
  // → `dig` is caught up, nothing written.
  expect(await runDurableObjectAlarm(s)).toBe(true);
  const row1 = (await s.invoke("itx.subscriptions.get('dig')")) as {
    cursor?: { confirmedOffset: number };
  };
  expect(row1.cursor!.confirmedOffset).toBe(highestDurableOffset); // the cursor never leaves durable ground

  await sleep(400); // let the armer facet's fire-and-forget live-state delta land before the clock jumps
  await quiesce(ctx);
  await evictDurableObject(s);
  const rowKv = (await s.invoke("itx.subscriptions.get('dig')")) as {
    cursor?: { confirmedOffset: number };
  };
  expect(rowKv.cursor!.confirmedOffset).toBe(highestDurableOffset); // what kv held through the eviction

  await s.append({ type: "mark" }); // woken@mark+1 (the constructor's; its core delta took mark+2), mark@mark+3 — durable
  await sleep(600);
  const p1 = await page(ctx);
  expect(p1.events.at(-1)!.offset).toBe(highestDurableOffset + 3);
  const digested = JSON.parse(
    ((await s.invoke(["itx", "kv", ["get", "digested"]])) as string) ?? "[]",
  ) as string[];
  // at-least-once: the second mark, minted where a dead ephemeral sat, reaches the worker.
  expect(digested).toContain(`mark@${highestDurableOffset + 3}`);
});

test("enable with a consumes filter: itx.facets.get(name) answers before the first consumed event (the facet is materialized at configure time)", async () => {
  const ctx = "prj_rev_nofacet";
  const s = stub(ctx);
  await s.invoke(["itx", "kv", ["put", "procsrc", COUNTER_SRC]]);
  await s.configureSubscription({
    name: "c2",
    target: [...loadChain("procsrc", "CounterDurableObject", "c2"), "processEventBatch"],
    consumes: ["tick"],
  });
  await sleep(300); // onCommit's void #resolve(sub.target) has long finished
  const snap = (await s.invoke(["itx", "facets", ["get", "c2"], ["snapshot"]])) as {
    state: { n: number };
  };
  expect(snap.state.n).toBeGreaterThanOrEqual(0);
});

test("processor: a read-driven catch-up (snapshot after quiesce) with ephemerals at head checkpoints the durable mark; after quiesce + evict the durable re-minted at an ephemeral's offset is reduced exactly once", async () => {
  const ctx = "prj_rev_procskip_b";
  const s = stub(ctx);
  await s.invoke(["itx", "kv", ["put", "procsrc", COUNTER_SRC]]);
  await s.configureSubscription({
    name: "counter",
    target: [...loadChain("procsrc", "CounterDurableObject", "counter"), "processEventBatch"],
    consumes: ["tick", "events.iterate.com/stream/subscription-configured"],
  });
  await sleep(300); // the configured event is consumed → push → facet materialized, cursor = its offset (durable ground)
  await s.append({ type: "tick" }); // pushed → reduced, cursor = tick offset (durable)
  await sleep(300);
  await s.append({ type: "note" }); // NOT consumed by the subscription → not pushed → the facet now lags by one durable
  await s.append({ type: "blip", ephemeral: true }, { type: "blip", ephemeral: true }); // ephemeral tail of 2
  const p0 = await page(ctx);
  const highestDurableOffset = p0.events.at(-1)!.offset;
  expect(p0.events.at(-1)!.type).toBe("note");
  await sleep(300);
  await quiesce(ctx); // abort the idle facet (checkpoint = tick offset, durable)
  // the repo's own snapCounter shape: re-materialize by name → #pushedThroughOffset undefined → appendCreatedAndWokenEvents() → read(cursor) → [note], scannedThroughOffset = head
  const mid = (await s.invoke(["itx", "facets", ["get", "counter"], ["snapshot"]])) as {
    offset: number;
    state: { n: number };
  };
  // n = created + woken + configured + tick + note: the configured push's gap repair read the log
  // from 0 (so the filter's unsent created@1 + woken@2 were reduced too), the push reduced tick, this
  // wake read note.
  expect(mid.state.n).toBe(5);
  expect(p0.scannedThroughOffset).toBe(highestDurableOffset); // read() proves the durable log only
  expect(mid.offset).toBe(highestDurableOffset); // so the checkpoint the wake persisted is the mark, not the head
  await sleep(400);
  await quiesce(ctx);
  await evictDurableObject(s);
  await s.append({ type: "tick" }); // woken@mark+1 (the constructor's; its core delta took mark+2), tick@mark+3 — durable, at the dead ephemerals' offsets
  await sleep(500);
  const p1 = await page(ctx);
  expect(p1.events.map((e) => e.offset).slice(-2)).toEqual([
    highestDurableOffset + 1,
    highestDurableOffset + 3,
  ]);
  const after = (await s.invoke(["itx", "facets", ["get", "counter"], ["snapshot"]])) as {
    offset: number;
    state: { n: number };
  };
  // the pushed tick@mark+3 is reduced exactly once, and the new incarnation's woken@mark+1 exactly
  // once via the engine's durable gap repair (the push range starts past the cursor; the contract
  // consumes "*") → n grows by exactly 2.
  expect(after.state.n).toBe(mid.state.n + 2);
});

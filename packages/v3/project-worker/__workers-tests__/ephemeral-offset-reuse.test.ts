// ephemeral-offset-reuse.test.ts — the zero-write contract under eviction, on the real DO: an
// ephemeral's offset is unique WITHIN an incarnation and a later incarnation may hand it to a
// durable, so NOTHING a reader persists (a facet's checkpoint, a stream-kept cursor) may name an
// offset beyond the durable mark — `read()`'s short-page proof stops there. Each test drives
// ephemerals to the head, quiesces, evicts, re-mints durables at those offsets, and proves they
// are folded / delivered exactly as at-least-once promises. (Found by the r1 correctness review;
// the same hunt found that an undisposed facet RPC RESULT pinned the parent after a quiesce — the
// read-verb cases below are also the pin for that fix: they evict at once after ONE quiesce.)
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { expect, test } from "vitest";
import type { Expression } from "../src/context/expression.ts";
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

const loadChain = (src: string, cls: string, name: string): Expression => [
  "itx",
  ["load", `itx.kv.get('${src}')`],
  ["getDurableObjectClass", cls],
  ["get", name],
];

test("processor: a fresh facet's first snapshot (wake) with ephemerals at head checkpoints the durable mark; after quiesce + evict the tick re-minted at a dead ephemeral's offset is folded exactly once", async () => {
  const ctx = "prj_rev_procskip";
  const s = stub(ctx);
  await s.invoke(["itx", "kv", ["put", "procsrc", COUNTER_SRC]]);
  // enable with a consumes FILTER: the configured event is not pushed; the facet is materialized and woken at configure time
  await s.configureSubscription({
    name: "counter",
    target: [...loadChain("procsrc", "CounterDurableObject", "counter"), "processEventBatch"],
    consumes: ["tick"],
  });
  // the subscriptions inline reduce's live-state delta already sits at head (ephemeral); add one more so the tail is ≥ 2
  await s.append({ type: "blip", ephemeral: true });
  const p0 = await page(ctx);
  const durableMark = p0.events.at(-1)!.offset; // last durable row
  expect(p0.scannedThroughOffset).toBe(durableMark); // the ephemeral tail (≥ 2 offsets) is NOT proven by a read

  // READ-DRIVEN catch-up through the load chain: snapshot → wake() → read → durables ≤ mark
  const before = (await s.invoke([
    ...loadChain("procsrc", "CounterDurableObject", "counter"),
    ["snapshot"],
  ])) as { offset: number; state: { n: number } };
  expect(before.state.n).toBe(p0.events.length); // folded every durable
  expect(before.offset).toBe(durableMark); // the persisted checkpoint is the durable mark, not the ephemeral head

  await sleep(400); // let the facet's fire-and-forget live-state delta land before the clock jumps (else #lastActivityMs reads fresh and the quiesce skips)
  await quiesce(ctx); // abort the facet (un-pin) — its checkpoint (the durable mark) is durable in its own storage
  await evictDurableObject(s); // fresh incarnation: offsets resume from the durable mark

  await s.append({ type: "tick" }); // woken@mark+1, tick@mark+2 — both DURABLE, both at offsets the dead ephemerals held
  await sleep(400); // let the push land and the facet re-materialize
  const p1 = await page(ctx);
  expect(p1.events.map((e) => e.offset).slice(-2)).toEqual([durableMark + 1, durableMark + 2]); // the log is exact
  const after = (await s.invoke(["itx", "facets", ["get", "counter"], ["snapshot"]])) as {
    offset: number;
    state: { n: number };
  };
  // The pushed tick@mark+2 is folded exactly once. (Not "n = durable rows": the subscription's
  // consumes filter never SENDS the new incarnation's woken record, and the engine folds what it is
  // sent — the two-filter rule. The first incarnation's wake read the log from 0, hence `before`.)
  expect(after.state.n).toBe(before.state.n + 1);
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
  const durableMark = p0.events.at(-1)!.offset;
  expect(row0.cursor!.confirmedOffset).toBe(durableMark); // acked on durable ground ✓

  await s.append({ type: "blip", ephemeral: true }, { type: "blip", ephemeral: true }); // head = mark+2, mark unchanged
  await runDurableObjectAlarm(s); // pumpAll → read(mark) proves only through the mark → caught up, no write
  const row1 = (await s.invoke("itx.subscriptions.get('dig')")) as {
    cursor?: { confirmedOffset: number };
  };
  expect(row1.cursor!.confirmedOffset).toBe(durableMark); // the cursor never leaves durable ground

  await quiesce(ctx);
  await evictDurableObject(s);
  const rowKv = (await s.invoke("itx.subscriptions.get('dig')")) as {
    cursor?: { confirmedOffset: number };
  };
  expect(rowKv.cursor!.confirmedOffset).toBe(durableMark); // what kv held through the eviction

  await s.append({ type: "mark" }); // woken@mark+1, mark@mark+2 — durable
  await sleep(600);
  const p1 = await page(ctx);
  expect(p1.events.at(-1)!.offset).toBe(durableMark + 2);
  const digested = JSON.parse(
    ((await s.invoke(["itx", "kv", ["get", "digested"]])) as string) ?? "[]",
  ) as string[];
  // at-least-once: the second mark, minted where a dead ephemeral sat, reaches the worker.
  expect(digested).toContain(`mark@${durableMark + 2}`);
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

test("processor: a read-driven catch-up (snapshot after quiesce) with ephemerals at head checkpoints the durable mark; after quiesce + evict the durable re-minted at an ephemeral's offset is folded exactly once", async () => {
  const ctx = "prj_rev_procskip_b";
  const s = stub(ctx);
  await s.invoke(["itx", "kv", ["put", "procsrc", COUNTER_SRC]]);
  await s.configureSubscription({
    name: "counter",
    target: [...loadChain("procsrc", "CounterDurableObject", "counter"), "processEventBatch"],
    consumes: ["tick", "events.iterate.com/stream/subscription-configured"],
  });
  await sleep(300); // the configured event is consumed → push → facet materialized, cursor = its offset (durable ground)
  await s.append({ type: "tick" }); // pushed → folded, cursor = tick offset (durable)
  await sleep(300);
  await s.append({ type: "note" }); // NOT consumed by the subscription → not pushed → the facet now lags by one durable
  await s.append({ type: "blip", ephemeral: true }, { type: "blip", ephemeral: true }); // ephemeral tail of 2
  const p0 = await page(ctx);
  const durableMark = p0.events.at(-1)!.offset;
  expect(p0.events.at(-1)!.type).toBe("note");
  await sleep(300);
  await quiesce(ctx); // abort the idle facet (checkpoint = tick offset, durable)
  // the repo's own snapCounter shape: re-materialize by name → #pushedThroughOffset undefined → wake() → read(cursor) → [note], scannedThroughOffset = head
  const mid = (await s.invoke(["itx", "facets", ["get", "counter"], ["snapshot"]])) as {
    offset: number;
    state: { n: number };
  };
  // n = woken + configured + tick + note: the wake at configure time read the log from 0 (so the
  // filter's unsent woken@1 was folded too), the push folded tick, this wake read note.
  expect(mid.state.n).toBe(4);
  expect(p0.scannedThroughOffset).toBe(durableMark); // read() proves the durable log only
  expect(mid.offset).toBe(durableMark); // so the checkpoint the wake persisted is the mark, not the head
  await sleep(400);
  await quiesce(ctx);
  await evictDurableObject(s);
  await s.append({ type: "tick" }); // woken@mark+1, tick@mark+2 — durable, at the dead ephemerals' offsets
  await sleep(500);
  const p1 = await page(ctx);
  expect(p1.events.map((e) => e.offset).slice(-2)).toEqual([durableMark + 1, durableMark + 2]);
  const after = (await s.invoke(["itx", "facets", ["get", "counter"], ["snapshot"]])) as {
    offset: number;
    state: { n: number };
  };
  // the pushed tick@mark+2 is folded exactly once → n grows by exactly 1.
  expect(after.state.n).toBe(mid.state.n + 1);
});

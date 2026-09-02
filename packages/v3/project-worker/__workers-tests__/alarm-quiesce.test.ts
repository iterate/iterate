// __workers-tests__/alarm-quiesce.test.ts — the context DO's alarm, inside workerd (the workers
// lane — the ONLY lane that can fire the DO's alarm (runDurableObjectAlarm) and force a graceful
// teardown (evictDurableObject) deterministically).
//
// Target surface: IterateContextDurableObject.alarm()/#recordActivityForQuietClock/#liveFacets/#facetWorkInFlight
// (src/iterate-context-durable-object.ts), the delivery loop's cursor lane + `pumpAll`
// (src/stream/subscription-delivery.ts), and the rpc-stub directory (src/context/rpc-stub-directory.ts).
//
// THE ALARM DOES TWO THINGS, IN ORDER — this file pins both:
//   1. `pumpAll`: every CURSOR subscription (a target that cannot own its progress — a stateless
//      Worker-Loader entrypoint) whose retry is due is pumped from its kv cursor; the awaited call
//      is the ack, the ladder resets. AWAITED before step 2, so the quiesce never aborts a
//      delivery in flight and a later retry's re-arm lands before the actor hibernates.
//   2. the idle QUIESCE: 60s without activity (and nothing in flight) aborts every live facet and
//      RETURNS every borrowed stub, so the actor can hibernate. A MEASURED PROPERTY, load-bearing
//      below: a materialized facet or a borrowed stub PINS the DO non-hibernatable (workerd#6800)
//      — evictDurableObject on such a DO times out after 30s ("still has active references"). You
//      must quiesce BEFORE you can evict — the exact production sequence (support.ts's `quiesce`).
//      It is also what ARMS the alarm at all: a context with no live facet and no borrowed stub
//      schedules nothing, so every pin below that fires the alarm creates one of the two FIRST.
//
// PROCESSORS here are what they are everywhere: userspace two-class sources — a pure
// `StreamProcessor` (`CounterProcessor`) and its one-line `StreamProcessorDurableObject` host
// (`CounterDurableObject`, the class the load chain names) — loaded through the Worker Loader and
// hosted as facets (there are no built-in processors). The workers lane materializes them fine (the
// loader accepts allow_irrevocable_stub_storage), so every facet-lifecycle pin rides the inline
// `CounterProcessor` source below, enabled the way the edge's `enableProcessor` spells it — ONE
// `subscription-configured` whose target is the facet's `processEventBatch` through the load chain,
// appended at the DO's one write door (`append`; the DO has no configuration verbs). Live stubs
// (over hibernatable stub pager sockets) work fully here too — see hibernation-at-scale.test.ts.

import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import { subscriptionConfiguredEvent } from "../src/stream/subscriptions.ts";
import { Echo, openSession, quiesce, stub } from "./support.ts";

/** A tiny userspace processor: counts every durable event. The tally fixture's shape
 *  (e2e/support/sources.ts), reduced to one number — the pure `CounterProcessor` plus its host
 *  `CounterDurableObject`, which is what the load chain names. */
const COUNTER_SRC = /* js */ `
import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "./processor.js";
const contract = defineProcessorContract({
  slug: "counter",
  version: "1.0.0",
  description: "counts durable events",
  stateSchema: z.object({ n: z.number().default(0) }),
  events: {},
  consumes: ["*"],
  emits: [],
});
class CounterProcessor extends StreamProcessor {
  contract = contract;
  reduce({ state }) { return { n: state.n + 1 }; }
}
export class CounterDurableObject extends StreamProcessorDurableObject {
  processor = new CounterProcessor();
}
`;

type FacetSnap = { offset: number; state: { n: number } };
const snapCounter = (ctx: string, name = "counter") =>
  stub(ctx).invoke(["itx", "facets", ["get", name], ["snapshot"]]) as Promise<FacetSnap>;
// The number of DURABLE events (read is durable-only). CounterProcessor consumes "*", so its `n` equals this
// — the exact-once invariant. (Not `n === offset`: every processor's live-state delta is an
// ephemeral that consumes an offset, so a durable event's offset exceeds the count of durable
// events before it.)
const durableCount = async (ctx: string): Promise<number> =>
  ((await stub(ctx).invoke(["itx", ["read", 0, 500]])) as { events: unknown[] }).events.length;

/** The edge's `enableProcessor(name, { source, className })`, spelled at the DO door: ONE
 *  subscription-configured event — built by `subscriptionConfiguredEvent`, appended through `append`
 *  — whose target is the facet's `processEventBatch` through the load chain (the facet name = the
 *  subscription name = the `.get(name)` name). */
async function enableCounter(ctx: string, name = "counter"): Promise<void> {
  const s = stub(ctx);
  await s.append(
    subscriptionConfiguredEvent({
      name,
      target: [
        "itx",
        "facets",
        ["get", name, { source: { "cap.js": COUNTER_SRC }, className: "CounterDurableObject" }],
        "processEventBatch",
      ],
    }),
  );
}
/** The edge's `disableProcessor(name)`: ONE event — `target: null`; the DO deletes the facet the
 *  row hosted, storage included, before the append returns. */
async function disableCounter(ctx: string, name = "counter"): Promise<void> {
  await stub(ctx).append(subscriptionConfiguredEvent({ name, target: null }));
}

// The DO-only transport facts ({stubs, borrowed, rpcStubPagesInFlight, dormant}) — the quiesce probes are
// in-memory socket truths, so they speak rpcStubTransportState(), never the table.
const stateOf = (ctx: string): Promise<Record<string, any>> =>
  runInDurableObject(stub(ctx), async (inst) =>
    (inst as unknown as { rpcStubTransportState(): Record<string, any> }).rpcStubTransportState(),
  );
/** The DO's scheduled alarm instant, or null — only this lane can read it, and it is the ONE proof
 *  that a quiesce pin below is exercising the alarm instead of firing into an empty schedule. */
const alarmAt = (ctx: string): Promise<number | null> =>
  runInDurableObject(stub(ctx), (_inst, state) => state.storage.getAlarm());
/** Poll the census until `stubs` reaches `n` (bounded). A transport leaves the census when its
 *  pager socket's CLOSE lands at the DO — a physical fact that arrives a beat after the edge
 *  disposes its relay, never inside the RPC that triggered it. */
async function untilStubs(ctx: string, n: number, timeoutMs = 5_000): Promise<Record<string, any>> {
  const t0 = Date.now();
  for (;;) {
    const s = await stateOf(ctx);
    if (s.rpcStubPagers === n) return s;
    if (Date.now() - t0 > timeoutMs)
      throw new Error(`untilStubs(${ctx}, ${n}): still ${s.rpcStubPagers} after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ─────────── THE ALARM'S SECOND JOB: the idle quiesce, and what survives the eviction it enables ───────────

test("QUIESCE PRESERVES CURSOR+STATE: abort an idle facet, re-materialize from the startup memo, snapshot is unchanged", async () => {
  // A facet aborted by the idle quiesce and re-materialized by the next call (`itx.facets.get(name)`
  // reads the `facet:<name>` startup memo — no configure(), no side channel; its identity is
  // ctx.props) keeps its durable checkpoint + reduced state. Were re-materialization broken, the
  // post-quiesce snapshot would throw NO_FACET or reset to n=0.
  const ctx = "prj_q_cursor";
  const s = stub(ctx);
  await enableCounter(ctx);
  await s.append({ type: "a/1" }, { type: "a/2" }, { type: "a/3" });
  await new Promise((r) => setTimeout(r, 150));
  const before = await snapCounter(ctx);
  expect(before.state.n).toBe(await durableCount(ctx)); // every durable event counted, no double/no loss

  // Idle 61s → the quiesce aborts the facet (its checkpoint is durable in its OWN storage).
  await quiesce(ctx);

  // The next snapshot re-materializes the facet: it must resume from its own checkpoint.
  const after = await snapCounter(ctx);
  // Cursor NOT reset/regressed across the abort. It may ADVANCE past `before.offset`: the cold
  // re-catch-up reads to scannedThroughOffset (the raw head), which grew as CounterProcessor's own trailing
  // live-state ephemerals landed after the last push — a head-tracking advance, not a replay. The
  // exact-once invariant is the reduced STATE (below), not the offset number.
  expect(after.offset).toBeGreaterThanOrEqual(before.offset);
  expect(after.state.n).toBe(before.state.n); // reduced state preserved
  expect(after.state.n).toBe(await durableCount(ctx)); // still exact (idempotent re-drive, no replay effects)
});

test("QUIESCE THEN EVICT THEN WAKE: the facet re-drives from its durable checkpoint exactly once (no double, no loss)", async () => {
  // True mid-drive eviction is UNFORCEABLE (a driving facet pins the DO; evict times out — see the
  // header). The forceable, production-shaped path is quiesce (abort) → evict (fresh parent
  // incarnation) → wake. PINS: on wake the facet gap-repairs from its own durable checkpoint — the
  // reduced count equals the number of durable events, never more (no double durable effect) and
  // never fewer (no lost catch-up).
  const ctx = "prj_q_evict";
  const s = stub(ctx);
  await enableCounter(ctx);
  // Commit a run of durable events and let the facet drive them fully (so no drive is in flight —
  // an in-flight drive keeps facetWorkInFlight > 0, the quiesce is skipped, the facet stays
  // materialized, and evict then times out on the #6800 pin).
  await s.append({ type: "b/1" }, { type: "b/2" }, { type: "b/3" }, { type: "b/4" });
  await new Promise((r) => setTimeout(r, 300));

  // Quiesce (aborts the idle facet → un-pins the DO), then a REAL graceful eviction: storage kept,
  // in-memory torn down, a fresh parent incarnation on the next call (a genuine cold catch-up from
  // the log — the property under test).
  await quiesce(ctx);
  await evictDurableObject(s);

  const after = await snapCounter(ctx); // wakes a fresh incarnation → catch-up from the durable checkpoint
  expect(after.state.n).toBeGreaterThanOrEqual(7); // created + woken (2) + subscription-configured (1) + b/1..b/4 (4), + the new incarnation's woken
  expect(after.state.n).toBe(await durableCount(ctx)); // EXACTLY one reduce per durable event across the eviction
});

test("DISABLE deletes the facet's storage; RE-ENABLE rebuilds from the log (no stale checkpoint, no skipped events)", async () => {
  // `disableProcessor` = unsubscribe + `itx.facets.delete(name)` (ctx.facets.delete exists on every
  // runtime we run — the storage-keeping abort() fallback was dead code). PINS the correct
  // consequence: a re-enable rebuilds the reduce from the durable log — including events appended
  // while the processor was disabled — with no stale checkpoint causing a silent skip.
  const ctx = "prj_disable";
  const s = stub(ctx);
  await enableCounter(ctx);
  await s.append({ type: "c/1" }, { type: "c/2" });
  await new Promise((r) => setTimeout(r, 150));

  await disableCounter(ctx);
  await s.append({ type: "gap/1" }, { type: "gap/2" }); // committed while DISABLED
  await new Promise((r) => setTimeout(r, 100));

  await enableCounter(ctx); // re-enable the same name
  await new Promise((r) => setTimeout(r, 150));
  const after = await snapCounter(ctx);
  expect(after.state.n).toBe(await durableCount(ctx)); // rebuilt from the whole log — no stale-checkpoint skip
});

test("A BORROW RACES THE QUIESCE ALARM: a stub invoke fired concurrently with the alarm still answers", async () => {
  // A quiesce RETURNS borrowed stubs (#borrowed) but never touches a PENDING page (#rpcStubPagesInFlight),
  // and the invoke's own #recordActivityForQuietClock keeps the actor warm. PINS: an invoke that
  // borrows a stub while the 60s alarm fires resolves with the right per-client answer (the stub it
  // is borrowing is not returned out from under it).
  const ctx = "prj_pagein";
  const clientItx = await (await openSession()).authenticate().projects.get(ctx);
  for (let i = 0; i < 4; i++) await clientItx.provide(`itx.p${i}`, new Echo(i));
  const caller = await (await openSession()).authenticate().projects.get(ctx);

  // THERE MUST BE AN ALARM TO RACE. Lending four stubs arms nothing — the quiet clock arms only
  // while a facet is live or a stub is BORROWED — so warm one stub first and read the schedule
  // back. Without this the alarm below fires into an empty schedule and the race is vacuous.
  expect(await caller.invoke("itx.p0.echo('warm')")).toBe("echo-0:warm");
  expect((await stateOf(ctx)).borrowedRpcStubs).toBeGreaterThanOrEqual(1);
  expect(await alarmAt(ctx)).not.toBeNull();

  vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
  let raced: unknown;
  let alarmRan: boolean;
  try {
    vi.setSystemTime(Date.now() + 61_000);
    const alarmP = runDurableObjectAlarm(stub(ctx));
    const invokeP = caller.invoke("itx.p2.echo('race')");
    const [ran, inv] = await Promise.all([alarmP, invokeP]);
    alarmRan = ran;
    raced = inv;
  } finally {
    vi.useRealTimers();
  }
  expect(alarmRan).toBe(true); // the armed alarm really ran alongside the invoke
  expect(raced).toBe("echo-2:race");
});

test("SCALE DROP + QUIESCE + EVICT + WAKE: a DISPOSED live provide stays gone; the fan-out reaches EXACTLY the survivors", async () => {
  // Extends hibernation-at-scale's "eviction preserves the fleet" with a provider disposing one of
  // its own provides before the wake. PINS: the drop is honored across the eviction (the dropped
  // stub's hibernatable pager socket is gone, not resurrected; its rewrite rule is un-set) and the
  // post-wake fan-out reaches every survivor and only the survivors.
  const ctx = "prj_scale_drop";
  const K = 6;
  const clientItx = await (await openSession()).authenticate().projects.get(ctx);
  const providedRpcStubs: any[] = [];
  for (let i = 0; i < K; i++)
    providedRpcStubs.push(await clientItx.provide(`itx.k${i}`, new Echo(i)));
  const caller = await (await openSession()).authenticate().projects.get(ctx);

  // The drop must come from the PROVIDER'S OWN handle: disposing it recalls the stub THIS session
  // lent under `itx.k3` (its pager socket closes) AND un-sets the rule at `itx.k3`. A
  // `caller.provide("itx.k3", null)` would un-set the rule only — pure data never touches a
  // transport, and `caller` lent nothing under `itx.k3`, so the stub would stay in the census
  // (unreachable dotted, rule gone).
  providedRpcStubs[3][Symbol.dispose]();
  const dropped = await untilStubs(ctx, K - 1); // the relay's close lands at the DO a beat later
  expect(dropped.rpcStubPagers).toBe(K - 1);

  // The K-1 surviving lends arm nothing on their own, so warm one stub: that borrow is what arms
  // the quiet clock AND what the quiesce then has to return.
  expect(await caller.invoke("itx.k0.echo('warm')")).toBe("echo-0:warm");
  expect(await alarmAt(ctx)).not.toBeNull();
  await quiesce(ctx);
  const q = await stateOf(ctx);
  expect(q.borrowedRpcStubs).toBe(0); // the quiesce returned every borrowed stub (evict precondition)
  await evictDurableObject(stub(ctx));
  const evicted = await stateOf(ctx);
  expect(evicted.rpcStubPagers).toBe(K - 1); // survivors' hibernatable sockets rode the eviction; k3 stayed gone

  // The rule at itx.k3 is gone from the table (the dispose un-set it), and the survivors' rules
  // stayed — the table is data, untouched by the eviction.
  const snap = (await caller.invoke("itx.facets.get('core').snapshot()")) as {
    state: { itxExpressionRewriteRules: Record<string, unknown> };
  };
  const rewriteRuleMatches = Object.keys(snap.state.itxExpressionRewriteRules);
  expect(rewriteRuleMatches).not.toContain("itx.k3");
  for (let i = 0; i < K; i++) if (i !== 3) expect(rewriteRuleMatches).toContain(`itx.k${i}`);
  // fan-out = PRESENCE (`itx.rpcStubs.list()` — the keys whose hibernated pager sockets rode
  // the eviction; k3's did not) + map over the keys (each was provided with a rewrite at the same
  // spelling, so every key is callable dotted; no built-in `each`); the caller owns the allSettled.
  const rpcStubKeys = (await caller.invoke("itx.rpcStubs.list()")) as string[];
  expect(rpcStubKeys).toHaveLength(K - 1);
  expect(rpcStubKeys).not.toContain("itx.k3");
  const answers = (
    await Promise.all(
      rpcStubKeys.map((rpcStubKey) =>
        caller.invoke(`${rpcStubKey}.echo('hi')`).catch(() => undefined),
      ),
    )
  ).filter((v): v is string => v !== undefined);
  const got = new Set(answers);
  expect(answers.length).toBe(K - 1);
  for (let i = 0; i < K; i++)
    i === 3 ? expect(got.has("echo-3:hi")).toBe(false) : expect(got.has(`echo-${i}:hi`)).toBe(true);
});

// ─────────────────────────── THE ALARM'S FIRST JOB: the cursor lane's pump ───────────────────────────

/** A stateless project worker — the CURSOR lane (a Worker-Loader entrypoint cannot own its
 *  progress, so the stream keeps a kv cursor and the awaited `processEventBatch` is the ack).
 *  Throws while kv `flaky-mode` is "fail"; otherwise tallies the batch into kv `flaky-digested`. */
const FLAKY_SRC = /* js */ `
import { WorkerEntrypoint } from "cloudflare:workers";
export default class Flaky extends WorkerEntrypoint {
  async processEventBatch(events, range) {
    const itx = await this.env.ITX.get();
    if ((await itx.kv.get("flaky-mode")) === "fail") throw new Error("flaky: refusing this batch");
    const n = Number((await itx.kv.get("flaky-digested")) ?? 0) + events.length;
    await itx.kv.put("flaky-digested", String(n));
  }
}
`;
/** One `itx.subscriptions.get(name)` row — the reduced table joined with the stream-kept cursor
 *  (present only for a target the stream delivers at-least-once); `null` for an unknown name. */
type SubscriptionRow = {
  cursor?: { confirmedOffset: number; attempt: number; nextAttemptAtMs?: number };
  halted?: unknown;
} | null;
/** Poll `itx.subscriptions.get(name)` (the table ⋈ the cursor) until `ok` (bounded). */
async function untilRow(
  ctx: string,
  name: string,
  ok: (row: SubscriptionRow) => boolean,
  timeoutMs = 10_000,
): Promise<NonNullable<SubscriptionRow>> {
  const t0 = Date.now();
  for (;;) {
    const row = (await stub(ctx).invoke(`itx.subscriptions.get('${name}')`)) as SubscriptionRow;
    if (row && ok(row)) return row;
    if (Date.now() - t0 > timeoutMs)
      throw new Error(`untilRow(${name}): ${JSON.stringify(row)} after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("ALARM PUMPS THE CURSOR LANE: a failed at-least-once delivery is retried from alarm() — the cursor advances, the ladder resets", async () => {
  // The cursor lane rides THIS DO's alarm (facets have none — workerd#6810 — so a retry can never
  // live in the facet). PINS: a delivery that throws leaves a cursor row on the ladder
  // (attempt ≥ 1, a nextAttemptAtMs, NOT halted — one failure is far from 15); when the alarm fires
  // past that instant, `pumpAll` re-delivers the SAME batch from the kv cursor, the awaited call
  // acks it, and the row reads attempt 0 with its confirmedOffset at the head.
  const ctx = "prj_q_cursorpump";
  const s = stub(ctx);
  await s.invoke(["itx", "kv", ["put", "flaky-mode", "fail"]]);
  await s.append(
    subscriptionConfiguredEvent({
      name: "flaky",
      target: ["itx", ["load", { "cap.js": FLAKY_SRC }], ["getEntrypoint"], "processEventBatch"],
      consumes: ["mark"],
    }),
  );
  // (cast: workers-types' Rpc.Serializable types a StreamEvent-returning stub method as `never`)
  const [mark] = (await s.append({ type: "mark" })) as unknown as { offset: number }[];

  // The first delivery FAILS: a retry is scheduled on the ladder (≥ 1 attempt; the alarm may have
  // fired a real ~1s rung on its own by the time we look — still failing, still not halted).
  const failed = await untilRow(ctx, "flaky", (r) => (r?.cursor?.attempt ?? 0) >= 1);
  expect(failed.cursor!.attempt).toBeGreaterThanOrEqual(1);
  expect(failed.cursor!.nextAttemptAtMs).toBeGreaterThan(0);
  expect(failed.cursor!.confirmedOffset).toBeLessThan(mark.offset); // the mark is NOT acked
  expect(failed.halted).toBeUndefined();
  expect(await s.invoke(["itx", "kv", ["get", "flaky-digested"]])).toBeNull();

  // Heal the target, then fire the alarm with Date faked PAST the retry instant (30s clears every
  // early rung of the 1s·2ⁿ ladder; well short of the 60s quiesce).
  await s.invoke(["itx", "kv", ["put", "flaky-mode", "ok"]]);
  vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
  try {
    vi.setSystemTime(Date.now() + 30_000);
    await runDurableObjectAlarm(s);
  } finally {
    vi.useRealTimers();
  }

  // pumpAll delivered from the cursor: the mark reached the worker exactly once, the ladder reset,
  // the cursor sits at the head.
  const after = await untilRow(ctx, "flaky", (r) => r?.cursor?.attempt === 0);
  expect(after.cursor!.confirmedOffset).toBeGreaterThanOrEqual(mark.offset);
  expect(after.cursor!.nextAttemptAtMs).toBeUndefined();
  expect(after.halted).toBeUndefined();
  expect(await s.invoke(["itx", "kv", ["get", "flaky-digested"]])).toBe("1");
});

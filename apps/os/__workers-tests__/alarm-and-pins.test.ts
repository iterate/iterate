// __workers-tests__/alarm-and-pins.test.ts — the context DO's alarm, inside workerd (the workers
// lane — the ONLY lane that can fire the DO's alarm (runDurableObjectAlarm) and force a graceful
// teardown (evictDurableObject) deterministically).
//
// Target surface: IterateContextDurableObject.alarm()/#pinCallEnded, FacetHost#liveFacetNames/#facetWorkInFlight
// (src/iterate-context-durable-object.ts), the delivery loop's cursor lane +
// `deliverEveryCursorSubscription` (src/stream/subscription-delivery.ts), and the rpc-stub directory
// (src/context/rpc-stubs.ts).
//
// THE ALARM SERVES DURABLE OBLIGATIONS ONLY, in order — this file pins the cursor half and the
// negative space:
//   1. the due scheduled appends (scheduled-appends.test.ts);
//   2. `deliverEveryCursorSubscription`: every CURSOR subscription (a target that cannot own its
//      progress — a stateless Worker-Loader entrypoint) whose claim is due is delivered from its
//      cursor row; the awaited call is the ack, the ladder resets;
//   3. the due CLAIMS of hosted processors (agent-revive.test.ts): each spent, the facet revived.
// PINS ARE NOT THE ALARM'S: a borrowed stub or an open library socket keeps an actor resident on the
// edge (measured), and a TIMER 30 s after the pin's last use returns the stubs and closes the sockets
// — memory releasing memory, no durable alarm. A facet is NOT a pin: on the edge it does not hold
// the actor (it runs on after it; the next incarnation's birth resets it unless it is claimed —
// FacetHost `resetUnclaimedLoadedFacets`). Here in workerd a materialized facet or a borrowed stub does keep the DO non-hibernatable
// (workerd#6800 — evictDurableObject on such a DO times out after 30s, "still has active
// references"), so a test must release BEFORE it can evict (support.ts's `releasePins` runs the release
// directly, facets included).
//
// PROCESSORS here are what they are everywhere: userspace two-class sources — a pure
// `StreamProcessor` (`CounterProcessor`) and its one-line `StreamProcessorDurableObject` host
// (`CounterDurableObject`, the class the load chain names) — loaded through the Worker Loader and
// hosted as facets (there are no built-in processors). The workers lane materializes them fine (the
// loader accepts allow_irrevocable_stub_storage), so every facet-lifecycle pin rides the inline
// `CounterProcessor` source below, enabled the way the `itx.processors.enable` root spells it — ONE
// `subscription-configured` whose target is the facet's `processEventBatch` through the load chain,
// appended at the DO's one write door (`append`; the DO has no configuration verbs). Live stubs
// (over hibernatable stub pager sockets) work fully here too — see hibernation-at-scale.test.ts.

import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import type { ItxExpression } from "iterate/next/expression";
import type { StreamEvent } from "iterate/next/stream/processor";
import type { AlarmTrace } from "../src/iterate-context-durable-object.ts";
import { STREAM_ALARM_TRACE_EVENT } from "../src/stream/stream.ts";
import {
  adminCredentials,
  Echo,
  openSession,
  owedAlarm,
  releasePins,
  stub,
  until,
} from "./support.ts";

/** A tiny userspace processor: counts every durable event. The tally fixture's shape
 *  (e2e/support/sources.ts), reduced to one number — the pure `CounterProcessor` plus its host
 *  `CounterDurableObject`, which is what the load chain names. */
const COUNTER_SRC = /* js */ `
import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "./processor.js";
const contract = defineProcessorContract({
  slug: "counter",
  version: "1.0.0",
  description: "counts durable events",
  stateSchema: z.object({ n: z.number().default(0) }),  consumes: ["*"],
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
// The number of DURABLE events a "*" consumer sees (read is durable-only; every incarnation's wake
// record is one of them). CounterProcessor consumes "*", so its `n` equals this — the exact-once
// invariant. (Not `n === offset`: every processor's live-state delta is an ephemeral that consumes
// an offset, so a durable event's offset exceeds the count of durable events before it.)
const durableCount = async (ctx: string): Promise<number> =>
  ((await stub(ctx).invoke(["itx", ["readEvents", 0, 500]])) as { events: unknown[] }).events
    .length;

/** The `itx.processors.enable(name, { source, className })` root, spelled raw at the DO door: ONE
 *  subscription-configured event — a literal appended through `append` (normalized at the boundary)
 *  — whose target is the facet's `processEventBatch` through the load chain (the facet name = the
 *  subscription name = the `.get(name)` name). */
async function enableCounter(ctx: string, name = "counter"): Promise<void> {
  const s = stub(ctx);
  await s.append({
    type: "events.iterate.com/stream/subscription-configured",
    payload: {
      name,
      target: [
        "itx",
        "facets",
        ["get", name, { source: { "cap.js": COUNTER_SRC }, className: "CounterDurableObject" }],
        "processEventBatch",
      ],
    },
  });
}
/** The `itx.processors.disable(name)` root: ONE event — `target: null`; the DO deletes the facet the
 *  row hosted, storage included, before the append returns. */
async function disableCounter(ctx: string, name = "counter"): Promise<void> {
  await stub(ctx).append({
    type: "events.iterate.com/stream/subscription-configured",
    payload: { name, target: null },
  });
}

// The DO-only transport facts ({stubs, borrowed, rpcStubPagesInFlight, dormant}) — the release probes are
// in-memory socket truths, so they speak rpcStubTransportState(), never the table.
const stateOf = (ctx: string): Promise<Record<string, any>> =>
  runInDurableObject(stub(ctx), async (inst) =>
    (inst as unknown as { rpcStubTransportState(): Record<string, any> }).rpcStubTransportState(),
  );
/** The alarm the context OWES (support.ts `owedAlarm` — the residency watchdog's deadline is no
 *  obligation), or null: only a test inside workerd can read the alarm, and it is the ONE proof that
 *  a release pin below is exercising the alarm instead of firing into an empty schedule. */
const owedAlarmAt = async (ctx: string): Promise<number | null> =>
  owedAlarm(await runInDurableObject(stub(ctx), (_inst, state) => state.storage.getAlarm()));
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

// ─────────── THE RELEASE (`releasePins`, run directly by these tests), and what survives the eviction it enables ───────────

test("QUIESCE PRESERVES CURSOR+STATE: abort an idle facet, re-materialize from the startup memo, snapshot is unchanged", async () => {
  // A facet aborted by the release and re-materialized by the next call (`itx.facets.get(name)`
  // reads the `facet:<name>` startup memo — no configure(), no side channel; its identity is
  // ctx.props) keeps its durable checkpoint + reduced state. Were re-materialization broken, the
  // post-release snapshot would throw NO_FACET or reset to n=0.
  const ctx = "prj_q_cursor";
  const s = stub(ctx);
  await enableCounter(ctx);
  await s.append({ type: "a/1" }, { type: "a/2" }, { type: "a/3" });
  await new Promise((r) => setTimeout(r, 150));
  const before = await snapCounter(ctx);
  expect(before.state.n).toBe(await durableCount(ctx)); // every durable event counted, no double/no loss

  // Idle 61s → the release aborts the facet (its checkpoint is durable in its OWN storage).
  await releasePins(ctx);

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
  // header). The forceable, production-shaped path is the release (abort) → evict (fresh parent
  // incarnation) → wake. PINS: on wake the facet gap-repairs from its own durable checkpoint — the
  // reduced count equals the number of durable events, never more (no double durable effect) and
  // never fewer (no lost catch-up).
  const ctx = "prj_q_evict";
  const s = stub(ctx);
  await enableCounter(ctx);
  // Commit a run of durable events and let the facet drive them fully (so no drive is in flight —
  // an in-flight drive keeps facetWorkInFlight > 0, the release is skipped, the facet stays
  // materialized, and evict then times out on the #6800 pin).
  await s.append({ type: "b/1" }, { type: "b/2" }, { type: "b/3" }, { type: "b/4" });
  await new Promise((r) => setTimeout(r, 300));

  // The release (aborts the idle facet → un-pins the DO), then a REAL graceful eviction: storage kept,
  // in-memory torn down, a fresh parent incarnation on the next call (a genuine cold catch-up from
  // the log — the property under test).
  await releasePins(ctx);
  await evictDurableObject(s);

  const after = await snapCounter(ctx); // wakes a fresh incarnation → catch-up from the durable checkpoint
  expect(after.state.n).toBeGreaterThanOrEqual(7); // created, the first woken, subscription-configured, b/1..b/4 — and one woken per incarnation since
  expect(after.state.n).toBe(await durableCount(ctx)); // EXACTLY one reduce per durable event across the eviction
});

test("DISABLE deletes the facet's storage; RE-ENABLE rebuilds from the log (no stale checkpoint, no skipped events)", async () => {
  // `processors.disable` = unsubscribe + `itx.facets.delete(name)` (ctx.facets.delete exists on every
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

/** A facet that counts bumps in its OWN kv — state a processor's checkpoint stands in for. */
const BUMP_COUNTER_SRC = /* js */ `
import { FacetDurableObject } from "./processor.js";
export class BumpCounterDurableObject extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "bump", "count"];
  bump() { const n = (this.ctx.storage.kv.get("n") ?? 0) + 1; this.ctx.storage.kv.put("n", n); return n; }
  count() { return this.ctx.storage.kv.get("n") ?? 0; }
  processEventBatch() {}
  catchUpFromLog() {}
}
`;
test("a facet TWO rows host survives the removal of ONE of them — memo and storage intact (the delete is the LAST hosting row's, or the survivor would rebuild from 0 and re-run every effect)", async () => {
  const context = stub("prj_shared_facet");
  const spec = { source: { "cap.js": BUMP_COUNTER_SRC }, className: "BumpCounterDurableObject" };
  const target: ItxExpression = ["itx", "facets", ["get", "shared", spec], "processEventBatch"];
  // Two rows, both HOSTING the same facet — the `processors.enable` shape, twice.
  await context.append({
    type: "events.iterate.com/stream/subscription-configured",
    payload: { name: "a", target, consumes: ["demo/ping"] },
  });
  await context.append({
    type: "events.iterate.com/stream/subscription-configured",
    payload: { name: "b", target, consumes: ["demo/ping"] },
  });
  await context.invoke(["itx", "facets", ["get", "shared", spec], ["bump"]]);
  await context.invoke(["itx", "facets", ["get", "shared", spec], ["bump"]]);
  expect(await context.invoke(["itx", "facets", ["get", "shared", spec], ["count"]])).toBe(2);

  // Remove ONE of the two rows. The other still hosts the facet.
  await context.append({
    type: "events.iterate.com/stream/subscription-configured",
    payload: { name: "a", target: null },
  });
  const core = (await context.invoke("itx.facets.get('core').snapshot()")) as {
    state: { subscriptions: Record<string, unknown> };
  };
  expect(Object.keys(core.state.subscriptions)).toEqual(["b"]);
  // The startup memo row "b" depends on, and the facet's own storage, are both still there.
  const memo = await runInDurableObject(context, (_instance, state) =>
    Promise.resolve(state.storage.kv.get("facet:shared") ?? null),
  );
  const count = await context.invoke(["itx", "facets", ["get", "shared", spec], ["count"]]);
  expect({ memoKept: !!memo, count }).toEqual({ memoKept: true, count: 2 });
});

test("RE-ENABLE WITH NEW SOURCE: a materialized processor re-enabled under the same name and class with changed source runs the NEW code on its next call, its storage preserved", async () => {
  // The reduced row carries no source (M1); the facet's startup memo is the one place a
  // materialization reads it from. PINS: the hosting configure refreshes that memo (the DO's commit
  // effect), so the next call loads the new source under a new loader identity and restarts the
  // facet IN PLACE — its checkpoint continues, never a rebuild from 0.
  const ctx = "prj_reenable_source";
  const s = stub(ctx);
  await enableCounter(ctx); // counts by 1
  await s.append({ type: "a/1" });
  await new Promise((r) => setTimeout(r, 300));
  const before = await snapCounter(ctx);
  expect(before.state.n).toBe(await durableCount(ctx));
  // The same name and class, NEW source: counts by 10.
  await s.append({
    type: "events.iterate.com/stream/subscription-configured",
    payload: {
      name: "counter",
      target: [
        "itx",
        "facets",
        [
          "get",
          "counter",
          {
            source: { "cap.js": COUNTER_SRC.replace("state.n + 1", "state.n + 10") },
            className: "CounterDurableObject",
          },
        ],
        "processEventBatch",
      ],
    },
  });
  await new Promise((r) => setTimeout(r, 400));
  await s.append({ type: "a/2" });
  await new Promise((r) => setTimeout(r, 400));
  const after = await snapCounter(ctx);
  // The re-configure and a/2 — two durable events — each counted by TEN by the new code, on top of
  // the preserved count (a rebuild from 0 would count the whole log by ten; the old code by one).
  expect(after.state.n).toBe(before.state.n + 20);
});

// ─────────── THE ONE ALARM: no wake without a reason, and every decision observable ───────────

test("A BARE PROBE ON A DORMANT CONTEXT LEAVES NO ALARM: nothing is subscribed or pinned — the every-minute wake loop's negative", async () => {
  const ctx = "prj_q_bare_probe";
  const s = stub(ctx);
  // The probe creates no subscription or outstanding delivery.
  await s.invoke("itx.schedules.list()");
  await until("no alarm", async () => (await owedAlarmAt(ctx)) === null);
  expect(await owedAlarmAt(ctx)).toBeNull();
});

test("AN OBSERVED PASS: an exact waitForEvent observer receives one ephemeral trace, a read with includeEphemeral holds the whole pass, and the durable log holds only what the pass appended", async () => {
  const ctx = "prj_q_observed";
  const s = stub(ctx);
  // A SCHEDULE is what arms this alarm (a pin arms nothing: pins are released by a timer).
  await s.invoke([
    "itx",
    "schedules",
    ["set", { key: "tick", when: { afterMs: 61_000 }, events: [{ type: "tick" }] }],
  ]);
  expect(await owedAlarmAt(ctx)).not.toBeNull();
  const rowsBefore = await durableCount(ctx);
  const observed = s.invoke([
    "itx",
    ["waitForEvent", { type: STREAM_ALARM_TRACE_EVENT, timeoutMs: 10_000 }],
  ]) as Promise<StreamEvent>;
  await new Promise((r) => setTimeout(r, 100)); // the waiter is registered
  vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
  try {
    vi.setSystemTime(Date.now() + 61_000);
    expect(await runDurableObjectAlarm(s)).toBe(true); // the observed pass: its first trace answers the waiter
  } finally {
    vi.useRealTimers();
  }
  const trace = await observed;
  expect(trace).toMatchObject({ type: STREAM_ALARM_TRACE_EVENT, ephemeral: true });
  expect(trace.payload).toMatchObject({ reason: "alarm-fired", dueSchedules: 1 });
  const ring = (
    (await s.invoke(["itx", ["readEvents", 0, 500, { includeEphemeral: true }]])) as {
      events: StreamEvent[];
    }
  ).events
    .filter((event) => event.type === STREAM_ALARM_TRACE_EVENT)
    .map((event) => event.payload as unknown as AlarmTrace);
  expect(ring.map((t) => t.reason)).toEqual(["alarm-fired", "alarm-pass"]);
  // The tick and its completion are the pass's two durable rows; the traces took none.
  expect(await durableCount(ctx)).toBe(rowsBefore + 2);
  // The one-shot schedule spent and the tick's delivery acked: no deadline left, no alarm.
  await until("no alarm", async () => (await owedAlarmAt(ctx)) === null);
});
test(
  "NO PIN ARMS AN ALARM: a facet arms nothing, a borrowed stub arms nothing — the stub is returned by a TIMER 30 s after its last use, and a call after that borrows it again",
  { timeout: 60_000 },
  async () => {
    const ctx = "prj_q_pin_clock";
    const s = stub(ctx);
    await enableCounter(ctx);
    await s.append({ type: "a/1" }); // the push materializes the facet
    await new Promise((r) => setTimeout(r, 300));
    await snapCounter(ctx); // and a direct facet call
    await until("config acked", async () => (await owedAlarmAt(ctx)) === null);
    expect(await owedAlarmAt(ctx)).toBeNull(); // a facet does not keep the actor resident on the edge: no deadline, no alarm
    // A borrowed stub DOES pin the actor — and still arms nothing: a pin is memory, released by a
    // timer that is memory too (the stub keeps the actor resident until it fires).
    const clientItx = await (
      await openSession()
    )
      .authenticate(adminCredentials())
      .projects.get(ctx);
    await clientItx.provide("itx.p0", new Echo(0));
    const caller = await (await openSession()).authenticate(adminCredentials()).projects.get(ctx);
    const usedAt = Date.now();
    expect(await caller.invoke("itx.p0.echo('warm')")).toBe("echo-0:warm");
    expect((await stateOf(ctx)).borrowedRpcStubs).toBeGreaterThanOrEqual(1);
    expect(await owedAlarmAt(ctx)).toBeNull();
    await s.invoke("itx.schedules.list()"); // a request, not a pin's use
    await snapCounter(ctx); // a facet call: not a pin's use either
    expect(await owedAlarmAt(ctx)).toBeNull();
    // THE TIMER: the quiet period after the stub's last use ends with the stub returned.
    await until(
      "released by the timer",
      async () => (await stateOf(ctx)).borrowedRpcStubs === 0,
      45_000,
    );
    expect(Date.now() - usedAt).toBeGreaterThanOrEqual(30_000);
    expect(await owedAlarmAt(ctx)).toBeNull();
    // A call after the release borrows again (the pager re-dials): a fresh quiet period.
    expect(await caller.invoke("itx.p0.echo('again')")).toBe("echo-0:again");
    expect((await stateOf(ctx)).borrowedRpcStubs).toBeGreaterThanOrEqual(1);
    await releasePins(ctx);
    expect((await stateOf(ctx)).borrowedRpcStubs).toBe(0);
    expect(await owedAlarmAt(ctx)).toBeNull();
  },
);
test("A '*' FACET WAKE ARMS NOTHING: a facet-hosting context holds no alarm after a request, and an alarm-woken incarnation whose wake record materializes the facet leaves none either — one woken, then quiet", async () => {
  const ctx = "prj_q_star_facet_wake";
  const s = stub(ctx);
  await enableCounter(ctx); // a "*" facet: every incarnation's wake record is pushed to it
  await s.append({ type: "a/1" });
  await new Promise((r) => setTimeout(r, 300));
  await until("config acked", async () => (await owedAlarmAt(ctx)) === null);
  expect(await owedAlarmAt(ctx)).toBeNull(); // the live facet armed nothing: it is not a pin
  const wokens = async () =>
    ((await s.invoke(["itx", ["readEvents", 0, 500]])) as { events: StreamEvent[] }).events.filter(
      (event) => event.type === "events.iterate.com/stream/woken",
    );
  const before = (await wokens()).length;
  // A due schedule fires into an evicted actor: the fresh incarnation's wake record materializes
  // the counter for the push, and the pass arms nothing for it. (An alarm with nothing durable due
  // wakes nothing at all — residency-watchdog.test.ts.) The schedule's own event is pushed to the
  // counter first, so its push settles before the release un-pins the facet.
  await s.invoke([
    "itx",
    "schedules",
    ["set", { key: "wake", when: { afterMs: 1_500 }, events: [{ type: "wake" }] }],
  ]);
  await new Promise((r) => setTimeout(r, 300));
  await releasePins(ctx); // un-pin the facet so the eviction below can happen (workerd pins, the edge does not)
  await evictDurableObject(s);
  await new Promise((r) => setTimeout(r, 2_500));
  expect(await owedAlarmAt(ctx)).toBeNull(); // (a read constructs nothing: the alarm is storage)
  await new Promise((r) => setTimeout(r, 1_500));
  const woken = await wokens(); // this read is a request: at most one more incarnation, by request
  expect(woken.slice(before).map((event) => (event.payload as { reason: string }).reason)).toEqual(
    expect.arrayContaining(["alarm"]),
  );
  expect(woken.length).toBeLessThanOrEqual(before + 2);
  expect(
    woken.slice(before).filter((e) => (e.payload as { reason: string }).reason === "alarm"),
  ).toHaveLength(1);
  expect((await snapCounter(ctx)).state.n).toBe(await durableCount(ctx)); // the wake record reached the "*" facet exactly once
});

test("A WAKE MAKES NO LOOP: an incarnation the alarm woke delivers its own wake record to the config row, acks, and ends with no alarm — one woken per incarnation, never a second", async () => {
  const ctx = "prj_q_wake_no_loop";
  const s = stub(ctx);
  await s.invoke("itx.schedules.list()"); // born: created, woken, the config row
  await until("no alarm", async () => (await owedAlarmAt(ctx)) === null);
  const wokens = async () =>
    ((await s.invoke(["itx", ["readEvents", 0, 500]])) as { events: StreamEvent[] }).events.filter(
      (event) => event.type === "events.iterate.com/stream/woken",
    );
  const before = (await wokens()).length;
  // A due schedule (set on the quiet incarnation, which is then evicted) fires for real and wakes a
  // FRESH incarnation, whose wake record says so. (An alarm with nothing durable due — a stray one a
  // dead incarnation left — wakes nothing at all: residency-watchdog.test.ts.)
  await s.invoke([
    "itx",
    "schedules",
    ["set", { key: "wake", when: { afterMs: 300 }, events: [{ type: "wake" }] }],
  ]);
  await evictDurableObject(s);
  await new Promise((r) => setTimeout(r, 1_500)); // the alarm has fired; nothing else has touched the context
  const woken = await wokens();
  expect(woken).toHaveLength(before + 1);
  expect(woken.at(-1)!.payload).toMatchObject({ reason: "alarm" });
  // Its own wake record delivered and acked, nothing pinned: no alarm — and none appears.
  await until("no alarm", async () => (await owedAlarmAt(ctx)) === null);
  await new Promise((r) => setTimeout(r, 1_500));
  expect(await owedAlarmAt(ctx)).toBeNull();
  expect(await wokens()).toHaveLength(before + 1);
});

test("A BORROW ARMS NOTHING: the first call through a stub — a live '*' subscriber's callback lent, and a commit's reconcile landing while that first call is in flight — leaves no alarm and runs no pass", async () => {
  const ctx = "prj_q_first_borrow";
  const clientItx = await (await openSession()).authenticate(adminCredentials()).projects.get(ctx);
  await clientItx.provide("itx.p0", new Echo(0));
  const caller = await (await openSession()).authenticate(adminCredentials()).projects.get(ctx);
  // The first borrow through a PUSH: a live "*" subscriber's callback is lent, and the commit that
  // pushes to it acks the config row meanwhile — a reconcile lands while the stub's first call is
  // still in flight, with the borrow already counted.
  const seen: unknown[] = [];
  await clientItx.subscribe({
    name: "live",
    consumes: ["*"],
    target: (events: unknown[]) => void seen.push(...events),
  });
  await stub(ctx).append({ type: "mark" });
  expect(await caller.invoke("itx.p0.echo('first')")).toBe("echo-0:first"); // and a direct borrow
  await new Promise((r) => setTimeout(r, 800)); // an alarm armed for the borrow would show by now
  await until("config acked", async () => (await owedAlarmAt(ctx)) === null);
  expect(await owedAlarmAt(ctx)).toBeNull();
  const ring = (
    (await stub(ctx).invoke(["itx", ["readEvents", 0, 500, { includeEphemeral: true }]])) as {
      events: StreamEvent[];
    }
  ).events.filter((event) => event.type === STREAM_ALARM_TRACE_EVENT);
  expect(ring).toEqual([]); // no pass ran: nothing was due
});
test("A BORROW RACES THE RELEASE: a stub invoke fired concurrently with the pins' release still answers", async () => {
  // A release RETURNS borrowed stubs (#borrowed) but never touches a PENDING page (#rpcStubPagesInFlight),
  // and the borrow the invoke makes is a pin's use that keeps the actor warm: an invoke that borrows
  // a stub while the release runs resolves with the right per-client answer (the stub it is
  // borrowing is not returned out from under it).
  const ctx = "prj_pagein";
  const clientItx = await (await openSession()).authenticate(adminCredentials()).projects.get(ctx);
  for (let i = 0; i < 4; i++) await clientItx.provide(`itx.p${i}`, new Echo(i));
  const caller = await (await openSession()).authenticate(adminCredentials()).projects.get(ctx);
  expect(await caller.invoke("itx.p0.echo('warm')")).toBe("echo-0:warm");
  expect((await stateOf(ctx)).borrowedRpcStubs).toBeGreaterThanOrEqual(1);
  const [, raced] = await Promise.all([releasePins(ctx), caller.invoke("itx.p2.echo('race')")]);
  expect(raced).toBe("echo-2:race");
});
test("SCALE DROP + QUIESCE + EVICT + WAKE: a DISPOSED live provide stays gone; the fan-out reaches EXACTLY the survivors", async () => {
  // Extends hibernation-at-scale's "eviction preserves the fleet" with a provider disposing one of
  // its own provides before the wake. PINS: the drop is honored across the eviction (the dropped
  // stub's hibernatable pager socket is gone, not resurrected; its rewrite rule is un-set) and the
  // post-wake fan-out reaches every survivor and only the survivors.
  const ctx = "prj_scale_drop";
  const K = 6;
  const clientItx = await (await openSession()).authenticate(adminCredentials()).projects.get(ctx);
  const providedRpcStubs: any[] = [];
  for (let i = 0; i < K; i++)
    providedRpcStubs.push(await clientItx.provide(`itx.k${i}`, new Echo(i)));
  const caller = await (await openSession()).authenticate(adminCredentials()).projects.get(ctx);

  // The drop must come from the PROVIDER'S OWN handle: disposing it recalls the stub THIS session
  // lent under `itx.k3` (its pager socket closes) AND un-sets the rule at `itx.k3`. A
  // `caller.provide("itx.k3", null)` would un-set the rule only — pure data never touches a
  // transport, and `caller` lent nothing under `itx.k3`, so the stub would stay in the census
  // (unreachable dotted, rule gone).
  providedRpcStubs[3][Symbol.dispose]();
  const dropped = await untilStubs(ctx, K - 1); // the relay's close lands at the DO a beat later
  expect(dropped.rpcStubPagers).toBe(K - 1);

  // Warm one stub: that borrow is what the release then has to return — and it arms nothing.
  expect(await caller.invoke("itx.k0.echo('warm')")).toBe("echo-0:warm");
  expect(await owedAlarmAt(ctx)).toBeNull();
  await releasePins(ctx);
  const q = await stateOf(ctx);
  expect(q.borrowedRpcStubs).toBe(0); // the release returned every borrowed stub (evict precondition)
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
 *  progress, so the stream keeps a cursor row and the awaited `processEventBatch` is the ack).
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
  // past that instant, `deliverEveryCursorSubscription` re-delivers the SAME batch from the cursor
  // row, the awaited call acks it, and the row reads attempt 0 with its confirmedOffset at the head.
  const ctx = "prj_q_cursorpump";
  const s = stub(ctx);
  await s.invoke(["itx", "kv", ["put", "flaky-mode", "fail"]]);
  await s.append({
    type: "events.iterate.com/stream/subscription-configured",
    payload: {
      name: "flaky",
      target: ["itx", "workers", ["get", { source: { "cap.js": FLAKY_SRC } }], "processEventBatch"],
      consumes: ["mark"],
    },
  });
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
  // early rung of the 1s·2ⁿ ladder; a rung the 30 s release is not part of).
  await s.invoke(["itx", "kv", ["put", "flaky-mode", "ok"]]);
  vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
  try {
    vi.setSystemTime(Date.now() + 30_000);
    await runDurableObjectAlarm(s);
  } finally {
    vi.useRealTimers();
  }

  // deliverEveryCursorSubscription delivered from the cursor: the mark reached the worker exactly
  // once, the ladder reset, the cursor sits at the head.
  const after = await untilRow(ctx, "flaky", (r) => r?.cursor?.attempt === 0);
  expect(after.cursor!.confirmedOffset).toBeGreaterThanOrEqual(mark.offset);
  expect(after.cursor!.nextAttemptAtMs).toBeUndefined();
  expect(after.halted).toBeUndefined();
  expect(await s.invoke(["itx", "kv", ["get", "flaky-digested"]])).toBe("1");
  // Caught up, nothing pinned: the pass left no alarm behind.
  expect(await owedAlarmAt(ctx)).toBeNull();
});

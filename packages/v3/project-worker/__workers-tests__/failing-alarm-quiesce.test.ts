// __workers-tests__/failing-alarm-quiesce.test.ts — THE ALARM / 60s-QUIESCE / EVICTION BUG HUNT,
// inside workerd (the pool-workers lane — the ONLY lane that can fire the DO's alarm
// (runDurableObjectAlarm) and force a graceful teardown (evictDurableObject) deterministically).
//
// Target surface: IterateContextDurableObject.alarm()/#noteActivity/#liveFacets/#facetWorkInFlight
// (src/iterate-context-durable-object.ts), the delivery loop's cursor lane + `pumpAll`
// (src/stream/subscription-delivery.ts), and the rpc-stub directory (src/context/rpc-stub-directory.ts).
//
// THE ALARM DOES TWO THINGS, IN ORDER — this file pins both:
//   1. `pumpAll`: every CURSOR subscription (a target that cannot own its progress — a stateless
//      Worker-Loader entrypoint) whose retry is due is pumped from its kv cursor; the awaited call
//      is the ack, the ladder resets. AWAITED before step 2, so the quiesce never aborts a
//      delivery in flight and a later retry's re-arm lands before the actor hibernates.
//   2. the idle QUIESCE: 60s without activity (and nothing in flight) aborts every live facet and
//      disposes every paged-in RetainedCallbackInvoker stub, so the actor can hibernate. A
//      MEASURED PROPERTY, load-bearing below: a materialized facet or a retained stub PINS the DO
//      non-hibernatable (workerd#6800) — evictDurableObject on such a DO times out after 30s
//      ("still has active references"). You must quiesce BEFORE you can evict — the exact
//      production sequence.
//
// PROCESSORS here are what they are everywhere: userspace `StreamProcessorDurableObject`
// subclasses loaded through the Worker Loader and hosted as facets (there are no built-in
// processors). The pool lane materializes them fine (the loader accepts
// allow_irrevocable_stub_storage), so every facet-lifecycle pin rides the inline `Counter` source
// below, enabled the way the edge's `enableProcessor` spells it — ONE `subscription-configured`
// whose target is the facet's `processEventBatch` through the load chain. CONNECTIONS
// (hibernatable stub pagers) work fully here too — see hibernation-at-scale.test.ts.

import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { afterAll, expect, test, vi } from "vitest";
import { canonicalName } from "../src/context/durable-object-names.ts";
import type { IterateContextDurableObject } from "../src/iterate-context-durable-object.ts";

const stub = (ctx: string) =>
  (
    env as unknown as { CONTEXT: DurableObjectNamespace<IterateContextDurableObject> }
  ).CONTEXT.getByName(canonicalName(ctx));

/** A tiny userspace processor: counts every durable event. The tally fixture's shape
 *  (e2e/support/sources.ts), reduced to one number. */
const COUNTER_SRC = /* js */ `
import { StreamProcessorDurableObject, defineProcessorContract, z } from "./processor.js";
const contract = defineProcessorContract({
  slug: "counter",
  version: "1.0.0",
  description: "counts durable events",
  stateSchema: z.object({ n: z.number().default(0) }),
  events: {},
  consumes: ["*"],
  emits: [],
});
export class Counter extends StreamProcessorDurableObject {
  contract = contract;
  reduce({ state }) { return { n: state.n + 1 }; }
}
`;

type FacetSnap = { offset: number; state: { n: number } };
const snapCounter = (ctx: string, name = "counter") =>
  stub(ctx).invoke(["itx", "facets", ["get", name], ["snapshot"]]) as Promise<FacetSnap>;
// The number of DURABLE events (read is durable-only). Counter consumes "*", so its `n` equals this
// — the exact-once invariant. (Not `n === offset`: every processor's live-state delta is an
// ephemeral that consumes an offset, so a durable event's offset exceeds the count of durable
// events before it.)
const durableCount = async (ctx: string): Promise<number> =>
  ((await stub(ctx).invoke(["itx", ["read", 0, 500]])) as { events: unknown[] }).events.length;

/** The edge's `enableProcessor(name, { source, className })`, spelled at the DO door: ONE
 *  subscription-configured whose target is the facet's `processEventBatch` through the load chain
 *  (the facet name = the subscription name = the `.get(name)` name). */
async function enableCounter(ctx: string, name = "counter"): Promise<void> {
  const s = stub(ctx);
  await s.invoke(["itx", "kv", ["put", "procsrc", COUNTER_SRC]]);
  await s.configureSubscription({
    name,
    target: [
      "itx",
      ["load", "itx.kv.get('procsrc')"],
      ["getDurableObjectClass", "Counter"],
      ["get", name],
      "processEventBatch",
    ],
  });
}
/** The edge's `disableProcessor(name)`: unsubscribe, then delete the facet — storage included. */
async function disableCounter(ctx: string, name = "counter"): Promise<void> {
  const s = stub(ctx);
  await s.removeSubscription(name);
  await s.invoke(["itx", "facets", ["delete", name]]);
}

// The DO-only transport facts ({stubs, pagedIn, pagesPending, dormant}) — the quiesce probes are
// in-memory socket truths, so they speak transportState(), never the table.
const stateOf = (ctx: string): Promise<Record<string, any>> =>
  runInDurableObject(stub(ctx), async (inst) =>
    (inst as unknown as { transportState(): Record<string, any> }).transportState(),
  );
/** Poll the census until `stubs` reaches `n` (bounded). A transport leaves the census when its
 *  pager socket's CLOSE lands at the DO — a physical fact that arrives a beat after the edge
 *  disposes its relay, never inside the RPC that triggered it. */
async function untilStubs(ctx: string, n: number, timeoutMs = 5_000): Promise<Record<string, any>> {
  const t0 = Date.now();
  for (;;) {
    const s = await stateOf(ctx);
    if (s.stubs === n) return s;
    if (Date.now() - t0 > timeoutMs)
      throw new Error(`untilStubs(${ctx}, ${n}): still ${s.stubs} after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Reproduce the production 60s idle quiesce ON DEMAND: fake Date only (+61s — sockets, the alarm
 *  scheduler and real timers stay real), fire the armed alarm, restore real time. Mirrors
 *  hibernation-at-scale.test.ts's quiesceLikeProduction. */
async function quiesce(ctx: string): Promise<Record<string, any>> {
  vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
  try {
    vi.setSystemTime(Date.now() + 61_000);
    await runDurableObjectAlarm(stub(ctx));
  } finally {
    vi.useRealTimers();
  }
  return stateOf(ctx);
}

// ── rpc-stub plumbing (for items 5 + 6) — the hibernation-at-scale pattern, minimized ──

class Echo extends RpcTarget {
  readonly #i: number;
  constructor(i: number) {
    super();
    this.#i = i;
  }
  echo(s: string): string {
    return `echo-${this.#i}:${s}`;
  }
}
const DISPOSE: symbol | undefined = (Symbol as { dispose?: symbol }).dispose;
const sessions: unknown[] = [];
async function openSession(): Promise<any> {
  const res = await SELF.fetch(`https://test.local/api`, {
    headers: { Upgrade: "websocket" },
  });
  if (!res.webSocket) throw new Error(`expected a 101 with a WebSocket, got ${res.status}`);
  res.webSocket.accept();
  const session = newWebSocketRpcSession(res.webSocket as unknown as WebSocket);
  sessions.push(session);
  return session as any;
}
afterAll(async () => {
  // Let any fire-and-forget page/alarm cleanup drain before the pool worker's RPC is torn down —
  // otherwise a still-pending resolve surfaces as a (harmless) EnvironmentTeardownError.
  await new Promise((r) => setTimeout(r, 50));
  for (const s of sessions) {
    try {
      if (DISPOSE) (s as Record<symbol, () => void>)[DISPOSE]?.();
    } catch {
      /* already broken */
    }
  }
});

// ─────────────────────────── REGRESSIONS (forceable, assert CORRECT) ───────────────────────────

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
  // re-catch-up reads to scannedThroughOffset (the raw head), which grew as Counter's own trailing
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
  expect(after.state.n).toBeGreaterThanOrEqual(5); // subscription-configured (1) + b/1..b/4 (4), + the wake record
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

test("PAGE-IN RACES THE QUIESCE ALARM: a connection invoke fired concurrently with the alarm still answers", async () => {
  // A quiesce disposes RETAINED stubs (#retained) but never touches a PENDING page (#pagesPending),
  // and the invoke's own #noteActivity keeps the actor warm. PINS: an invoke that pages a stub in
  // while the 60s alarm fires resolves with the right per-client answer (the wake's borrowed stub
  // is not disposed out from under it).
  const ctx = "prj_pagein";
  const clientItx = await (await openSession()).authenticate().projects.get(ctx);
  for (let i = 0; i < 4; i++) await clientItx.provide(`itx.p${i}`, new Echo(i));
  const caller = await (await openSession()).authenticate().projects.get(ctx);

  vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
  let raced: unknown;
  try {
    vi.setSystemTime(Date.now() + 61_000);
    const alarmP = runDurableObjectAlarm(stub(ctx));
    const invokeP = caller.invokeCapability("itx.p2.echo('race')");
    const [, inv] = await Promise.all([alarmP, invokeP]);
    raced = inv;
  } finally {
    vi.useRealTimers();
  }
  expect(raced).toBe("echo-2:race");
});

test("SCALE DROP + QUIESCE + EVICT + WAKE: a dropped connection stays dropped; the fan-out reaches EXACTLY the survivors", async () => {
  // Extends hibernation-at-scale's "eviction preserves the fleet" with a provider dropping one of
  // its own capabilities before the wake. PINS: the drop is honored across the eviction (the
  // dropped client's hibernatable pager socket is gone, not resurrected) and the post-wake fan-out
  // reaches every survivor and only the survivors.
  const ctx = "prj_scale_drop";
  const K = 6;
  const clientItx = await (await openSession()).authenticate().projects.get(ctx);
  for (let i = 0; i < K; i++) await clientItx.provide(`itx.k${i}`, new Echo(i));
  const caller = await (await openSession()).authenticate().projects.get(ctx);

  // The drop must come from the PROVIDER'S OWN session: `itx.revoke(path)` pops the mount on the
  // DO and closes THIS session's parked stub under the path. A revoke from `caller` would pop
  // the mount only — the DO never touches a transport on revoke, and `caller` parked nothing
  // under `itx.k3`, so its stub would stay in the census (answering nothing, mount gone).
  await clientItx.revoke("itx.k3");
  const dropped = await untilStubs(ctx, K - 1); // the relay's close lands at the DO a beat later
  expect(dropped.stubs).toBe(K - 1);

  const q = await quiesce(ctx);
  expect(q.pagedIn).toBe(0); // the quiesce disposed every paged-in stub (evict precondition)
  await evictDurableObject(stub(ctx));
  const evicted = await stateOf(ctx);
  expect(evicted.stubs).toBe(K - 1); // survivors' hibernatable sockets rode the eviction; k3 stayed gone

  // The mount at itx.k3 is gone from the table (revoke popped it), and the survivors' mounts
  // stayed — the table is data, untouched by the eviction.
  const snap = (await caller.invokeCapability("itx.facets.get('capability-table').snapshot()")) as {
    state: { mounts: { path: string[] }[] };
  };
  const mounted = snap.state.mounts.map((m) => m.path.join("."));
  expect(mounted).not.toContain("itx.k3");
  for (let i = 0; i < K; i++) if (i !== 3) expect(mounted).toContain(`itx.k${i}`);
  // fan-out = PRESENCE (`itx.rpcStubs.list()` — the keys whose hibernated pager sockets rode
  // the eviction; k3's did not) + map over the paths (no built-in `each`); the caller owns the
  // allSettled.
  const paths = (await caller.invokeCapability("itx.rpcStubs.list()")) as string[];
  expect(paths).toHaveLength(K - 1);
  expect(paths).not.toContain("itx.k3");
  const answers = (
    await Promise.all(
      paths.map((path) => caller.invokeCapability(`${path}.echo('hi')`).catch(() => undefined)),
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
  // The kernel cursor lane rides THIS DO's alarm (facets have none — workerd#6810 — which is why the
  // forwarder became kernel code). PINS: a delivery that throws leaves a cursor row on the ladder
  // (attempt ≥ 1, a nextAttemptAtMs, NOT halted — one failure is far from 15); when the alarm fires
  // past that instant, `pumpAll` re-delivers the SAME batch from the kv cursor, the awaited call
  // acks it, and the row reads attempt 0 with its confirmedOffset at the head.
  const ctx = "prj_q_cursorpump";
  const s = stub(ctx);
  await s.invoke(["itx", "kv", ["put", "flakysrc", FLAKY_SRC]]);
  await s.invoke(["itx", "kv", ["put", "flaky-mode", "fail"]]);
  await s.configureSubscription({
    name: "flaky",
    target: ["itx", ["load", "itx.kv.get('flakysrc')"], ["getEntrypoint"], "processEventBatch"],
    consumes: ["mark"],
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

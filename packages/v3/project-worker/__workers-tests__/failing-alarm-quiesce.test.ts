// __workers-tests__/failing-alarm-quiesce.test.ts — THE 60s-QUIESCE / EVICTION BUG HUNT, inside
// workerd (the pool-workers lane — the ONLY lane that can force the quiesce alarm
// (runDurableObjectAlarm) and a graceful teardown (evictDurableObject) deterministically).
//
// Target surface: IterateContextDurableObject.alarm()/#noteActivity/#alarmArmer/resurrection pass/
// #facetWorkInFlight/quiesce-abort (src/stream-durable-object.ts), the subscription-forwarder
// (src/subscription-forwarder-processor.ts), and the rpc-stub directory
// (src/rpc-stub-directory.ts).
//
// WHAT THIS FILE PINS (all runnable here) vs WHAT IT CANNOT (test.todo, with the VERIFIED
// blocker named): the deferred DEFECTS.md quiesce items split by whether their manifestation
// needs a facet the pool lane can materialize.
//
//   • BUILT-IN facets (subscription-forwarder, tally) DO NOT materialize in vitest-pool-workers:
//     #facet() does `ctx.facets.get(name, () => ({ class: ctx.exports.ProcessorFacet }))`, and
//     the pool's `ctx.exports` hands back an entrypoint proxy, not a DurableObjectClass — workerd
//     rejects it: TypeError "Incorrect type for the 'class' field on 'StartupOptions'". VERIFIED
//     by running (an absent-target subscribe → enableProcessor('subscription-forwarder') throws
//     at materialization). The harness lane (__tests__) runs the forwarder fine but cannot force
//     the 60s alarm. So every forwarder-specific quiesce defect is test.todo here.
//   • USERSPACE (Worker-Loader) facets DO materialize in the pool lane (the loader accepts the
//     allow_irrevocable_stub_storage flag — DEFECTS.md infra note). Every facet-lifecycle
//     regression below rides a userspace `counter` processor for exactly this reason.
//   • CONNECTIONS (hibernatable stub pagers) work fully here — see hibernation-at-scale.test.ts.
//
// A KEY MEASURED PROPERTY, load-bearing for two of the todos: a materialized/driving facet PINS
// the DO non-hibernatable (workerd#6800). evictDurableObject on such a DO times out after 30s
// ("still has active references") — production-faithful, and the reason the quiesce alarm exists.
// You must quiesce (abort the facets) BEFORE you can evict — the exact production sequence.

import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { afterAll, expect, test, vi } from "vitest";
import { canonicalName } from "../src/core/durable-object-names.ts";
import type { IterateContextDurableObject } from "../src/stream-durable-object.ts";

const stub = (ctx: string) =>
  (
    env as unknown as { CONTEXT: DurableObjectNamespace<IterateContextDurableObject> }
  ).CONTEXT.getByName(canonicalName(ctx));

/** A tiny userspace processor: counts every durable event. Loaded through the Worker Loader
 *  (the only facet kind the pool lane can materialize — see the header). */
const COUNTER_SRC = /* js */ `
import { StreamProcessor } from "./processor.js";
export default class Counter extends StreamProcessor {
  contract = {
    slug: "counter", version: "1", description: "counts durable events",
    consumes: ["*"], emits: [], initialState: () => ({ n: 0 }),
  };
  reduce({ state }) { return { n: state.n + 1 }; }
}
`;

type FacetSnap = { offset: number; state: { n: number } };
const snapCounter = (ctx: string, slug = "counter") =>
  stub(ctx).invoke(["itx", "facets", ["get", slug], ["snapshot"]]) as Promise<FacetSnap>;
// The number of DURABLE events (read is durable-only). Counter consumes "*", so its `n` equals this.
// (We no longer assert `n === offset`: under default-on live state, Counter emits a live-state
// ephemeral per event, and those consume offsets — so a durable event's offset now exceeds the count
// of durable events before it. The exact-once invariant is `n === durable-event-count`.)
const durableCount = async (ctx: string): Promise<number> =>
  ((await stub(ctx).invoke(["itx", ["read", 0, 500]])) as { events: unknown[] }).events.length;

async function enableCounter(ctx: string, slug = "counter"): Promise<void> {
  const s = stub(ctx);
  await s.invoke(["itx", "kv", ["put", "procsrc", COUNTER_SRC]]);
  await s.enableProcessor(slug, { source: "itx.kv.get('procsrc')", className: "default" });
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
async function openSession(ctx: string): Promise<any> {
  const res = await SELF.fetch(`https://test.local/api?ctx=${ctx}`, {
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

test("QUIESCE PRESERVES CURSOR+STATE: abort an idle facet, re-materialize, snapshot is unchanged (configure-at-materialization)", async () => {
  // Item (2). PINS the Phase-A fix (DEFECTS 29/30/32/45): a facet aborted by the idle quiesce and
  // re-materialized by the next call reconfigures IDEMPOTENTLY from the mount alone and keeps its
  // durable cursor + reduced state. Were reconfigure broken (the old half-enabled-provide door),
  // the post-quiesce snapshot would throw "not configured" or reset to n=0.
  const ctx = "prj_q_cursor";
  const s = stub(ctx);
  await enableCounter(ctx);
  await s.append({ type: "a/1" }, { type: "a/2" }, { type: "a/3" });
  await new Promise((r) => setTimeout(r, 150));
  const before = await snapCounter(ctx);
  expect(before.state.n).toBe(await durableCount(ctx)); // every durable event counted, no double/no loss

  // Idle 61s → the quiesce aborts the facet (its cursor is durable in its OWN storage).
  await quiesce(ctx);

  // The next snapshot re-materializes the facet: it must reconfigure and resume its cursor.
  const after = await snapCounter(ctx);
  // Cursor NOT reset/regressed across the abort. It may ADVANCE past `before.offset`: the cold
  // re-catch-up reads to scannedThroughOffset (the raw head), which grew as Counter's own trailing
  // live-state ephemerals landed after the last push — a head-tracking advance, not a replay. The
  // exact-once invariant is the reduced STATE (below), not the offset number.
  expect(after.offset).toBeGreaterThanOrEqual(before.offset);
  expect(after.state.n).toBe(before.state.n); // reduced state preserved
  expect(after.state.n).toBe(await durableCount(ctx)); // still exact (idempotent re-drive, no replay effects)
});

test("QUIESCE THEN EVICT THEN WAKE: the facet re-drives from its durable cursor exactly once (no double, no loss)", async () => {
  // Item (4). True mid-drive eviction is UNFORCEABLE (a driving facet pins the DO; evict times out
  // — see the header). The forceable, production-shaped path is quiesce (abort) → evict (fresh
  // parent incarnation) → wake. PINS: on wake the facet gap-repairs from its own durable cursor —
  // the reduced count equals the number of durable events, never more (no double durable effect)
  // and never fewer (no lost catch-up). Events appended in the quiescent gap are picked up too.
  const ctx = "prj_q_evict";
  const s = stub(ctx);
  await enableCounter(ctx);
  // Commit a run of durable events and let the facet drive them fully (so no drive is in flight —
  // an in-flight drive keeps facetWorkInFlight > 0, the quiesce is skipped, the facet stays
  // materialized, and evict then times out on the #6800 pin).
  await s.append({ type: "b/1" }, { type: "b/2" }, { type: "b/3" }, { type: "b/4" });
  await new Promise((r) => setTimeout(r, 300));

  // Quiesce (aborts the idle facet → un-pins the DO), then a REAL graceful eviction: storage kept,
  // in-memory torn down, a fresh parent incarnation on the next call (resets #pushedThroughOffset,
  // forcing a genuine cold catch-up from the log — the property under test).
  await quiesce(ctx);
  await evictDurableObject(s);

  const after = await snapCounter(ctx); // wakes a fresh incarnation → catch-up from the durable cursor
  expect(after.state.n).toBeGreaterThanOrEqual(5); // enable-provide (1) + b/1..b/4 (4) durable events
  expect(after.state.n).toBe(await durableCount(ctx)); // EXACTLY one reduce per durable event across the eviction
});

test("DISABLE deletes the facet's storage; RE-ENABLE rebuilds from the log (no stale cursor, no skipped events)", async () => {
  // Companion to the deferred "disableProcessor abort()-fallback keeps storage" TODO. In THIS lane
  // ctx.facets.delete IS available (verified), so disableProcessor takes the delete branch and the
  // facet's storage is dropped. PINS the correct consequence: a re-enable rebuilds the reduce from
  // the durable log — including events appended while the processor was disabled — with no stale
  // cursor causing a silent skip (n === offset). (The abort()-fallback-keeps-storage branch is
  // DEAD here; forcing it needs a workerd without facets.delete — see the todo below.)
  const ctx = "prj_disable";
  const s = stub(ctx);
  await enableCounter(ctx);
  await s.append({ type: "c/1" }, { type: "c/2" });
  await new Promise((r) => setTimeout(r, 150));

  await s.disableProcessor("counter");
  await s.append({ type: "gap/1" }, { type: "gap/2" }); // committed while DISABLED
  await new Promise((r) => setTimeout(r, 100));

  await enableCounter(ctx); // re-enable the same slug
  await new Promise((r) => setTimeout(r, 150));
  const after = await snapCounter(ctx);
  expect(after.state.n).toBe(await durableCount(ctx)); // rebuilt from the whole log — no stale-cursor skip
});

test("PAGE-IN RACES THE QUIESCE ALARM: a connection invoke fired concurrently with the alarm still answers", async () => {
  // Item (6). A quiesce disposes RETAINED stubs (#retained) but never touches a PENDING page
  // (#pagesPending), and the invoke's own #noteActivity keeps the actor warm. PINS: an invoke that
  // pages a stub in while the 60s alarm fires resolves with the right per-client answer (the wake's
  // borrowed stub is not disposed out from under it).
  const ctx = "prj_pagein";
  const clientItx = await (await openSession(ctx)).get();
  for (let i = 0; i < 4; i++) await clientItx.provide(`itx.p${i}`, new Echo(i));
  const caller = await (await openSession(ctx)).get();

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
  // Item (5). Extends hibernation-at-scale's "eviction preserves the fleet" with a provider
  // dropping one of its own capabilities before the wake. PINS: the drop is honored across the
  // eviction (the dropped client's hibernatable pager socket is gone, not resurrected) and the
  // post-wake fan-out reaches every survivor and only the survivors. (A subscription RESUME
  // across the quiesce needs the forwarder facet — test.todo below.)
  const ctx = "prj_scale_drop";
  const K = 6;
  const clientItx = await (await openSession(ctx)).get();
  for (let i = 0; i < K; i++) await clientItx.provide(`itx.k${i}`, new Echo(i));
  const caller = await (await openSession(ctx)).get();

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

// The former UNFORCEABLE-HERE test.todo block is gone — its items were either stale (the
// #lastActivityMs capture-restore was already removed) or FIXED at the root (alarm() now AWAITS the
// forwarder pump before the quiesce check, which also preserves the pump's future-retry re-arm
// across hibernation; disableProcessor calls ctx.facets.delete unconditionally — the storage-keeping
// abort() fallback was dead code on every runtime).

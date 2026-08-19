// __workers-tests__/failing-alarm-quiesce.test.ts — THE 60s-QUIESCE / EVICTION BUG HUNT, inside
// workerd (the pool-workers lane — the ONLY lane that can force the quiesce alarm
// (runDurableObjectAlarm) and a graceful teardown (evictDurableObject) deterministically).
//
// Target surface: StreamDurableObject.alarm()/#noteActivity/#alarmArmer/resurrection pass/
// #facetWorkInFlight/quiesce-abort (src/stream-durable-object.ts), the subscription-forwarder
// (src/subscription-forwarder-processor.ts), and the connection directory
// (src/itx-connection-directory.ts).
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
import type { StreamDurableObject } from "../src/stream-durable-object.ts";

const ns = () =>
  (env as unknown as { CONTEXT: DurableObjectNamespace<StreamDurableObject> }).CONTEXT;
const stub = (ctx: string) => ns().getByName(canonicalName(ctx));

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

async function enableCounter(ctx: string, slug = "counter"): Promise<void> {
  const s = stub(ctx);
  await s.invokeCapability("itx.kv.put", ["procsrc", COUNTER_SRC]);
  await s.enableProcessor(slug, { source: "itx.kv.get('procsrc')", export: "default" });
}

const stateOf = (ctx: string): Promise<Record<string, any>> =>
  runInDurableObject(stub(ctx), async (inst) =>
    (
      await (inst as unknown as { fetch(r: Request): Promise<Response> }).fetch(
        new Request(`https://x/state?ctx=${ctx}`),
      )
    ).json(),
  );

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

// ── connections plumbing (for items 5 + 6) — the hibernation-at-scale pattern, minimized ──

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
  expect(before.state.n).toBe(before.offset); // every durable event counted, no double/no loss

  // Idle 61s → the quiesce aborts the facet (its cursor is durable in its OWN storage).
  await quiesce(ctx);

  // The next snapshot re-materializes the facet: it must reconfigure and resume its cursor.
  const after = await snapCounter(ctx);
  expect(after.offset).toBe(before.offset); // cursor preserved across the abort
  expect(after.state.n).toBe(before.state.n); // reduced state preserved
  expect(after.state.n).toBe(after.offset); // still exact (idempotent re-drive, no replay effects)
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
  expect(after.offset).toBeGreaterThanOrEqual(5); // enable-provide (1) + b/1..b/4 (2..5)
  expect(after.state.n).toBe(after.offset); // EXACTLY one reduce per durable event across the eviction
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
  expect(after.state.n).toBe(after.offset); // rebuilt from the whole log — no stale-cursor skip
});

test("PAGE-IN RACES THE QUIESCE ALARM: a connection invoke fired concurrently with the alarm still answers", async () => {
  // Item (6). A quiesce disposes RETAINED stubs (#retained) but never touches a PENDING page
  // (#pagesPending), and the invoke's own #noteActivity keeps the actor warm. PINS: an invoke that
  // pages a stub in while the 60s alarm fires resolves with the right per-client answer (the wake's
  // borrowed stub is not disposed out from under it).
  const ctx = "prj_pagein";
  const client = await openSession(ctx);
  for (let i = 0; i < 4; i++)
    await client.connect({ connectionKey: `p${i}`, capabilities: new Echo(i) });
  const caller = await (await openSession(ctx)).get();

  vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
  let raced: unknown;
  try {
    vi.setSystemTime(Date.now() + 61_000);
    const alarmP = runDurableObjectAlarm(stub(ctx));
    const invokeP = caller.invoke("itx.connections.get('p2').echo('race')");
    const [, inv] = await Promise.all([alarmP, invokeP]);
    raced = inv;
  } finally {
    vi.useRealTimers();
  }
  expect(raced).toBe("echo-2:race");
});

test("SCALE DROP + QUIESCE + EVICT + WAKE: a dropped connection stays dropped; the fan-out reaches EXACTLY the survivors", async () => {
  // Item (5). Extends hibernation-at-scale's "eviction preserves the fleet" with an unsubscribe
  // (connection kick) racing the wake. PINS: the drop is honored across the eviction (the kicked
  // client's hibernatable pager socket is gone, not resurrected) and the post-wake fan-out reaches
  // every survivor and only the survivors. (A subscription RESUME across the quiesce needs the
  // forwarder facet — test.todo below.)
  const ctx = "prj_scale_drop";
  const K = 6;
  const client = await openSession(ctx);
  for (let i = 0; i < K; i++)
    await client.connect({ connectionKey: `k${i}`, capabilities: new Echo(i) });
  const caller = await (await openSession(ctx)).get();

  await caller.invoke("itx.connections.close('k3')"); // drop one
  const dropped = await stateOf(ctx);
  expect(dropped.stubs).toBe(K - 1);

  const q = await quiesce(ctx);
  expect(q.pagedIn).toBe(0); // the quiesce disposed every paged-in stub (evict precondition)
  await evictDurableObject(stub(ctx));
  const evicted = await stateOf(ctx);
  expect(evicted.stubs).toBe(K - 1); // survivors' hibernatable sockets rode the eviction; k3 stayed gone

  const answers = (await caller.invoke("itx.connections.each('echo', 'hi')")) as string[];
  const got = new Set(answers);
  expect(answers.length).toBe(K - 1);
  for (let i = 0; i < K; i++)
    i === 3 ? expect(got.has("echo-3:hi")).toBe(false) : expect(got.has(`echo-${i}:hi`)).toBe(true);
});

// ─────────────── UNFORCEABLE HERE (test.todo) — the deferred DEFECTS.md quiesce items ───────────────

// Item (1a). CODE-VERIFIED DEFECT, unforceable in this lane.
//   BUG: alarm()'s resurrection pass captures `idleSince = #lastActivityMs` before its
//        `await Promise.allSettled(... facet.snapshot() ...)` and then unconditionally restores
//        `#lastActivityMs = idleSince` AFTER the await (stream-durable-object.ts ~L630-638). Since
//        #facet() no longer notes activity, the ONLY thing that can move #lastActivityMs during
//        that await is GENUINE concurrent live traffic (append/invoke → #noteActivity). The blanket
//        restore ERASES that fresh timestamp.
//   EXPECTED: live traffic arriving during the resurrection keeps the DO warm — the quiesce is
//        skipped (or at least the re-arm reflects the fresh activity).
//   ACTUAL (by inspection): the clobber makes the quiesce check read the stale idleSince →
//        wrongful facet abort; and if the fresh append's drive is still in flight (facetWorkInFlight
//        > 0) the else-branch arms `armNoLaterThan(idleSince + 60_000)`, a time in the PAST on a
//        fresh incarnation (idleSince≈0) → an immediate-fire alarm loop.
//   BLOCKER: forcing it needs a WIDE resurrection await overlapping a concurrent append. The window
//        is only wide when a facet is far BEHIND on a fresh incarnation — reachable solely by
//        evicting mid-drive, which the workerd#6800 facet pin prevents (evictDurableObject times out
//        after 30s, MEASURED). With the window collapsed (a fresh-incarnation facet catches up in one
//        read), an injected append lands AFTER the await (MEASURED: +0ms, never inside it), so the
//        interleave can't be made reliable for test.fails semantics.
//   FIX: don't blanket-restore. Snapshot #lastActivityMs into a local, and after the await set
//        `#lastActivityMs = Math.max(localBefore, #lastActivityMs)` (keep any fresher value), or
//        gate the restore on "no #noteActivity happened since idleSince".
test.todo(
  "resurrection pass clobbers #lastActivityMs after its await (wrongful quiesce / past-armed alarm on concurrent traffic) — needs a wide resurrection window that only an evict-mid-drive gives, blocked by the #6800 facet pin",
);

// Item (1b). CODE-VERIFIED DEFECT, unforceable in this lane.
//   BUG: the quiesce gate is `... && this.#facetWorkInFlight === 0`, but #facetWorkInFlight is
//        incremented/decremented ONLY around append-driven processEventBatch calls (append's drive
//        loop). The alarm's OWN fire-and-forget forwarder pump — `void
//        #facet(SUBSCRIPTION_FORWARDER_SLUG).then(f => f.pumpSubscriptionDeliveries())` at
//        stream-durable-object.ts ~L611 — is NOT counted. So the same alarm can, a few lines later,
//        abort `proc:subscription-forwarder` while that pump is mid-delivery (a 20s watchdog'd call,
//        or a retry-arming leg, in flight).
//   EXPECTED: the quiesce never aborts a facet the same alarm just handed work to.
//   ACTUAL (by inspection): a pump aborted before it reaches armRetry/onDeliveryFailure loses that
//        leg; combined with (3) the pending retry is dropped.
//   BLOCKER: the subscription-forwarder is a BUILT-IN facet; ctx.exports.ProcessorFacet is rejected
//        as a DurableObjectClass under vitest-pool-workers (TypeError "Incorrect type for the
//        'class' field on 'StartupOptions'", VERIFIED). It cannot materialize here; the harness lane
//        runs it but cannot force the 60s alarm.
//   FIX: count the alarm's forwarder pump in an in-flight guard (or await it before the quiesce
//        gate), so the quiesce respects it like an append drive.
test.todo(
  "#facetWorkInFlight ignores the alarm's own forwarder pump → quiesce can abort the subscription-forwarder mid-pump — blocked: built-in ProcessorFacet won't materialize in vitest-pool-workers (ctx.exports rejected)",
);

// Item (3). CODE-VERIFIED DEFECT, unforceable in this lane (same forwarder blocker as 1b).
//   BUG: the quiesce branch of alarm() does NOT re-arm the durable alarm. A forwarder retry armed
//        for +30min is invisible while a nearer +60s quiesce alarm owns the single durable slot
//        (StreamAlarmArmer.armNoLaterThan only ever moves EARLIER). The design's stated safety net
//        ("every alarm() pass re-derives its obligations and re-arms" — the alarm-armer comment) is
//        the forwarder pump at L611 re-deriving nextAttemptAtMs — the very pump (1b) lets the same
//        quiesce abort. If the abort wins the race, nothing re-arms the +30min retry: the delivery
//        stalls until an unrelated append happens to arm an alarm.
//   EXPECTED: a delivery scheduled for +30min still fires after an intervening quiesce.
//   ACTUAL (by inspection): retry lost when the quiesce aborts the re-deriving pump.
//   BLOCKER: same as 1b — the forwarder cannot materialize in the pool lane.
//   FIX: after quiescing, re-arm the earliest still-pending facet obligation (or have the quiesce
//        branch call armNoLaterThan for any known retry), so re-derivation does not depend on a
//        pump the same alarm may have aborted.
test.todo(
  "subscription-forwarder retry armed for +30min is lost across a quiesce (quiesce branch never re-arms; re-derivation rides the abortable pump) — blocked: forwarder won't materialize in vitest-pool-workers",
);

// Companion: the disableProcessor abort()-fallback-keeps-storage branch (DEFECTS.md deferred TODO).
//   In this lane ctx.facets.delete EXISTS (VERIFIED), so disableProcessor never takes the
//   `abort(...)` fallback that would orphan the facet's storage. Forcing the leak needs a workerd
//   build/binding where ctx.facets exposes abort but NOT delete — not reachable under
//   vitest-pool-workers. (The delete-path correctness is pinned by the DISABLE regression above.)
test.todo(
  "disableProcessor abort()-fallback keeps facet storage (orphaned cursor/state) — unforceable: ctx.facets.delete IS available in vitest-pool-workers, so the fallback branch is dead here",
);

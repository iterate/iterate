/// <reference types="node" />
// subscription-delivery.test.ts — the one delivery loop (push, cursor and fan-out rows) in node over
// the real Stream, `evaluateItxExpression` standing in for the context's dispatch. Out of scope: the
// memory budget (test/vitest/os/memory-budget.test.ts) and real fan-out targets (test/vitest/os-workers/fan-out-targets).

import { AsyncLocalStorage } from "node:async_hooks";
import { expect, onTestFinished, test, vi } from "vitest";
import { print, type ItxExpression } from "iterate/expression";
import { codedError } from "iterate/lib";
import type { StreamEvent, StreamEventInput, ScannedRange } from "iterate/stream/processor";
import { nodeSqliteDurableObjectStorage } from "iterate/stream/test-support";
import { causeOfDelivery, type Cause } from "../cause.ts";
import { AlarmCoordinator } from "../alarm-coordinator.ts";
import { registerPipelinedRpcBrand, FacetHandle } from "../context/dispatch.ts";
import { SNAPSHOT_TTL_MS } from "../context/rule-snapshots.ts";
import {
  RECENT_EPHEMERALS_BUDGET_CHARS,
  Stream,
  type DurableObjectStorageSlice,
  type Wake,
} from "./stream.ts";
import { SubscriptionDelivery } from "./subscription-delivery.ts";
import { normalizeControlEvent } from "./core-processor.ts";

const MiB = 1024 * 1024;
/** The cause a rig's delivery runs under, as the DO's caller store holds it. */
const causes = new AsyncLocalStorage<Cause>();

// ── the pending push is bounded ──

test("pending-push bound, control: under the budget, commits behind an in-flight delivery fold into ONE push, in order, ranging from the first commit", async () => {
  const rig = stuckFacetRig();
  await nextMacrotask(); // the materialization (catchUpFromLog) parks — the chain's head
  rig.stream.append({ type: "noise", ephemeral: true }); // not consumed: a gap between the row's configuration and its first blob
  const offsets = rig.commitBlobs(4);
  await rig.release();
  expect(rig.pushes).toHaveLength(1);
  expect(blobIndexes(rig.pushes[0])).toEqual([0, 1, 2, 3]);
  // A row's first push ranges from its first commit's afterOffset (the span since the row's
  // configuration — here the ephemeral it does not consume — is the facet's own gap repair to read).
  expect(rig.pushes[0]).toMatchObject({ range: { after: offsets[0] - 1, through: offsets[3] } });
  expect(rig.pushes[0].range.after).toBeGreaterThan(rig.configuredAtOffset);
});

test("pending-push bound: over the budget, the OLDEST events are dropped and the push's `after` moves up to the last dropped offset", async () => {
  const rig = stuckFacetRig();
  await nextMacrotask();
  const offsets = rig.commitBlobs(12); // 12 × ~1 MiB behind a stuck facet, an 8 MiB budget
  await rig.release();
  expect(rig.pushes).toHaveLength(1);
  const delivered = blobIndexes(rig.pushes[0]);
  expect(delivered.length).toBeGreaterThan(0);
  expect(delivered.length).toBeLessThan(12); // some were dropped …
  expect(delivered[delivered.length - 1]).toBe(11); // … never the newest
  expect(delivered).toEqual([...delivered].sort((a, b) => a - b)); // in order
  // `(after, through]` is what the facet received; `(cursor, after]` — the dropped span — is what
  // its gap repair reads from the log.
  expect(rig.pushes[0]).toMatchObject({
    range: { after: offsets[delivered[0] - 1], through: offsets[11] },
  });
});

// ── a read of a pushed facet waits for the deliveries already queued for it ──

test("deliveriesQueuedFor: a read settles after the row's parked materialization AND the push queued behind it have reached the facet — at once for a facet no row pushes", async () => {
  const rig = stuckFacetRig();
  await nextMacrotask(); // the materialization (catchUpFromLog) parks — the chain's head
  rig.commitBlobs(1); // its push queues behind it
  void rig.delivery.deliveriesQueuedFor("slow").then(() => rig.facetMethods.push("read"));
  void rig.delivery.deliveriesQueuedFor("unpushed").then(() => rig.facetMethods.push("unpushed"));
  await drainDeliveries();
  expect(rig).toMatchObject({ facetMethods: ["catchUpFromLog", "unpushed"] });
  await rig.release();
  expect(rig).toMatchObject({
    facetMethods: ["catchUpFromLog", "unpushed", "processEventBatch", "read"],
  });
  // Nothing queued any more: the next read goes straight through.
  void rig.delivery.deliveriesQueuedFor("slow").then(() => rig.facetMethods.push("next read"));
  await nextMacrotask();
  expect(rig.facetMethods.at(-1)).toBe("next read");
});

// ── an operator's resume wakes a halted FACET row now — the facet catches up from the log itself ──

test.for([
  { incarnation: "the incarnation that halted it", evicted: false },
  { incarnation: "a FRESH incarnation (evicted between the halt and the resume)", evicted: true },
])(
  "an operator's resume wakes a halted FACET row on $incarnation: ONE catchUpFromLog, no cursor",
  async ({ evicted }) => {
    const first = stuckFacetRig();
    await first.release(); // materialized
    first.stream.append({
      type: "events.iterate.com/itx/subscription-delivery-halted",
      payload: { name: "slow", afterOffset: first.configuredAtOffset, attempts: 1, error: "halt" },
    });
    first.commitBlobs(1); // lands on a halted row: undelivered until the operator resumes it
    await nextMacrotask();
    const rig = evicted ? stuckFacetRig(first) : first;
    await nextMacrotask();
    if (evicted) expect(rig).toMatchObject({ facetMethods: [] }); // the wake does not wake a halted row
    const before = rig.facetMethods.length;
    resume(rig, "slow");
    await rig.release();
    expect(rig.facetMethods.slice(before)).toEqual(["catchUpFromLog"]);
    expect(rig.stream.coreReducedState.subscriptions.slow.halted).toBeUndefined();
    expect(rig.delivery.cursor("slow")).toBeUndefined(); // a facet owns its progress — no cursor
  },
);

// ── halt once, for the right row ──

test("halt once: a push queued behind an in-flight delivery is NOT delivered to a row that halted meanwhile", async () => {
  const rig = stuckFacetRig();
  await nextMacrotask(); // the materialization (catchUpFromLog) parks — the chain's head
  rig.commitBlobs(1); // queued behind it
  rig.stream.append({
    type: "events.iterate.com/itx/subscription-delivery-halted",
    payload: { name: "slow", afterOffset: rig.configuredAtOffset, attempts: 1, error: "halt" },
  });
  await rig.release();
  // the queued push never reached the facet
  expect(rig).toMatchObject({ facetMethods: ["catchUpFromLog"], pushes: [] });
});

test("halt once: a facet catch-up refused for good (REDUCE_CHECKPOINT_TOO_LARGE, a latched checkpoint) HALTS the row at once, ONE fact; on a resume, the catch-up and the resumed event's push see the same refusal and append ONE more fact, not two", async () => {
  const latched = codedError("REDUCE_CHECKPOINT_TOO_LARGE", "checkpoint latched");
  const facetMethods: string[] = [];
  const rig = incarnation(
    () =>
      new FacetHandle((steps) => {
        const [call] = steps;
        facetMethods.push(Array.isArray(call) ? call[0] : call);
        return Promise.reject(latched);
      }),
  );
  // `consumes` absent = EVERY durable event: the configure and the resume are themselves pushed,
  // racing the catch-up each one triggers.
  configure(rig, { name: "poison", target: facetTarget("poison") });
  await drainDeliveries();
  expect(rig.stream.coreReducedState.subscriptions.poison.halted).toMatchObject({
    attempts: 1,
    error: "checkpoint latched",
  });
  expect(haltFactsFor(rig.stream, "poison")).toHaveLength(1);
  expect(facetMethods).toEqual(["catchUpFromLog"]); // the configure's own push found the row halted
  resume(rig, "poison");
  await drainDeliveries();
  expect(facetMethods.slice(1).sort()).toEqual(["catchUpFromLog", "processEventBatch"]); // both refused …
  expect(haltFactsFor(rig.stream, "poison")).toHaveLength(2); // … one fact between them
  expect(rig.stream.coreReducedState.subscriptions.poison.halted).toBeDefined();
});

test("halt once: a push answered with a PIPELINED refusal (a sibling hop's FORBIDDEN) is settled before it is released — the row halts, the batch is never acked as delivered", async () => {
  // On workerd a call on a sibling context answers with a branded promise the step walk hands back
  // UNAWAITED (context/dispatch.ts). Unless the delivery loop settles it, the branded rejection is
  // released unseen and the push counted as delivered. A brand registered here stands in for it.
  class PipelinedAnswer<T> extends Promise<T> {}
  registerPipelinedRpcBrand(PipelinedAnswer);
  const facetMethods: string[] = [];
  const rig = incarnation(
    () =>
      new FacetHandle((steps) => {
        const [call] = steps;
        facetMethods.push(Array.isArray(call) ? call[0] : call);
        if (Array.isArray(call) && call[0] === "processEventBatch")
          return PipelinedAnswer.reject(
            codedError("FORBIDDEN", "a global context is reached by identity, never by path"),
          );
        return Promise.resolve();
      }),
  );
  configure(rig, { name: "laundered", target: facetTarget("laundered") });
  await drainDeliveries();
  expect(facetMethods).toEqual(["catchUpFromLog", "processEventBatch"]);
  expect(rig.stream.coreReducedState.subscriptions.laundered.halted).toMatchObject({
    attempts: 1,
    error: "a global context is reached by identity, never by path",
  });
  expect(haltFactsFor(rig.stream, "laundered")).toHaveLength(1);
});

test("halt once: a refusal of a call made for a row since REPLACED halts nothing — the replacement is not its predecessor", async () => {
  let refuseInFlightPush!: (error: unknown) => void;
  const rig = incarnation(
    () =>
      new FacetHandle((steps) => {
        const [call] = steps;
        return Array.isArray(call) && call[0] === "processEventBatch"
          ? new Promise((_, reject) => (refuseInFlightPush = reject))
          : Promise.resolve();
      }),
  );
  const swap = () =>
    configure(rig, { name: "swap", target: facetTarget("swap"), consumes: ["blob"] })[0].offset;
  swap();
  await drainDeliveries();
  rig.stream.append({ type: "blob" });
  await drainDeliveries(); // the push is in flight, parked
  const replacement = swap(); // REPLACES the row (a new identity) under the parked push
  await drainDeliveries();
  refuseInFlightPush(codedError("PERMANENT_FAILURE", "poison"));
  await drainDeliveries();
  expect(haltFactsFor(rig.stream, "swap")).toEqual([]);
  expect(rig.stream.coreReducedState.subscriptions.swap).toMatchObject({
    configuredAtOffset: replacement,
  });
  expect(rig.stream.coreReducedState.subscriptions.swap.halted).toBeUndefined();
});

// ── subscribe({ afterOffset }) — cursor delivery starts where the row asked ──

test("a row configured with afterOffset: 0 after three durable events delivers those three NOW (its configure is its wake); a row without it starts from its configure offset; both take what lands next", async () => {
  const history: number[][] = [];
  const now: number[][] = [];
  const rig = incarnation((printed) =>
    printed === "itx.history"
      ? pushSink(history)
      : printed === "itx.now"
        ? pushSink(now)
        : undefined,
  );
  for (const n of [1, 2, 3]) rig.stream.append({ type: "demo/ping", payload: { n } });
  configure(rig, { name: "now", target: "itx.now.push", consumes: ["demo/ping"] });
  configure(rig, {
    name: "history",
    target: "itx.history.push",
    consumes: ["demo/ping"],
    afterOffset: 0,
  });
  await drainDeliveries();
  expect({ history, now }).toEqual({ history: [[1, 2, 3]], now: [] });
  expect(rig.delivery.cursor("history")?.confirmedOffset).toBe(rig.stream.highestDurableOffset());
  rig.stream.append({ type: "demo/ping", payload: { n: 4 } });
  await drainDeliveries();
  expect({ history, now }).toEqual({ history: [[1, 2, 3], [4]], now: [[4]] });
});

// ── a wake reaches every "*" row and leaves nothing armed ──

test('the wake record is delivered to a "*" cursor row like any durable event; acked, the row claims nothing and the alarm is deleted — a wake makes no loop', async () => {
  const delivered: string[] = [];
  const sink = {
    push: (events: { type: string }[]) => void delivered.push(...events.map((e) => e.type)),
  };
  const first = incarnation((printed) => (printed === "itx.sink" ? sink : undefined));
  configure(first, { name: "config", target: "itx.sink.push", consumes: ["*"] });
  first.stream.append({ type: "demo/ping", payload: {} });
  await drainDeliveries();
  expect(delivered).toEqual(["demo/ping"]); // the row works; the birth's created/woken were never its

  // THE EVICTION AND THE WAKE: a fresh incarnation over the same storage appends its woken — one
  // durable event the "*" row consumes like any other.
  const second = incarnation(
    (printed) => (printed === "itx.sink" ? sink : undefined),
    first.storage,
  );
  await drainDeliveries();
  expect(delivered).toEqual(["demo/ping", "events.iterate.com/itx/woken"]);
  // Acked: nothing is owed and nothing is armed — the woken's commit claimed the alarm once (the
  // row was behind the durable mark), the ack deleted it once. This incarnation can idle out.
  expect(second.delivery.deadlines()).toEqual([]);
  expect(second.alarms).toHaveLength(1);
  expect(second).toMatchObject({ deletes: [1] });
});

test("a row that NAMES itx/woken is the opt-in and does receive it", async () => {
  const delivered: string[] = [];
  const sink = {
    push: (events: { type: string }[]) => void delivered.push(...events.map((e) => e.type)),
  };
  const first = incarnation((printed) => (printed === "itx.sink" ? sink : undefined));
  configure(first, { name: "wakes", target: "itx.sink.push", consumes: [WOKEN] });
  incarnation((printed) => (printed === "itx.sink" ? sink : undefined), first.storage);
  await drainDeliveries();
  expect(delivered).toEqual(["events.iterate.com/itx/woken"]);
});

// ── cursor delivery across an eviction and a replace ──

test("the alarm's cursor pass recovers a row whose FIRST delivery an eviction interrupted — from the claim written before the call, and the loop had armed the alarm to come back", async () => {
  let ackInterrupted!: () => void;
  const interrupted = new Promise<void>((r) => (ackInterrupted = r));
  const beforeEviction: number[] = [];
  const afterEviction: number[] = [];
  const first = incarnation((printed) =>
    printed === "itx.sink"
      ? {
          push: async (events: { payload?: { n?: number } }[]) => {
            beforeEviction.push(...ns(events));
            await interrupted; // the delivery the eviction interrupts
          },
        }
      : undefined,
  );
  configure(first, { name: "s", target: "itx.sink.push", consumes: ["demo/ping"] });
  const armedBeforeAnyDelivery = first.alarms.length;
  first.stream.append({ type: "demo/ping", payload: { n: 1 } });
  first.stream.append({ type: "demo/ping", payload: { n: 2 } });
  await drainDeliveries();
  expect(beforeEviction).toEqual([1, 2]); // both landed before the loop's read: one batch, in flight, never acked
  // …so the table holds the CLAIM written before the call (attempt 1, a time to come back by),
  // never an ack…
  expect(first.stream.storage.listSubscriptionCursors()).toMatchObject([
    [
      "s",
      {
        attempt: 1,
        confirmedOffset: first.stream.coreReducedState.subscriptions.s.configuredAtOffset,
      },
    ],
  ]);
  expect(first.alarms.length).toBeGreaterThan(armedBeforeAnyDelivery); // …and the loop armed the alarm

  // THE EVICTION: a fresh incarnation over the same storage — the log and the kv, nothing else.
  const second = incarnation(
    (printed) =>
      printed === "itx.sink"
        ? {
            push: (events: { payload?: { n?: number } }[]) =>
              void afterEviction.push(...ns(events)),
          }
        : undefined,
    first.storage,
  );
  expect(Object.keys(second.stream.coreReducedState.subscriptions)).toEqual(["s"]); // the row survived
  fakeClock(second.delivery.cursor("s")!.nextAttemptAtMs! + 1);
  await second.delivery.deliverEveryCursorSubscription(); // THE ALARM'S OWN PASS, past the claim
  await drainDeliveries();
  expect(afterEviction).toEqual([1, 2]);
  ackInterrupted(); // (releases the first incarnation's watchdog — no timer outlives the test)
});

test("a row re-configured onto a NEW target while a delivery is in flight delivers the next batch to the NEW target", async () => {
  const sinkA: number[][] = [];
  const sinkB: number[][] = [];
  let releaseSinkA!: () => void;
  const sinkAGate = new Promise<void>((r) => (releaseSinkA = r));
  // Both targets are three-step (`itx.<sink>.push`), so the head/method split is the normal one.
  const { stream } = incarnation((printed) => {
    if (printed === "itx.sinkA")
      return {
        push: async (events: { payload?: { n?: number } }[]) => {
          sinkA.push(ns(events));
          await sinkAGate;
        },
      };
    if (printed === "itx.sinkB") return pushSink(sinkB);
    return undefined;
  });
  configure({ stream }, { name: "s", target: "itx.sinkA.push", consumes: ["demo/ping"] });
  stream.append({ type: "demo/ping", payload: { n: 1 } });
  await drainDeliveries();
  expect(sinkA).toEqual([[1]]); // the first batch is in flight, parked on the gate

  // The row is REPLACED while that delivery is parked, and a second batch lands behind it.
  configure({ stream }, { name: "s", target: "itx.sinkB.push", consumes: ["demo/ping"] });
  stream.append({ type: "demo/ping", payload: { n: 2 } });
  await drainDeliveries();
  releaseSinkA();
  await drainDeliveries();
  expect({ sinkA, sinkB }).toEqual({ sinkA: [[1]], sinkB: [[2]] });
});

test("a cursor row re-configured `ordered: false` while its call is out leaves the fan-out row alone: the old batch moves no cursor, and `deliverEvent` only ever gets one event", async () => {
  const pushes: number[][] = [];
  const delivered: unknown[] = [];
  let releasePush!: () => void;
  const rig = incarnation((printed) =>
    printed === "itx.sink"
      ? {
          push: (events: { payload?: { n?: number } }[]) => {
            pushes.push(ns(events));
            return new Promise<void>((resolve) => (releasePush = resolve));
          },
          // every call keeps its slot: the row admits 8 and stays behind the mark
          deliverEvent: (event: StreamEvent | StreamEvent[]) => {
            delivered.push(Array.isArray(event) ? "a batch" : ns([event])[0]);
            return new Promise<never>(() => {});
          },
        }
      : undefined,
  );
  configure(rig, { name: "s", target: "itx.sink.push", consumes: ["demo/ping"] });
  rig.stream.append({ type: "demo/ping", payload: { n: 1 } });
  await drainDeliveries();
  expect(pushes).toEqual([[1]]); // parked
  configure(rig, { ...SINK_ROW, name: "s", consumes: ["demo/ping"] });
  rig.stream.append(...range(2, 10).map((n) => ({ type: "demo/ping", payload: { n } })));
  await drainDeliveries();
  const fanOutCursor = rig.stream.storage.listSubscriptionCursors();
  releasePush();
  await drainDeliveries();
  expect(delivered).toEqual(range(2, 9));
  expect(rig.stream.storage.listSubscriptionCursors()).toEqual(fanOutCursor);
});

test("a two-step target (`itx.<alias>` — the spelling every provide mints) IS the callee: delivered to whole, never split into a bare root and a method", async () => {
  const delivered: number[][] = [];
  const { stream, evaluated } = incarnation((printed) =>
    // What a rewrite rule resolves `itx.sink` to: the bare callable a client lent.
    printed === "itx.sink"
      ? (events: { payload?: { n?: number } }[]) => void delivered.push(ns(events))
      : undefined,
  );
  configure({ stream }, { name: "mirror", target: "itx.sink", consumes: ["demo/ping"] });
  stream.append({ type: "demo/ping", payload: { n: 1 } });
  await drainDeliveries();
  // the target evaluated is `itx.sink` itself — at configure, then per commit that reached the row
  expect(delivered).toEqual([[1]]);
  expect(evaluated.length).toBeGreaterThan(0);
  expect(evaluated.every((printed) => printed === "itx.sink")).toBe(true);
});

// ── cursor delivery's read reservation is never re-acquired while held ──

// The read branch reserves the whole cursor budget (8 MiB) before its read. A page's BODIES fill
// the read budget (8 MiB of stored bytes) and each event's offset and path ride on top, so a full
// page serializes PAST the reservation. Acquiring the overshoot while holding the whole budget
// waited on the reservation itself — forever — and every other cursor row on the context behind it.
test.for([
  { bodyShortfall: 100, label: "CONTROL: a body 100 chars under the ceiling (the page fits)" },
  {
    bodyShortfall: 5,
    label: "a body 5 chars under the ceiling (the page overshoots by its envelope)",
  },
])("$label — delivered, and the other cursor row keeps flowing", async ({ bodyShortfall }) => {
  const delivered: Record<string, number[]> = { history: [], now: [] };
  const rig = incarnation((printed) => {
    const name = printed === "itx.history" ? "history" : printed === "itx.now" ? "now" : undefined;
    return (
      name && {
        push: (events: { offset: number }[]) =>
          void delivered[name].push(...events.map((e) => e.offset)),
      }
    );
  });
  const cause = { chain: "a test's chain", depth: 0 };
  const overhead = JSON.stringify({
    type: "blob",
    payload: { blob: "" },
    source: { cause, origin: "/" }, // the stream's own stamp of where an unstamped event came from
    createdAt: new Date().toISOString(),
  }).length;
  const [big] = rig.stream.append({
    type: "blob",
    payload: { blob: "x".repeat(8 * MiB - overhead - bodyShortfall) },
    source: { cause },
  });
  // `history` must READ the page holding the big event (the whole log); `now` is "from now".
  configure(rig, {
    name: "history",
    target: "itx.history.push",
    consumes: ["blob"],
    afterOffset: 0,
  });
  configure(rig, { name: "now", target: "itx.now.push", consumes: ["tick"] });
  const [tick] = rig.stream.append({ type: "tick" });
  await drainDeliveries();
  expect(delivered).toEqual({ history: [big.offset], now: [tick.offset] });
  expect(rig.delivery.cursor("now")?.confirmedOffset).toBe(tick.offset);
});

// ── a rule re-point re-classifies a row ──

test("a rule re-point re-classifies, push → cursor: a facet row re-pointed at a plain function leaves the push set, so the alarm's pass retries its ladder", async () => {
  let targetKind: "facet" | "sink" = "facet";
  let sinkCalls = 0;
  const rig = incarnation((printed) =>
    printed !== "itx.proc"
      ? undefined
      : targetKind === "facet"
        ? new FacetHandle(() => Promise.resolve())
        : () => {
            sinkCalls++;
            throw new Error("sink down");
          },
  );
  // A two-step target (`itx.proc`) — root-called whole. The RULE decides the delivery: a row is a
  // push row when its target RESOLVES (through the rule table, never by evaluating it) to a facet.
  rig.stream.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.proc", target: "itx.facets.get('proc')" },
  });
  configure(rig, { name: "s", target: "itx.proc", consumes: ["blob"] });
  await drainDeliveries();
  rig.stream.append({ type: "blob" });
  await drainDeliveries();
  expect(rig.delivery.cursor("s")).toBeUndefined(); // a facet: push delivery keeps no cursor
  // THE RE-POINT: a rule commit replaces the rule table (the per-row target memo keys on it), and
  // `itx.proc` now resolves to — and evaluates to — a plain value that cannot own its progress.
  targetKind = "sink";
  rig.stream.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.proc", target: "itx.kv" },
  });
  rig.stream.append({ type: "blob" });
  await drainDeliveries();
  const failed = rig.delivery.cursor("s");
  expect(sinkCalls).toBe(1);
  expect(failed).toMatchObject({ attempt: 1 });
  // The alarm's row-driven pass, past the ladder's next attempt: the row is retried from its cursor.
  fakeClock(failed!.nextAttemptAtMs! + 1);
  await rig.delivery.deliverEveryCursorSubscription();
  await drainDeliveries();
  expect(sinkCalls).toBe(2);
  expect(rig.delivery.cursor("s")).toMatchObject({ attempt: 2 });
});

// ── a superseded evaluation can neither classify nor invoke its replacement ──

test("a facet row replaced by a cursor row while its target was still evaluating — at configure, and under a push: the old facet is never called again, the replacement is classified by its OWN evaluation and delivered", async () => {
  const facetCalls: string[] = [];
  const sink: number[][] = [];
  let gate = Promise.resolve();
  let openGate = () => {};
  const facet = new FacetHandle((steps) => {
    const [call] = steps;
    facetCalls.push(Array.isArray(call) ? call[0] : call);
    return Promise.resolve();
  });
  const rig = incarnation((printed) =>
    printed === "itx.proc"
      ? gate.then(() => facet) // the evaluation parks on the gate
      : printed === "itx.sink"
        ? pushSink(sink)
        : undefined,
  );
  // `itx.proc` RESOLVES to a facet (a rule): the row is a push row before anything evaluates.
  rig.stream.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.proc", target: "itx.facets.get('proc')" },
  });
  const configureFacet = () =>
    configure(rig, { name: "s", target: "itx.proc.processEventBatch", consumes: ["blob"] });
  const configureSink = () =>
    configure(rig, { name: "s", target: "itx.sink.push", consumes: ["blob"] });
  // AT CONFIGURE: the facet row's catch-up parks on its evaluation; the row is replaced meanwhile.
  gate = new Promise((r) => (openGate = r));
  configureFacet();
  await drainDeliveries();
  configureSink(); // REPLACES the row (a new identity) under the parked evaluation
  await drainDeliveries();
  openGate();
  await drainDeliveries();
  expect(facetCalls).toEqual([]); // the superseded catch-up called nothing
  rig.stream.append({ type: "blob", payload: { n: 1 } });
  await drainDeliveries();
  expect(sink).toEqual([[1]]); // the replacement is its own row: a cursor target, delivered
  expect(rig.delivery.cursor("s")).toBeDefined();
  // UNDER A PUSH: back to a facet row (caught up), then a push whose evaluation parks.
  gate = Promise.resolve();
  configureFacet();
  await drainDeliveries();
  expect(facetCalls).toEqual(["catchUpFromLog"]);
  gate = new Promise((r) => (openGate = r));
  rig.stream.append({ type: "blob", payload: { n: 2 } });
  await drainDeliveries(); // the push's evaluation is parked
  configureSink();
  await drainDeliveries();
  openGate();
  await drainDeliveries();
  expect(facetCalls).toEqual(["catchUpFromLog"]); // the superseded push called nothing
  rig.stream.append({ type: "blob", payload: { n: 3 } });
  await drainDeliveries();
  expect(sink).toEqual([[1], [3]]);
});

// ── a cursor row's ephemerals come from the stream's ring: an ephemeral delivery that FAILS is retried from it, and the next ephemeral reaches the row before any durable lands ──

test("ring retry: durable n=1 acked; ephemeral n=2 refused (the ladder arms, the table stays at the mark); the retry reads n=2 back out of the ring and delivers it; ephemeral n=3 follows in memory, never held until the next durable", async () => {
  const rig = refusingSinkRig();
  const [durable] = rig.stream.append({ type: "demo/ping", payload: { n: 1 } });
  await drainDeliveries();
  expect(rig.pushes.map((push) => push.events)).toEqual([[1]]);
  expect(rig.delivery.cursor("s")).toMatchObject({ confirmedOffset: durable.offset, attempt: 0 });
  rig.modeRef.mode = "throw";
  const [second] = rig.stream.append({ type: "demo/ping", ephemeral: true, payload: { n: 2 } });
  await drainDeliveries();
  const failed = rig.delivery.cursor("s")!;
  // The refusal climbed the ladder; the cursor stayed at the durable mark (nothing was acked),
  // and so did the table: a rung on an ephemeral never writes that ephemeral's offset.
  expect(failed).toMatchObject({ confirmedOffset: durable.offset, attempt: 1 });
  expect(failed.nextAttemptAtMs).toBeGreaterThan(Date.now());
  expect(rig.stream.storage.listSubscriptionCursors()).toMatchObject([
    ["s", { confirmedOffset: durable.offset, attempt: 1 }],
  ]);
  rig.modeRef.mode = "deliver";
  fakeClock(failed.nextAttemptAtMs! + 1);
  // The retry reads from the cursor: the log holds nothing past the mark, the ring still holds
  // the refused ephemeral — delivered, acked in memory only, the row caught up and claiming nothing.
  await rig.pass();
  expect(rig.pushes.map((push) => push.events)).toEqual([[1], [2]]);
  expect(rig.pushes.at(-1)).toMatchObject({
    range: { after: durable.offset, through: second.offset },
  });
  expect(rig.delivery.cursor("s")).toMatchObject({
    confirmedOffset: second.offset,
    attempt: 0,
  });
  expect(rig.delivery.cursor("s")?.nextAttemptAtMs).toBeUndefined();
  expect(rig.delivery.deadlines()).toEqual([]);
  expect(rig.stream.storage.listSubscriptionCursors()).toMatchObject([
    ["s", { confirmedOffset: durable.offset, attempt: 0 }],
  ]);
  // THE PIN: the next ephemeral reaches the row NOW, ranging from the ephemeral the memory
  // cursor stands on — a re-read returns only what is newer, so n=2 is not handed over twice.
  const [third] = rig.stream.append({ type: "demo/ping", ephemeral: true, payload: { n: 3 } });
  await drainDeliveries();
  expect(rig.pushes.map((push) => push.events)).toEqual([[1], [2], [3]]);
  expect(rig.pushes.at(-1)).toMatchObject({
    range: { after: second.offset, through: third.offset },
  });
  expect(rig.delivery.cursor("s")).toMatchObject({ confirmedOffset: third.offset, attempt: 0 });
});

test("ring retry: an ephemeral refused and then lost with its incarnation is gone: the next incarnation's retry finds nothing owed, spends the rung, and the row keeps delivering", async () => {
  const first = refusingSinkRig();
  const [durable] = first.stream.append({ type: "demo/ping", payload: { n: 1 } });
  await drainDeliveries();
  first.modeRef.mode = "throw";
  first.stream.append({ type: "demo/ping", ephemeral: true, payload: { n: 2 } });
  await drainDeliveries();
  const failed = first.delivery.cursor("s")!;
  expect(failed).toMatchObject({ confirmedOffset: durable.offset, attempt: 1 });
  // THE EVICTION: a fresh incarnation has an empty ring; the rung is the table's.
  const second = refusingSinkRig(first);
  expect(second.delivery.deadlines()).toMatchObject([{ name: "s", at: failed.nextAttemptAtMs }]);
  fakeClock(failed.nextAttemptAtMs! + 1);
  await second.pass();
  expect(second).toMatchObject({ pushes: [] }); // nothing to redeliver: the ephemeral died with the ring
  expect(second.delivery.cursor("s")?.nextAttemptAtMs).toBeUndefined();
  expect(second.delivery.deadlines()).toEqual([]);
  const [third] = second.stream.append({ type: "demo/ping", payload: { n: 3 } });
  await drainDeliveries();
  expect(second.pushes.map((push) => push.events)).toEqual([[3]]);
  expect(second.delivery.cursor("s")).toMatchObject({
    confirmedOffset: third.offset,
    attempt: 0,
  });
});

test("ring retry: the other side of the same rule: durable n=1 refused; ephemerals n=2 and n=3 land during the rung; the retry delivers all three from ONE read — the log and the ring together, in offset order", async () => {
  const rig = refusingSinkRig();
  rig.modeRef.mode = "throw";
  const configured = rig.stream.coreReducedState.subscriptions.s.configuredAtOffset;
  const [durable] = rig.stream.append({ type: "demo/ping", payload: { n: 1 } });
  await drainDeliveries();
  const failed = rig.delivery.cursor("s")!;
  expect(failed).toMatchObject({ confirmedOffset: configured, attempt: 1 });
  rig.stream.append({ type: "demo/ping", ephemeral: true, payload: { n: 2 } });
  const [third] = rig.stream.append({ type: "demo/ping", ephemeral: true, payload: { n: 3 } });
  await drainDeliveries();
  expect(rig).toMatchObject({ pushes: [] }); // the rung is not due: nothing was called
  rig.modeRef.mode = "deliver";
  fakeClock(failed.nextAttemptAtMs! + 1);
  await rig.pass();
  expect(rig.pushes.map((push) => push.events)).toEqual([[1, 2, 3]]);
  expect(rig.pushes.map((push) => push.range)).toEqual([
    { after: configured, through: third.offset },
  ]);
  // Memory stands on the head ephemeral; the table on the durable mark the read proved.
  expect(rig.delivery.cursor("s")).toMatchObject({ confirmedOffset: third.offset, attempt: 0 });
  expect(rig.stream.storage.listSubscriptionCursors()).toMatchObject([
    ["s", { confirmedOffset: durable.offset, attempt: 0 }],
  ]);
  expect(rig.delivery.deadlines()).toEqual([]);
});

// ── the delivery loop's claim on the DO's alarm (`deadlines()`): exactly the persisted time — the claim written as an attempt begins, a ladder rung, a claim a death left ──

test("alarm claim: a cursor row behind the durable mark is a claim, a caught-up one is not: the alarm is armed once and deleted once, a burst mid-call included", async () => {
  const rig = parkedSinkRig();
  expect(rig.delivery.deadlines()).toEqual([]);
  expect(rig).toMatchObject({ alarms: [] });
  rig.stream.append({ type: "demo/ping", payload: { n: 1 } });
  expect(rig.delivery.deadlines()).toMatchObject([{ name: "s" }]);
  expect(rig.alarms).toHaveLength(1);
  await drainDeliveries();
  rig.stream.append({ type: "demo/ping", payload: { n: 2 } }); // lands while n=1 is in flight
  expect(rig.alarms).toHaveLength(1); // the claim already stands: no second write
  await rig.release(); // acks n=1; the loop takes n=2
  await rig.release(); // acks n=2; caught up
  expect(rig).toMatchObject({ pushes: [[1], [2]], deletes: [1] });
  expect(rig.delivery.deadlines()).toEqual([]);
  expect(rig.alarms).toHaveLength(1);
});

test("alarm claim: an ephemeral-only push to a caught-up cursor row is uninsurable: it arms nothing", async () => {
  const rig = parkedSinkRig();
  rig.stream.append({ type: "demo/ping", payload: { n: 1 } });
  await drainDeliveries();
  await rig.release(); // caught up: armed once, deleted once
  expect({ alarms: rig.alarms.length, deletes: rig.deletes }).toEqual({
    alarms: 1,
    deletes: [1],
  });
  rig.stream.append({ type: "demo/ping", ephemeral: true });
  await drainDeliveries();
  expect(rig).toMatchObject({ pushes: [[1], [-1]] }); // `ns` reads -1 for a payload-less event
  expect(rig.delivery.deadlines()).toEqual([]);
  expect({ alarms: rig.alarms.length, deletes: rig.deletes }).toEqual({
    alarms: 1,
    deletes: [1],
  });
  await rig.release();
});

test("alarm claim: a durable that lands while an at-mark row WAITS for cursor-read room is delivered under a claim, not on the ring-sized reserve the wait began with", async () => {
  // Row `big` (consumes blob) reads a 7.5 MiB page and parks its call, holding most of the
  // cursor-read budget; row `small` (consumes demo/ping) is at the mark when an ephemeral kicks it,
  // so it reserves the ring's size and waits behind `big`. A durable it consumes lands meanwhile.
  // Woken, `small` is behind the mark: it must start over — a claim in the table, a page's worth
  // of room — before it reads, or an isolate death mid-call would leave that durable with no wake.
  const parked: Record<string, (() => void)[]> = { big: [], small: [] };
  const pushes: Record<string, number[][]> = { big: [], small: [] };
  const rig = incarnation((printed) => {
    const name = printed === "itx.big" ? "big" : printed === "itx.small" ? "small" : undefined;
    return (
      name && {
        push: (events: { payload?: { n?: number } }[]) => {
          pushes[name].push(ns(events));
          return new Promise<void>((resolve) => parked[name].push(resolve));
        },
      }
    );
  });
  const release = async (name: string) => {
    parked[name].splice(0).forEach((resolve) => resolve());
    await drainDeliveries();
  };
  for (const [name, consumes] of [
    ["small", "demo/ping"],
    ["big", "blob"],
  ] as const)
    configure(rig, { name, target: `itx.${name}.push`, consumes: [consumes] });
  await drainDeliveries();
  rig.stream.append({ type: "blob", payload: { n: 0, blob: "x".repeat(7.5 * MiB) } });
  await drainDeliveries(); // `big` parks its call holding ~7.5 MiB; `small` was moved along: at the mark
  expect(pushes).toMatchObject({ big: [[0]] });
  rig.stream.append({ type: "demo/ping", ephemeral: true, payload: { n: 1 } });
  await drainDeliveries(); // `small` reserved the ring's size and is waiting for room
  expect(pushes).toMatchObject({ small: [] });
  const [durable] = rig.stream.append({ type: "demo/ping", payload: { n: 2 } });
  await drainDeliveries();
  expect(pushes).toMatchObject({ small: [] }); // still waiting; no claim yet — the row was at the mark when it began
  expect(rig.delivery.cursor("small")?.nextAttemptAtMs).toBeUndefined();
  await release("big");
  // Woken behind the mark: the claim is written before the read, and the call is in flight.
  expect(pushes).toMatchObject({ small: [[1, 2]] });
  expect(rig.delivery.cursor("small")).toMatchObject({ attempt: 1 });
  expect(rig.delivery.cursor("small")?.nextAttemptAtMs).toBeGreaterThan(Date.now());
  expect(rig.stream.storage.listSubscriptionCursors()).toContainEqual([
    "small",
    expect.objectContaining({ attempt: 1 }),
  ]);
  expect(rig.delivery.deadlines()).toMatchObject([{ name: "small", attempt: 1 }]);
  // …and the alarm is armed for it: this claim was written after a wait, with no commit's
  // reconcile behind it — a death mid-call must still be woken.
  expect(rig.coordinator.snapshot()).toMatchObject({
    armedAt: rig.delivery.cursor("small")!.nextAttemptAtMs,
  });
  await release("small");
  expect(rig.delivery.cursor("small")).toMatchObject({
    confirmedOffset: durable.offset,
    attempt: 0,
  });
  expect(rig.delivery.deadlines()).toEqual([]);
});

test("alarm claim: an ephemeral that outgrows the ring while caught-up rows wait for room is read under a reserve its size: two rows never send it at once", async () => {
  // `big` parks a 7.5 MiB page; rows `a` and `b` are at the mark when a small ephemeral kicks them,
  // so each reserves the ring's 1 MiB and waits. A 5 MiB ephemeral lands meanwhile. Woken, each
  // must reserve what the ring now holds: 5 + 5 MiB is past the budget, so one reads and the other
  // waits for it — never two 5 MiB batches in flight on 2 MiB of room.
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const parked: Record<string, (() => void)[]> = { big: [], a: [], b: [] };
  const pushes: Record<string, number[][]> = { big: [], a: [], b: [] };
  const rig = incarnation((printed) => {
    const name = printed.replace(/^itx\./, "");
    return (
      name in parked && {
        push: (events: { payload?: { n?: number } }[]) => {
          pushes[name].push(ns(events));
          return new Promise<void>((resolve) => parked[name].push(resolve));
        },
      }
    );
  });
  const release = async (name: string) => {
    parked[name].splice(0).forEach((resolve) => resolve());
    await drainDeliveries();
  };
  for (const [name, consumes] of [
    ["a", "demo/ping"],
    ["b", "demo/ping"],
    ["big", "blob"],
  ] as const)
    configure(rig, { name, target: `itx.${name}.push`, consumes: [consumes] });
  await drainDeliveries();
  rig.stream.append({ type: "blob", payload: { n: 0, blob: "x".repeat(7.5 * MiB) } });
  await drainDeliveries(); // `big` parks holding ~7.5 MiB; `a` and `b` were moved along: at the mark
  rig.stream.append({ type: "demo/ping", ephemeral: true, payload: { n: 1 } });
  await drainDeliveries(); // both reserved the ring's 1 MiB and wait for room
  rig.stream.append({
    type: "demo/ping",
    ephemeral: true,
    payload: { n: 2, blob: "x".repeat(5 * MiB) },
  });
  await drainDeliveries();
  expect({ a: pushes.a, b: pushes.b }).toEqual({ a: [], b: [] });
  await release("big");
  expect(pushes.a.length + pushes.b.length).toBe(1); // one 5 MiB batch in flight, the other waits
  await release("a");
  await release("b");
  expect({ a: pushes.a, b: pushes.b }).toEqual({ a: [[2]], b: [[2]] }); // n=1 was evicted by n=2
});

test("alarm claim: two ephemeral batches that land during ONE in-flight cursor call BOTH reach the target, in one delivery, from the ring", async () => {
  const rig = parkedSinkRig();
  const [durable] = rig.stream.append({ type: "demo/ping", payload: { n: 1 } });
  await drainDeliveries(); // n=1 is in flight, parked
  rig.stream.append({ type: "demo/ping", ephemeral: true, payload: { n: 2 } });
  const [third] = rig.stream.append({ type: "demo/ping", ephemeral: true, payload: { n: 3 } });
  await drainDeliveries();
  expect(rig).toMatchObject({ pushes: [[1]] }); // still parked: the loop delivers one batch at a time
  await rig.release(); // acks n=1; the loop reads on from the cursor and finds both in the ring
  expect(rig).toMatchObject({ pushes: [[1], [2, 3]] });
  await rig.release(); // acks n=2 and n=3: memory on the head ephemeral, the table at the mark
  expect(rig.delivery.cursor("s")).toMatchObject({ confirmedOffset: third.offset, attempt: 0 });
  expect(rig.stream.storage.listSubscriptionCursors()).toMatchObject([
    ["s", { confirmedOffset: durable.offset, attempt: 0 }],
  ]);
  expect(rig.delivery.deadlines()).toEqual([]);
});

test("alarm claim: an ephemeral over the ring's whole budget reaches a caught-up cursor row, as it reaches a push row", async () => {
  const rig = parkedSinkRig();
  rig.stream.append({ type: "demo/ping", payload: { n: 1 } });
  await drainDeliveries();
  await rig.release(); // caught up, at the durable mark
  rig.stream.append({
    type: "demo/ping",
    ephemeral: true,
    payload: { n: 2, blob: "x".repeat(RECENT_EPHEMERALS_BUDGET_CHARS + 1024) },
  });
  await drainDeliveries();
  const delivered = rig.pushes.slice();
  await rig.release();
  expect(delivered, "a cursor row should receive an ephemeral over the ring's budget").toEqual([
    [1],
    [2],
  ]);
});

test("alarm claim: ephemerals the ring evicts before a busy cursor row reads them are reported, as a dropped push is", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const rig = parkedSinkRig();
  rig.stream.append({ type: "demo/ping", payload: { n: 1 } });
  await drainDeliveries(); // n=1 is in flight, parked
  // ~400 KiB each: the third evicts the first from the 1 MiB ring before the row reads on
  const [lost] = rig.stream.append({
    type: "demo/ping",
    ephemeral: true,
    payload: { n: 2, blob: "x".repeat(400 * 1024) },
  });
  for (const n of [3, 4])
    rig.stream.append({
      type: "demo/ping",
      ephemeral: true,
      payload: { n, blob: "x".repeat(400 * 1024) },
    });
  await rig.release(); // acks n=1; the loop reads the ring, which no longer holds n=2
  await rig.release();
  expect(rig).toMatchObject({ pushes: [[1], [3, 4]] }); // the loss itself is the contract
  expect(
    warn,
    "the ring's eviction of ephemerals a cursor row had not read should be reported",
  ).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "delivery.cursor.ephemerals-evicted",
      name: "s",
      lostThroughOffset: lost.offset,
    }),
  );
});

test("alarm claim: a pass that finds a call in flight WAITS for it: the deadline it leaves is derived after the ack — never a claim now past, never one for a row since caught up", async () => {
  const rig = parkedSinkRig();
  rig.stream.append({ type: "demo/ping", payload: { n: 1 } });
  await drainDeliveries();
  const [claim] = rig.delivery.deadlines();
  expect(claim).toMatchObject({ name: "s", attempt: 1 }); // the row a loop holds claims its time
  fakeClock(claim.at + 5_000);
  let passed = false;
  const pass = rig.pass().then(() => (passed = true));
  await drainDeliveries();
  expect(passed).toBe(false); // waiting on the call in flight…
  expect(rig.alarms.at(-1)).toBe(claim.at); // …and nothing was re-armed meanwhile
  await rig.release(); // the ack: caught up
  await pass;
  expect(rig.delivery.deadlines()).toEqual([]);
  expect(rig.coordinator.snapshot().armedAt).toBeNull(); // nothing owed, nothing armed
});

test("alarm claim: a facet row is never a claim — on a fresh incarnation too: its target RESOLVES to a facet before anything is evaluated, so a commit to it arms nothing", async () => {
  const first = stuckFacetRig();
  await first.release();
  const second = stuckFacetRig(first);
  second.stream.append({ type: "blob", payload: { blob: "x" } });
  expect(second.delivery.deadlines()).toEqual([]);
  await drainDeliveries();
  expect(second.delivery.deadlines()).toEqual([]);
  expect({ alarms: second.alarms, deletes: second.deletes }).toEqual({ alarms: [], deletes: [] });
  await second.release();
});

test("alarm claim: the claim written before a call outlives an eviction mid-call: it is the next incarnation's first deadline, and the batch is delivered again from the cursor", async () => {
  const first = parkedSinkRig();
  first.stream.append({ type: "demo/ping", payload: { n: 1 } });
  await drainDeliveries(); // the call is in flight: the row was written with attempt 1 and a time to come back by
  const [claim] = first.stream.storage.listSubscriptionCursors();
  // the same instant the alarm holds: one wake, not two
  expect(claim).toMatchObject(["s", { attempt: 1, nextAttemptAtMs: first.alarms[0] }]);
  // THE DEATH MID-CALL: the next incarnation finds the claim in the cursor table — the row is
  // behind, and the claim's time is when to come back.
  const second = parkedSinkRig(first);
  expect(second.delivery.deadlines()).toMatchObject([
    { name: "s", at: claim[1].nextAttemptAtMs, attempt: 1 },
  ]);
  expect(second).toMatchObject({ alarms: [claim[1].nextAttemptAtMs] });
  fakeClock(claim[1].nextAttemptAtMs! + 1);
  void second.pass(); // the pass awaits the delivery, which parks until released below
  await drainDeliveries();
  expect(second).toMatchObject({ pushes: [[1]] }); // delivered again, from the cursor
  await second.release(); // acked: attempt 0, no time, nothing owed
  expect(second.delivery.cursor("s")).toMatchObject({ attempt: 0 });
  expect(second.delivery.cursor("s")?.nextAttemptAtMs).toBeUndefined();
  expect(second.delivery.deadlines()).toEqual([]);
});

test("alarm claim: a batch that kills its caller mid-call fifteen times is not tried a sixteenth: the row halts, as fifteen refusals would halt it", async () => {
  let rig = parkedSinkRig();
  rig.stream.append({ type: "demo/ping", payload: { n: 1 } });
  await drainDeliveries();
  fakeClock();
  for (let deaths = 1; deaths < 15; deaths++) {
    const claim = rig.delivery.cursor("s")!;
    expect(claim).toMatchObject({ attempt: deaths });
    rig = parkedSinkRig(rig); // died mid-call; the next incarnation comes back at the claim's time
    vi.setSystemTime(claim.nextAttemptAtMs! + 1);
    void rig.pass(); // parks again: never awaited, never released — the next death
    await drainDeliveries();
    expect(rig).toMatchObject({ pushes: [[1]] }); // tried again (and parked again)
  }
  const fifteenth = rig.delivery.cursor("s")!;
  expect(fifteenth).toMatchObject({ attempt: 15 });
  rig = parkedSinkRig(rig);
  vi.setSystemTime(fifteenth.nextAttemptAtMs! + 1);
  await rig.pass(); // no call to park: the pass completes on its own
  expect(rig).toMatchObject({ pushes: [] }); // no sixteenth call
  expect(rig.stream.coreReducedState.subscriptions.s.halted).toMatchObject({ attempts: 15 });
  expect(rig.delivery.cursor("s")).toMatchObject({ attempt: 0 });
  expect(rig.delivery.cursor("s")?.nextAttemptAtMs).toBeUndefined();
  expect(rig.delivery.deadlines()).toEqual([]);
});

test("alarm claim: a durable commit a cursor row does not consume is no claim: the cursor moves along at once, and is still at the mark after an eviction", async () => {
  const first = parkedSinkRig(); // `s` consumes demo/ping only
  first.stream.append({ type: "demo/other", payload: {} });
  await drainDeliveries();
  expect(first.delivery.deadlines()).toEqual([]);
  expect(first).toMatchObject({ alarms: [] });
  expect(first.delivery.cursor("s")?.confirmedOffset).toBe(first.stream.highestDurableOffset());
  // Persisted, so an eviction finds it at the mark too…
  expect(first.stream.storage.listSubscriptionCursors()).toMatchObject([
    ["s", { confirmedOffset: first.stream.highestDurableOffset(), attempt: 0 }],
  ]);
  const second = parkedSinkRig(first);
  // …and the second's own woken is not its either: moved along again, still no claim.
  await drainDeliveries();
  expect(second.delivery.deadlines()).toEqual([]);
  expect(second).toMatchObject({ alarms: [] });
  expect(second.delivery.cursor("s")?.confirmedOffset).toBe(second.stream.highestDurableOffset());
});

test("alarm claim: a row whose target NO rule resolves dangles: it claims nothing and is never halted for it; the commit that lands its rule wakes it, and every durable since is delivered", async () => {
  let provided = false;
  const delivered: number[][] = [];
  const rig = incarnation(
    (printed) => (printed === "itx.later" && provided ? pushSink(delivered) : undefined), // NO_ITX_EXPRESSION_MATCH, exactly as the resolver refuses a name nothing provides
  );
  configure(rig, { name: "s", target: "itx.later.push", consumes: ["demo/ping"] });
  rig.stream.append({ type: "demo/ping", payload: { n: 1 } });
  await drainDeliveries();
  expect(delivered).toEqual([]);
  expect(rig.stream.coreReducedState.subscriptions.s.halted).toBeUndefined();
  expect(rig.delivery.cursor("s")).toMatchObject({ attempt: 0 }); // no rung: not a failure, a wait
  expect(rig.delivery.deadlines()).toEqual([]); // no claim: nothing to wake for until the rule lands
  expect(rig.coordinator.snapshot().armedAt).toBeNull();
  // THE RULE LANDS: a new rule table — the memo lapses, the row is behind, the commit itself
  // kicks its loop, and the ping that waited is delivered.
  provided = true;
  rig.stream.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.later", target: "itx.kv" },
  });
  await drainDeliveries();
  expect(delivered).toEqual([[1]]);
  expect(rig.delivery.deadlines()).toEqual([]);
});

test("alarm claim: a target whose CALL is refused as unresolvable (a sibling context's rule missing) dangles like an unresolvable head: the claim written before the call is withdrawn — no attempt spent, no rung, no halt", async () => {
  const rig = incarnation((printed) =>
    printed === "itx.far"
      ? {
          push: () => {
            throw codedError("NO_ITX_EXPRESSION_MATCH", "no rewrite rule matches in /x");
          },
        }
      : undefined,
  );
  configure(rig, { name: "s", target: "itx.far.push", consumes: ["demo/ping"] });
  rig.stream.append({ type: "demo/ping", payload: { n: 1 } });
  await drainDeliveries();
  expect(rig.stream.coreReducedState.subscriptions.s.halted).toBeUndefined();
  expect(rig.delivery.cursor("s")).toMatchObject({ attempt: 0 });
  expect(rig.delivery.cursor("s")?.nextAttemptAtMs).toBeUndefined();
  expect(rig.stream.storage.listSubscriptionCursors()).toMatchObject([["s", { attempt: 0 }]]);
  expect(rig.delivery.deadlines()).toEqual([]);
});

test("alarm claim: a refusal from a snapshot older than the attempt claims until it expires; a newer one claims nothing", async () => {
  fakeClock();
  let snapshotSentAt = Date.now() - 1_000; // before the attempt: the other context may have the name by now
  const rig = incarnation((printed) => {
    if (printed !== "itx.far") return undefined;
    throw Object.assign(codedError("NO_ITX_EXPRESSION_MATCH", "no rewrite rule matches at /"), {
      validUntil: snapshotSentAt + SNAPSHOT_TTL_MS,
    });
  });
  configure(rig, { name: "s", target: "itx.far.push", consumes: ["demo/ping"] });
  rig.stream.append({ type: "demo/ping", payload: { n: 1 } });
  await drainDeliveries();
  const until = snapshotSentAt + SNAPSHOT_TTL_MS;
  expect(rig.delivery.cursor("s")).toMatchObject({ attempt: 0, nextAttemptAtMs: until });
  expect(rig.delivery.deadlines()).toMatchObject([{ name: "s", at: until }]);
  vi.setSystemTime(until);
  snapshotSentAt = Date.now(); // the attempt's own read
  await rig.pass();
  await drainDeliveries();
  expect(rig.evaluated.filter((printed) => printed === "itx.far")).toHaveLength(2);
  expect(rig.delivery.cursor("s")).toMatchObject({ attempt: 0 });
  expect(rig.delivery.cursor("s")?.nextAttemptAtMs).toBeUndefined();
  expect(rig.delivery.deadlines()).toEqual([]);
});

test("alarm claim: a cursor row re-pointed at a facet drops its cursor and its claim on that rule commit; the delivery loop never pays for a target that owns its progress", async () => {
  const rig = parkedSinkRig();
  rig.stream.append({ type: "demo/ping", payload: { n: 1 } });
  await drainDeliveries();
  expect(rig.delivery.deadlines()).toMatchObject([{ name: "s" }]);
  expect(rig.alarms).toHaveLength(1);
  // THE RE-POINT: `itx.sink` now resolves to a facet — the row owns its progress from this commit.
  rig.stream.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.sink", target: "itx.facets.get('sink')" },
  });
  expect(rig.delivery.cursor("s")).toBeUndefined();
  expect(rig.stream.storage.listSubscriptionCursors()).toEqual([]);
  expect(rig.delivery.deadlines()).toEqual([]);
  expect(rig).toMatchObject({ deletes: [1] });
  await rig.release();
  expect(rig.delivery.cursor("s")).toBeUndefined(); // the call that was out acks nothing
});

test("alarm claim: the ladder's next attempt IS the row's deadline, and survives an eviction before any pass", async () => {
  const first = incarnation((printed) =>
    printed === "itx.sink"
      ? {
          push: () => {
            throw new Error("sink down");
          },
        }
      : undefined,
  );
  configure(first, { name: "s", target: "itx.sink.push", consumes: ["demo/ping"] });
  first.stream.append({ type: "demo/ping", payload: { n: 1 } });
  await drainDeliveries();
  const failed = first.delivery.cursor("s")!;
  expect(failed).toMatchObject({ attempt: 1 });
  expect(first.delivery.deadlines()).toMatchObject([{ name: "s", at: failed.nextAttemptAtMs }]);
  expect(first.alarms.at(-1)).toBe(failed.nextAttemptAtMs);
  // A commit during the wait insures nothing: the ladder covers the row.
  first.stream.append({ type: "demo/ping", payload: { n: 2 } });
  await drainDeliveries();
  expect(first.delivery.deadlines()).toMatchObject([{ at: failed.nextAttemptAtMs }]);
  const second = incarnation(() => undefined, first.storage);
  expect(second.delivery.deadlines()).toMatchObject([{ name: "s", at: failed.nextAttemptAtMs }]);
});

test("alarm claim: a due retry stays a claim until a pass acts on it; a pass that finds the retry's call in flight waits for it", async () => {
  let mode: "throw" | "park" = "throw";
  const parked: (() => void)[] = [];
  const rig = incarnation((printed) =>
    printed === "itx.sink"
      ? {
          push: () => {
            if (mode === "throw") throw new Error("sink down");
            return new Promise<void>((resolve) => parked.push(resolve));
          },
        }
      : undefined,
  );
  configure(rig, { name: "s", target: "itx.sink.push", consumes: ["demo/ping"] });
  rig.stream.append({ type: "demo/ping", payload: { n: 1 } });
  await drainDeliveries();
  const failed = rig.delivery.cursor("s")!;
  expect(rig.delivery.deadlines()).toMatchObject([{ at: failed.nextAttemptAtMs }]);
  fakeClock(failed.nextAttemptAtMs! + 1);
  // Due, and still the claim: nothing that reconciles meanwhile may delete the alarm under it.
  expect(rig.delivery.deadlines()).toMatchObject([{ at: failed.nextAttemptAtMs }]);
  mode = "park";
  rig.stream.append({ type: "demo/ping", payload: { n: 2 } }); // the retry starts, and parks
  await drainDeliveries();
  expect(rig.delivery.deadlines()[0]).toMatchObject({ name: "s" });
  let passed = false;
  const pass = rig.pass().then(() => (passed = true));
  await drainDeliveries();
  expect(passed).toBe(false); // the pass waits on the retry's call
  for (const resolve of parked.splice(0)) resolve();
  await drainDeliveries();
  for (const resolve of parked.splice(0)) resolve(); // n=2, queued behind the retry
  await drainDeliveries();
  await pass;
  expect(rig.delivery.cursor("s")).toMatchObject({ attempt: 0 });
  expect(rig.delivery.deadlines()).toEqual([]);
});

test("alarm claim: a row an unreadable event stops is HALTED, not retried into forever, and its persisted cursor keeps no claim", async () => {
  const first = parkedSinkRig();
  const [ping] = first.stream.append({ type: "demo/ping", payload: { n: 1 } });
  await drainDeliveries(); // in flight; the claim is written
  // Corrupt the stored row; the next incarnation reads it back for the retry.
  first.storage.sql.exec("UPDATE events SET body = 'not json' WHERE offset = ?", ping.offset);
  const second = parkedSinkRig(first);
  const claim = second.delivery.cursor("s")!;
  fakeClock(claim.nextAttemptAtMs! + 1);
  await second.pass();
  expect(second).toMatchObject({ pushes: [] });
  expect(second.stream.coreReducedState.subscriptions.s.halted).toMatchObject({ attempts: 2 });
  expect(second.delivery.deadlines()).toEqual([]);
  // The halt spends the claim it was made under, as the ladder's own halts do: a resume starts a
  // fresh ladder from the persisted cursor.
  expect(second.stream.storage.listSubscriptionCursors()).toEqual([
    ["s", { confirmedOffset: claim.confirmedOffset, attempt: 0 }],
  ]);
  // The claim was the one alarm armed; the pass spent it and nothing re-arms.
  expect(second).toMatchObject({ alarms: [claim.nextAttemptAtMs] });
  expect(second.coordinator.snapshot().armedAt).toBeNull();
  await first.release();
});

test("alarm claim: a cursor row whose subscription is gone claims nothing", async () => {
  const first = incarnation(() => undefined);
  // A removal whose cursor delete did not outlive the incarnation: the row is gone, the cursor stays.
  first.stream.storage.writeSubscriptionCursor("gone", {
    confirmedOffset: 1,
    attempt: 3,
    nextAttemptAtMs: Date.now() + 60_000,
  });
  const second = incarnation(() => undefined, first.storage);
  expect(second.delivery.cursor("gone")).toBeDefined();
  expect(second.delivery.deadlines()).toEqual([]);
  expect(second).toMatchObject({ alarms: [] });
});

test("alarm claim: a HALTED row owes nothing, even if its persisted cursor carries a retry time", async () => {
  const first = incarnation(() => undefined);
  configure(first, { name: "s", target: "itx.sink.push", consumes: ["demo/ping"] });
  // deadlines() skips a halted row, so a retry time left in its cursor is never a claim.
  first.stream.storage.writeSubscriptionCursor("s", {
    confirmedOffset: 1,
    attempt: 0,
    nextAttemptAtMs: Date.now() - 60_000,
  });
  first.stream.append({
    type: "events.iterate.com/itx/subscription-delivery-halted",
    payload: { name: "s", afterOffset: 1, attempts: 15, error: "sink down" },
  });
  const second = incarnation(() => undefined, first.storage);
  expect(second.delivery.cursor("s")?.nextAttemptAtMs).toBeLessThan(Date.now());
  expect(second.delivery.deadlines()).toEqual([]);
  await second.pass();
  expect(second).toMatchObject({ alarms: [] });
});

// ── a push the row's removal or the platform cut off is that outcome, never an issue ──

test.for([
  {
    name: "a push in flight when its row is removed and its facet deleted (NO_FACET) is logged as the removal, never an issue",
    rejection: codedError("NO_FACET", 'facet "gone" was deleted while this call was in flight'),
    removed: true,
    expected: { issues: [], removals: ["subscription-delivery.deliver"], platformFailures: [] },
  },
  {
    name: "control: any other failure of that push is still an issue",
    rejection: new Error("the facet threw"),
    removed: true,
    expected: { issues: ["subscription-delivery.deliver"], removals: [], platformFailures: [] },
  },
  {
    name: "control: NO_FACET on a row still in place addresses a facet no longer hosted — neither",
    rejection: codedError("NO_FACET", 'no facet "gone" — load a class into it first'),
    removed: false,
    expected: { issues: [], removals: [], platformFailures: [] },
  },
  {
    // The facet's own outbound call gave up as the platform's (a hop's UNAVAILABLE): the batch is the
    // facet's to read from the log at its next push, never pushed or caught up again here.
    name: "a push the platform failed (a hop's UNAVAILABLE) is logged as the platform's, never an issue, and not repeated",
    rejection: codedError("UNAVAILABLE", "The repo failed: overloaded", {
      kind: "overloaded",
      retryAfterMs: 10_000,
    }),
    removed: false,
    expected: {
      issues: [],
      removals: [],
      platformFailures: [
        {
          event: "subscription-delivery.platform-failure-deliver",
          kind: "overloaded",
          name: "gone",
        },
      ],
    },
  },
])("$name", async ({ rejection, removed, expected }) => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const parked: ((reason: unknown) => void)[] = [];
  const facetMethods: string[] = [];
  const rig = incarnation(
    () =>
      new FacetHandle(([call]) => {
        if (Array.isArray(call)) facetMethods.push(String(call[0]));
        return Array.isArray(call) && call[0] === "processEventBatch"
          ? new Promise<void>((_, reject) => parked.push(reject))
          : Promise.resolve();
      }),
  );
  const gone = (target: ItxExpression | null) =>
    configure(rig, { name: "gone", target, consumes: ["blob"] });
  gone(facetTarget("gone"));
  await drainDeliveries();
  rig.stream.append({ type: "blob", payload: {} });
  await drainDeliveries();
  if (removed) gone(null);
  const calledBefore = facetMethods.length;
  parked.shift()!(rejection);
  await drainDeliveries();
  const events = (spy: typeof log, event: string) =>
    spy.mock.calls
      .map(([line]) => line as { event?: string; failureSite?: string })
      .filter((line) => line.event === event)
      .map((line) => line.failureSite);
  expect({
    issues: events(error, "issue"),
    removals: events(log, "delivery.facet-removed-in-flight"),
    platformFailures: warn.mock.calls
      .map(([line]) => line as { event?: string; kind?: string; name?: string })
      .filter((line) => line.event?.startsWith("subscription-delivery."))
      .map(({ event, kind, name }) => ({ event, kind, name })),
    calledAfter: facetMethods.slice(calledBefore),
  }).toEqual({ ...expected, calledAfter: [] });
});

// ── FAN-OUT: one event per call, any order, every event retried and dead-lettered on its own ──

test("fan-out: failing events hold up no other event and climb their own ladders; one recovering acks alone", async () => {
  let healed = false;
  const rig = fanOutRig({ behave: ({ n }) => ((n === 2 && !healed) || n === 3 ? "fail" : "ack") });
  const [, two, three] = rig.pings(1, 2, 3, 4);
  await drainDeliveries();
  await rig.pass(); // before either rung: nothing is tried again
  await drainDeliveries();
  expect(rig).toMatchObject({ calls: [1, 2, 3, 4], acked: [1, 4] });
  // the settled prefix is past every event: acked, or pending a retry
  expect(rig.delivery.cursor("f")).toMatchObject({ confirmedOffset: rig.head(), attempt: 0 });
  expect(rig.delivery.cursor("f")?.nextAttemptAtMs).toBeUndefined();
  await rig.passAfterEveryRung();
  expect(rig.records()).toMatchObject([
    { offset: two.offset, attempt: 2 },
    { offset: three.offset, attempt: 2 },
  ]);
  healed = true;
  await rig.passAfterEveryRung();
  expect(rig.records()).toMatchObject([{ offset: three.offset, attempt: 3 }]);
  expect(rig).toMatchObject({ acked: [1, 4, 2] });
  expect(rig.stream.coreReducedState.subscriptions.f.halted).toBeUndefined();
});

test.for([
  {
    name: "a PERMANENT_FAILURE of one event dead-letters that event alone, with no retry and no halt",
    error: "PERMANENT_FAILURE",
    expected: { deadLetters: 1, halted: false, acked: [1, 3], owed: [] },
  },
  {
    name: "an EVENT_TOO_LARGE of one event dead-letters that event alone",
    error: "EVENT_TOO_LARGE",
    expected: { deadLetters: 1, halted: false, acked: [1, 3], owed: [] },
  },
  {
    name: "NOT_A_METHOD is the target's, not the event's: the row halts, the event owed with its attempt unspent",
    error: "NOT_A_METHOD",
    expected: { deadLetters: 0, halted: true, acked: [1], owed: [2] },
  },
] as const)("fan-out: $name", async ({ error, expected }) => {
  const rig = fanOutRig({ behave: ({ n }) => (n === 2 ? codedError(error, "no") : "ack") });
  for (const n of [1, 2, 3]) {
    rig.pings(n);
    await drainDeliveries();
  }
  expect({
    deadLetters: rig.deadLetters().length,
    halted: Boolean(rig.stream.coreReducedState.subscriptions.f.halted),
    acked: rig.acked,
    owed: rig.records().map(({ offset }) => offset),
  }).toEqual({ ...expected, owed: expected.owed.map(rig.offsetOf) });
  for (const record of rig.records())
    expect(record).toMatchObject({ attempt: 0, nextAttemptAtMs: null, leased: false });
  if (expected.deadLetters)
    expect(rig.deadLetters()[0]).toMatchObject({
      payload: { name: "f", offset: rig.offsetOf(2), attempts: 1, error: "no" },
    });
});

test.for([
  {
    name: "a call that never answers",
    hung: { behave: ({ n }: { n: number }) => (n <= 8 ? "park" : "ack") },
  },
  { name: "a target whose evaluation never resolves", hung: { evaluation: "hangs" } },
] as const)(
  "fan-out: $name keeps its slot past the watchdog; eight end the incarnation, the next delivers all nine",
  async ({ hung }) => {
    fakeClock(Date.now(), ["setTimeout", "clearTimeout"]);
    const first = fanOutRig(hung);
    first.pings(...range(1, 9));
    await drainDeliveries();
    expect(first.records().map(({ offset, leased }) => [offset, leased])).toEqual(
      range(1, 8).map((n) => [first.offsetOf(n), true]),
    ); // the bound: the ninth waits
    let passed = false;
    const pass = first.pass().then(() => (passed = true));
    await drainDeliveries();
    expect(passed).toBe(false); // an alarm's pass waits for the outcomes of the calls out…
    vi.advanceTimersByTime(20_000);
    await drainDeliveries();
    await pass; // …which the 20 s watchdog brings in
    expect(first.records()).toHaveLength(8);
    expect(first.records()[0]).toMatchObject({
      attempt: 1,
      leased: false,
      error: expect.stringContaining("no answer in 20s"),
    });
    expect(first).toMatchObject({
      aborts: ['subscription "f": 8 deliveries unanswered past the watchdog'],
    });
    vi.useRealTimers();
    const second = fanOutRig({ previous: first });
    await second.passAfterEveryRung();
    await drainDeliveries();
    expect(second.acked.toSorted((a, b) => a - b)).toEqual(range(1, 9));
    expect(second.records()).toEqual([]);
  },
);

test("fan-out: the in-flight budget bounds the events a row holds: 3 MiB events are admitted two at a time within 8 MiB, not eight", async () => {
  const rig = fanOutRig({ behave: () => "park" });
  for (const n of range(1, 6))
    rig.stream.append({ type: "demo/ping", payload: { n, blob: "x".repeat(3 * MiB) } });
  await drainDeliveries();
  expect(rig).toMatchObject({ calls: [1, 2] });
  rig.settle(1);
  await drainDeliveries();
  expect(rig).toMatchObject({ calls: [1, 2, 3] });
});

test("fan-out: a restart onto another deploy mid-call is no death: the leases another deploy left are plain retries, sent together when due, none a suspect", async () => {
  const first = fanOutRig({ behave: () => "park" });
  first.pings(1, 2, 3);
  await drainDeliveries();
  const [lease] = first.records();
  const second = fanOutRig({ previous: first, options: { deployId: "the next deploy" } });
  expect(second.records().map(({ leased }) => leased)).toEqual([false, false, false]);
  fakeClock(lease!.nextAttemptAtMs! + 1);
  void second.pass();
  await drainDeliveries();
  expect(second).toMatchObject({ calls: [1, 2, 3], acked: [1, 2, 3] });
  expect(second.records()).toEqual([]);
});

test.for([
  {
    name: "a killer's retry, due beside the other retries",
    killer: 1,
    setUp: async () => {
      const rig = fanOutRig({ behave: () => "fail" });
      rig.pings(1, 2, 3);
      await drainDeliveries();
      return rig;
    },
  },
  {
    name: "a killer's first attempt, beside innocent retries",
    killer: 3,
    setUp: async () => {
      const rig = fanOutRig({ behave: ({ n }) => (n === 3 ? "park" : "fail") });
      rig.pings(1, 2);
      await drainDeliveries();
      vi.setSystemTime(Math.max(...rig.delivery.deadlines().map(({ at }) => at)) + 1);
      rig.pings(3);
      await drainDeliveries();
      return rig;
    },
  },
  {
    name: "a killer's retry on a busy row, a new event committed as it comes due",
    killer: 1,
    busy: true,
    setUp: async () => {
      const rig = fanOutRig({ behave: () => "park" });
      rig.pings(1);
      await drainDeliveries();
      return rig;
    },
  },
])(
  "fan-out: $name — a suspect runs alone: only the killer is dead-lettered, at 15, and every other event is acked",
  async ({ killer, busy, setUp }) => {
    fakeClock();
    let rig = await setUp();
    const beside: number[][] = [];
    const acked = new Set<number>();
    for (let death = 0; death < 40 && rig.records().length > 0; death++) {
      const due = Math.max(Date.now(), ...rig.delivery.deadlines().map(({ at }) => at));
      rig = fanOutRig({ previous: rig, behave: () => "park" });
      vi.setSystemTime(due + 1);
      if (busy) rig.pings(100 + death);
      void rig.pass();
      await drainDeliveries();
      // every call answers but the killer's: the context dies with whatever is out beside it
      while (!rig.calls.includes(killer)) {
        const before = rig.calls.length;
        for (const n of new Set(rig.calls)) rig.settle(n);
        await drainDeliveries();
        if (rig.calls.length === before) break;
      }
      for (const n of rig.acked) acked.add(n);
      if (rig.calls.includes(killer))
        beside.push([...new Set(rig.calls)].filter((n) => n !== killer && !rig.acked.includes(n)));
    }
    expect(rig.deadLetters()).toMatchObject([
      { payload: { offset: rig.offsetOf(killer), attempts: 15 } },
    ]);
    // every call beside a death is charged that death alone, and no innocent event is lost
    expect(beside.slice(1).flat()).toEqual([]);
    const pinged = factsOf(rig, "demo/ping").map((event) => (event.payload as { n: number }).n);
    expect([...acked].toSorted((a, b) => a - b)).toEqual(
      pinged.filter((n) => n !== killer).toSorted((a, b) => a - b),
    );
  },
);

test("fan-out: a down receiver pauses its row, is probed with one new event a rung, dead-letters at 15, and its first ack lifts the pause", async () => {
  let down = true;
  const rig = fanOutRig({ behave: () => (down ? "fail" : "ack") });
  for (const n of range(1, 3)) {
    rig.pings(n);
    await drainDeliveries();
  }
  rig.pings(...range(4, 20));
  await drainDeliveries();
  expect(rig).toMatchObject({ calls: [1, 2, 3] }); // paused: 4…20 wait in the log, not in the table
  expect(rig.delivery.fanOutView("f")).toEqual({ pending: 3, paused: true });
  const admitted = () => new Set(rig.calls).size;
  for (let rung = 1; rung < 15; rung++) {
    const before = admitted();
    await rig.passAfterEveryRung(); // the retries, and ONE new event: the probe
    expect(admitted()).toBe(before + 1);
  }
  expect(rig.deadLetters().map((fact) => (fact.payload as { attempts: number }).attempts)).toEqual([
    15, 15, 15,
  ]);
  expect(rig.stream.coreReducedState.subscriptions.f.halted).toBeUndefined();
  down = false;
  await rig.passAfterEveryRung();
  expect(rig.acked.toSorted((a, b) => a - b)).toEqual(range(4, 20));
  expect(rig.delivery.fanOutView("f")).toEqual({ pending: 0, paused: false });
});

test("fan-out: an evaluation is reused until it expires; a pending retry keeps its rung until the target is re-pointed", async () => {
  let publication = 1;
  const options = { validForMs: 20, routeOf: (printed: string) => `${printed}@${publication}` };
  fakeClock();
  const start = Date.now();
  const first = fanOutRig({ behave: ({ n }) => (n === 1 ? "fail" : "ack"), options });
  first.pings(1);
  await drainDeliveries();
  const [pending] = first.records();
  expect(pending!.nextAttemptAtMs).toBeGreaterThan(Date.now() + 500);
  for (const [n, elapsed, evaluations] of [
    [2, 19, 1],
    [3, 20, 2],
  ] as const) {
    vi.setSystemTime(start + elapsed); // reused until the evaluation's 20 ms are up
    first.pings(n);
    await drainDeliveries();
    expect(first.evaluated.filter((printed) => printed === "itx.sink")).toHaveLength(evaluations);
  }
  expect(first.records()[0]).toEqual(pending); // re-evaluated where it resolved: its rung stands
  publication = 2; // re-pointed while the context slept: every pending delivery is due at once
  const next = fanOutRig({ previous: first, options });
  next.pings(4);
  await drainDeliveries();
  expect(next.acked.toSorted()).toEqual([1, 4]);
  expect(next.records()).toEqual([]);
});

test("fan-out: a row replaced while its predecessor's call was evaluating the target keeps its own bound: the old evaluation's answer touches nothing of the new row's", async () => {
  const evaluations: (() => void)[] = [];
  const calls: number[] = [];
  const rig = incarnation((printed) =>
    printed === "itx.sink"
      ? new Promise<void>((resolve) => evaluations.push(resolve)).then(() => ({
          // every call keeps its slot
          deliverEvent: (event: StreamEvent) => {
            calls.push(...ns([event]));
            return new Promise<never>(() => {});
          },
        }))
      : undefined,
  );
  configure(rig, { ...SINK_ROW, consumes: ["demo/ping"] });
  rig.stream.append({ type: "demo/ping", payload: { n: 1 } });
  await drainDeliveries();
  configure(rig, { ...SINK_ROW, consumes: ["demo/ping"] }); // over ping 1's evaluation
  rig.stream.append(...range(2, 9).map((n) => ({ type: "demo/ping", payload: { n } })));
  await drainDeliveries();
  evaluations.shift()!(); // the old row's answers first
  await drainDeliveries();
  for (const answer of evaluations.splice(0)) answer();
  await drainDeliveries();
  rig.stream.append(...range(10, 20).map((n) => ({ type: "demo/ping", payload: { n } })));
  await drainDeliveries();
  expect(calls).toEqual(range(2, 9));
});

test.for([
  { name: "its own table's refusal", refusedForMs: undefined },
  { name: "a refusal no snapshot bounds, `validUntil` Infinity", refusedForMs: Infinity },
  { name: "another context's snapshot's refusal", refusedForMs: 5_000 },
])(
  "fan-out: a row whose target resolves to nothing ($name) waits unspent, probes 15 times, never before the refusal expires, then waits for a commit",
  async ({ refusedForMs }) => {
    let provided = false;
    const rig = fanOutRig({ provided: () => provided, options: { refusedForMs } });
    rig.pings(1, 2);
    await drainDeliveries();
    expect(rig.records().map(({ attempt, nextAttemptAtMs }) => [attempt, nextAttemptAtMs])).toEqual(
      [
        [0, null],
        [0, null],
      ],
    );
    fakeClock();
    const probes: number[] = [];
    for (
      let probe = rig.delivery.deadlines()[0];
      probe && probes.length < 40;
      probe = rig.delivery.deadlines()[0]
    ) {
      probes.push(probe.at);
      vi.setSystemTime(probe.at + 1);
      await rig.pass();
      await drainDeliveries();
    }
    expect(probes).toHaveLength(15);
    expect(probes.at(-1)! - probes.at(-2)!).toBeGreaterThan(probes[1]! - probes[0]!); // backing off
    const gaps = probes.slice(1).map((at, i) => at - probes[i]!);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(
      Number.isFinite(refusedForMs) ? refusedForMs! : 0,
    );
    expect(rig).toMatchObject({ calls: [] });
    provided = true;
    rig.stream.append({ type: "demo/other" }); // any commit of its own tries it again
    await drainDeliveries();
    expect(rig.acked.toSorted()).toEqual([1, 2]);
    expect(rig.delivery.deadlines()).toEqual([]);
  },
);

test.for([
  { name: "the root's own table", refusedForMs: undefined },
  { name: "the root's snapshot, from another context", refusedForMs: 5_000 },
])(
  "fan-out: while the project's config is unpublished ($name refuses `itx.config`), the config row passes every event over — no record, no claim, no probe — and delivers from the commit that publishes it",
  async ({ refusedForMs }) => {
    let published = false;
    const told: string[] = [];
    const config = sink(told);
    const rig = incarnation(
      (printed) => (published && printed === CONFIG_HEAD ? config("itx.sink") : undefined),
      undefined,
      { refusedForMs, refusal: { unpublishedConfig: true } },
    );
    configure(rig, { name: "config", target: `${CONFIG_HEAD}.deliverEvent`, ordered: false });
    rig.stream.append({ type: "demo/ping", payload: { n: 1 } });
    rig.stream.append({ type: "demo/ping", payload: { n: 2 } });
    await drainDeliveries();
    expect({
      records: rig.stream.storage.listSubscriptionDeliveries(),
      deadlines: rig.delivery.deadlines(),
      armedAt: rig.coordinator.snapshot().armedAt,
    }).toEqual({ records: [], deadlines: [], armedAt: null });
    expect(rig.delivery.fanOutView("config")).toEqual({ pending: 0, paused: false });
    published = true;
    rig.stream.append({ type: "demo/published" });
    rig.stream.append({ type: "demo/ping", payload: { n: 3 } });
    await drainDeliveries();
    expect(told).toEqual(["demo/published", "demo/ping#3"]);
    expect(rig.delivery.deadlines()).toEqual([]);
  },
);

test("fan-out: the root's snapshot that refuses `itx.config` passes over only what was committed before its read: an event newer than the snapshot waits it out, and the publication since delivers it", async () => {
  fakeClock();
  let published = false;
  const told: string[] = [];
  const config = sink(told);
  // the snapshot lasts 1 s more: it was read 4 s ago (SNAPSHOT_TTL_MS 5 s), before the ping
  const rig = incarnation(
    (printed) => (published && printed === CONFIG_HEAD ? config("itx.sink") : undefined),
    undefined,
    { refusedForMs: 1_000, refusal: { unpublishedConfig: true } },
  );
  configure(rig, { name: "config", target: `${CONFIG_HEAD}.deliverEvent`, ordered: false });
  rig.stream.append({ type: "demo/ping", payload: { n: 1 } });
  await drainDeliveries();
  const [probe] = rig.delivery.deadlines();
  expect(probe!.at).toBeGreaterThanOrEqual(Date.now() + 1_000);
  published = true; // the root published after that read, before the ping
  vi.setSystemTime(probe!.at + 1);
  await rig.pass();
  await drainDeliveries();
  expect({ told, deadlines: rig.delivery.deadlines() }).toEqual({
    told: ["demo/ping#1"],
    deadlines: [],
  });
});

test("fan-out: a call rejected with no reason at all (`undefined`) climbs the ladder like any failure", async () => {
  const rig = incarnation((printed) =>
    printed === "itx.sink" ? { deliverEvent: () => Promise.reject(undefined) } : undefined,
  );
  configure(rig, { ...SINK_ROW, consumes: ["demo/ping"] });
  rig.stream.append({ type: "demo/ping", payload: { n: 1 } });
  await drainDeliveries();
  expect(rig.stream.storage.listSubscriptionDeliveries()).toMatchObject([
    ["f", { attempt: 1, leased: false }],
  ]);
});

test("fan-out: a call out claims the alarm while its time is ahead — a death mid-call is retried — and nothing once that time passes with the call still out, so it never spins the alarm; its settle tries it again", async () => {
  fakeClock(Date.now(), ["setTimeout", "clearTimeout"]);
  let answered = 0;
  const rig = fanOutRig({ behave: () => (answered++ === 0 ? "park" : "ack") });
  rig.pings(1);
  await drainDeliveries();
  const [lease] = rig.records();
  expect(rig.delivery.deadlines()).toMatchObject([{ at: lease!.nextAttemptAtMs }]);
  vi.advanceTimersByTime(20_000); // the watchdog gives up on the call; it is still out
  await drainDeliveries();
  const [rung] = rig.records();
  expect(rung).toMatchObject({ attempt: 1, leased: false });
  expect(rig.delivery.deadlines()).toMatchObject([{ at: rung!.nextAttemptAtMs }]);
  vi.setSystemTime(rung!.nextAttemptAtMs! + 1);
  const armed = rig.alarms.length;
  for (let pass = 0; pass < 3; pass++) {
    await rig.pass();
    await drainDeliveries();
  }
  expect({ deadlines: rig.delivery.deadlines(), armed: rig.alarms.length - armed }).toEqual({
    deadlines: [],
    armed: 0,
  });
  rig.settle(1);
  await drainDeliveries();
  expect({ acked: rig.acked, records: rig.records() }).toEqual({ acked: [1, 1], records: [] });
});

test("fan-out: a dangling row's records keep no time while the in-flight budget is full: they claim nothing, and the release tries them", async () => {
  let provided = false;
  const held: (() => void)[] = [];
  const rig = incarnation((printed) =>
    printed === "itx.big"
      ? { deliverEvent: () => new Promise<void>((resolve) => held.push(resolve)) }
      : printed === "itx.sink" && provided
        ? { deliverEvent: () => undefined }
        : undefined,
  );
  configure(rig, { ...SINK_ROW, consumes: ["demo/ping"] });
  configure(rig, {
    name: "big",
    target: "itx.big.deliverEvent",
    consumes: ["demo/big"],
    ordered: false,
  });
  const pad = "x".repeat(4096);
  for (const n of [1, 2]) rig.stream.append({ type: "demo/ping", payload: { n, pad } });
  await drainDeliveries();
  expect(rig.delivery.fanOutView("f")).toEqual({ pending: 2, paused: false });
  // one call out holds the whole budget
  rig.stream.append({ type: "demo/big", payload: { blob: "z".repeat(8 * MiB - 2_000) } });
  await drainDeliveries();
  expect(held).toHaveLength(1);
  rig.stream.append({ type: "demo/other" }); // a durable commit tries the dangling row again
  await drainDeliveries();
  expect(
    rig.stream.storage
      .listSubscriptionDeliveries()
      .filter(([name]) => name === "f")
      .map(([, record]) => record.nextAttemptAtMs),
  ).toEqual([null, null]);
  expect(rig.delivery.deadlines().filter(({ name }) => name === "f")).toEqual([]);
  provided = true;
  held.shift()!();
  await drainDeliveries();
  expect(rig.delivery.fanOutView("f")).toEqual({ pending: 0, paused: false });
});

test("fan-out, the loop rule: no fan-out row takes a dead letter or an ephemeral, through `*`, by name or by resume", async () => {
  const everything: string[] = [];
  const alerts: string[] = [];
  const rig = incarnation((printed) =>
    printed === "itx.everything"
      ? { deliverEvent: (event: StreamEvent) => void everything.push(event.type) }
      : printed === "itx.alerts"
        ? { deliverEvent: (event: StreamEvent) => void alerts.push(event.type) }
        : printed === "itx.poison"
          ? { deliverEvent: () => Promise.reject(codedError("PERMANENT_FAILURE", "never")) }
          : undefined,
  );
  for (const [name, consumes] of [
    ["everything", ["*"]],
    ["alerts", ["events.iterate.com/itx/subscription-delivery-failed"]],
    ["poison", ["demo/poison"]],
  ] as const)
    configure(rig, { name, target: `itx.${name}.deliverEvent`, consumes, ordered: false });
  rig.stream.append({ type: "demo/poison" });
  rig.stream.append({ type: "demo/ping", ephemeral: true });
  await drainDeliveries();
  const deadLetters = factsOf(rig, "events.iterate.com/itx/subscription-delivery-failed");
  expect(deadLetters.map((fact) => (fact.payload as { name: string }).name)).toEqual(["poison"]);
  expect(everything).toEqual([
    "events.iterate.com/itx/subscription-configured",
    "events.iterate.com/itx/subscription-configured",
    "demo/poison",
  ]);
  resume(rig, "alerts", deadLetters[0]!.offset); // an operator's resume naming the dead letter itself
  await drainDeliveries();
  expect(alerts).toEqual([]);
});

// Each admission turn is ONE transaction (its records and the cursor), and each ack deletes its record.
test("fan-out storage writes: 100 events answered in turn cost one turn of 8, then a turn per ack", async () => {
  const rig = fanOutRig({ behave: () => "park" });
  const transactions = vi.spyOn(rig.stream.storage, "transactionSync");
  const cursorWrites = vi.spyOn(rig.stream.storage, "writeSubscriptionCursor");
  const recordWrites = vi.spyOn(rig.stream.storage, "writeSubscriptionDelivery");
  const recordDeletes = vi.spyOn(rig.stream.storage, "deleteSubscriptionDelivery");
  rig.pings(...range(1, 100));
  await drainDeliveries();
  for (const n of range(1, 100)) {
    rig.settle(n);
    await drainDeliveries();
  }
  expect(rig.acked.toSorted((a, b) => a - b)).toEqual(range(1, 100));
  expect({
    transactions: transactions.mock.calls.length - 1, // the pings' own commit
    cursor: cursorWrites.mock.calls.length,
    records: recordWrites.mock.calls.length,
    deletes: recordDeletes.mock.calls.length,
  }).toEqual({ transactions: 93, cursor: 94, records: 100, deletes: 100 });
  expect(rig.delivery.cursor("f")).toMatchObject({ confirmedOffset: rig.head(), attempt: 0 });
  expect(rig.delivery.deadlines()).toEqual([]);
});

test("fan-out, the wake rule: a wake a death cut off mid-call is not delivered again; the event leased beside it is", async () => {
  const told: string[] = [];
  const hanging = sink(told, () => new Promise<void>(() => {}));
  const first = incarnation(hanging);
  configure(first, SINK_ROW);
  await drainDeliveries();
  const second = incarnation(hanging, first.storage); // its wake, then a ping, both in flight
  second.stream.append({ type: "demo/ping", payload: { n: 1 } });
  await drainDeliveries();
  expect(told).toEqual(["woken#2", "demo/ping#1"]);
  const [[, lease], ...none] = second.stream.storage.listSubscriptionDeliveries();
  expect(none).toEqual([]); // the wake has no lease
  told.length = 0;
  const third = incarnation(sink(told), second.storage, {
    wake: { cause: "alarm", due: ["retry"] },
  });
  fakeClock(lease!.nextAttemptAtMs! + 1);
  await third.pass();
  await drainDeliveries();
  expect(told.toSorted()).toEqual(["demo/ping#1", "woken#3"]);
});

test("fan-out, the wake rule: a resume naming a wake's offset delivers nothing, now or after an eviction", async () => {
  const told: string[] = [];
  const first = incarnation(sink(told));
  configure(first, SINK_ROW);
  await drainDeliveries();
  const second = incarnation(sink(told), first.storage);
  await drainDeliveries();
  resume(second, "f", factsOf(second, WOKEN).at(-1)!.offset);
  await drainDeliveries();
  incarnation(sink(told), second.storage);
  await drainDeliveries();
  expect(told).toEqual(["woken#2", "woken#3"]);
});

test("birth events: a fan-out row born from offset 0 delivers its own birth and every durable event after, once each", async () => {
  const told: string[] = [];
  const rig = incarnation(sink(told), undefined, {
    birthEvents: [configured({ ...SINK_ROW, name: "platform", afterOffset: 0 })],
  });
  await drainDeliveries();
  expect(told).toHaveLength(3);
  rig.stream.append({ type: "demo/ping", payload: { n: 1 } });
  await drainDeliveries();
  expect(told).toEqual([
    "events.iterate.com/itx/created",
    "woken#1",
    "events.iterate.com/itx/subscription-configured",
    "demo/ping#1",
  ]);
  expect(rig.delivery.cursor("platform")).toMatchObject({
    confirmedOffset: rig.stream.highestDurableOffset(),
    attempt: 0,
  });
  expect(rig.delivery.deadlines()).toEqual([]);
});

// ── the wake rule, as a property: random handlers over a simulated project ──

test.for(Array.from({ length: 200 }, (_, i) => ({ name: `world ${i + 1}`, seed: i + 1 })))(
  "fan-out, the wake rule and loop guard ($name): random handlers tell no wake twice, act at most 8 deep, go quiet",
  async ({ seed }) => {
    const world = randomHandlerWorld(seed);
    fakeClock(Date.parse("2035-01-01T00:00:00Z"));
    await world.run();
    // told of a wake at most once, and only of one the logs record (a row that could not take a
    // wake in its own incarnation is not told of it later: subscription-delivery.ts `fanOutAdmits`)
    expect(new Set(world.toldOf)).toHaveProperty("size", world.toldOf.length);
    expect(world.toldOf.filter((wake) => !world.wakes().includes(wake))).toEqual([]);
    // what code appended is never past the limit: only the platform's own facts are
    expect(world.deepestAct()).toBeLessThanOrEqual(8);
    expect(world.quiet()).toEqual({ awake: [], alarms: [], retries: [] });
  },
);

test("fan-out: an unreadable event is dead-lettered alone — the readable events on its page, before it and after, are delivered", async () => {
  const told: string[] = [];
  const rig = incarnation(sink(told));
  const [first, corrupt] = rig.stream.append(
    ...[1, 2, 3].map((n) => ({ type: "demo/ping", payload: { n } })),
  );
  rig.storage.sql.exec("UPDATE events SET body = 'not json' WHERE offset = ?", corrupt.offset);
  configure(rig, { ...SINK_ROW, consumes: ["demo/ping"], afterOffset: first.offset - 1 });
  await drainDeliveries();
  expect(told).toEqual(["demo/ping#1", "demo/ping#3"]);
  expect(
    rig.stream
      .read(corrupt.offset, 500)
      .events.filter(
        (event) => event.type === "events.iterate.com/itx/subscription-delivery-failed",
      ),
  ).toMatchObject([{ payload: { name: "f", offset: corrupt.offset, attempts: 0 } }]);
});

test("fan-out: a dead letter is written once per event, row and resume — a death between the dead letter and its record's removal replays the failure and appends nothing more, and an operator's resume that delivers it again is a window of its own", async () => {
  let error = "no";
  const first = fanOutRig({
    behave: ({ n }) => (n === 2 ? codedError("PERMANENT_FAILURE", error) : "park"),
  });
  const [, two] = first.pings(1, 2);
  await drainDeliveries();
  expect(first.deadLetters()).toHaveLength(1);
  // THE DEATH: the record's removal never became durable, and event 1 was still out
  first.stream.storage.writeSubscriptionDelivery("f", {
    offset: two.offset,
    attempt: 1,
    nextAttemptAtMs: Date.now(),
    leased: true,
    error: null,
  });
  error = "a different refusal";
  const second = fanOutRig({
    previous: first,
    behave: ({ n }) => (n === 2 ? codedError("PERMANENT_FAILURE", error) : "ack"),
  });
  await second.passAfterEveryRung();
  expect(second.calls.toSorted()).toEqual([1, 2]);
  expect(second.deadLetters()).toMatchObject([
    { payload: { name: "f", offset: two.offset, attempts: 1, error: "no" } },
  ]);
  expect(second.records()).toEqual([]);
  // AN OPERATOR'S RESUME delivers it again, a window of its own: refused again, dead-lettered again
  resume(second, "f", two.offset);
  await drainDeliveries();
  expect(second.deadLetters()).toMatchObject([
    { payload: { offset: two.offset, error: "no" } },
    { payload: { offset: two.offset, attempts: 1, error: "a different refusal" } },
  ]);
});

test("fan-out, the wake rule: a wake handler appending work that fails climbs one hop a lap, stops at 8, goes quiet", async () => {
  const told: string[] = [];
  let current: ReturnType<typeof incarnation> | undefined;
  const handler = sink(told, (event) => {
    if (event.type === WOKEN) current!.stream.append({ type: "test/work" });
    if (event.type === "test/work") throw new Error("the work fails");
  });
  current = incarnation(handler);
  configure(current, SINK_ROW);
  await drainDeliveries();
  current = incarnation(handler, current.storage); // one organic wake: its handler appends the first work
  await drainDeliveries();
  fakeClock();
  for (let laps = 0; laps < 2_000 && current.delivery.deadlines()[0]; laps++) {
    vi.setSystemTime(current.delivery.deadlines()[0]!.at + 1);
    current = incarnation(handler, current.storage, { wake: { cause: "alarm", due: ["retry"] } });
    await drainDeliveries();
    await current.pass();
    await drainDeliveries();
  }
  expect(current.delivery.deadlines()).toEqual([]);
  // Later climbs start lower: once the row acks its own `itx/loop-limit` fact (a success, which
  // lifts its pause), and whenever its last record dead-letters (nothing owed). How often is up to
  // the ladder's jitter, so the depth is bounded and the number of works is not.
  const depths = factsOf(current, "test/work").map((event) => event.source!.cause!.depth);
  expect(depths.slice(0, 8)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(Math.max(...depths)).toBe(8);
  expect(factsOf(current, "events.iterate.com/itx/loop-limit")).toMatchObject([
    { payload: { depth: 9 } },
  ]);
  expect(told.filter((label) => label.startsWith("woken#")).length).toBeLessThan(60);
});

// The row above with `Math.random` seeded, which the retry ladder's jitter draws from. This draw
// restarts the climb at depth 2 after the loop-limit ack, and at depth 4 when the last record
// dead-letters: [1..8, 2..8, 4..8], 20 works, which about 1 unseeded run in 140 reaches.
test("fan-out, the wake rule, seeded: a jitter draw that restarts the climb twice still stops at 8, goes quiet", async () => {
  const told: string[] = [];
  vi.spyOn(Math, "random").mockImplementation(mulberry32(185));
  let current: ReturnType<typeof incarnation> | undefined;
  const handler = sink(told, (event) => {
    if (event.type === WOKEN) current!.stream.append({ type: "test/work" });
    if (event.type === "test/work") throw new Error("the work fails");
  });
  current = incarnation(handler);
  configure(current, SINK_ROW);
  await drainDeliveries();
  current = incarnation(handler, current.storage);
  await drainDeliveries();
  fakeClock();
  for (let laps = 0; laps < 2_000 && current.delivery.deadlines()[0]; laps++) {
    vi.setSystemTime(current.delivery.deadlines()[0]!.at + 1);
    current = incarnation(handler, current.storage, { wake: { cause: "alarm", due: ["retry"] } });
    await drainDeliveries();
    await current.pass();
    await drainDeliveries();
  }
  expect(current.delivery.deadlines()).toEqual([]);
  const depths = factsOf(current, "test/work").map((event) => event.source!.cause!.depth);
  expect(depths.slice(0, 8)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(Math.max(...depths)).toBe(8);
  expect(factsOf(current, "events.iterate.com/itx/loop-limit")).toMatchObject([
    { payload: { depth: 9 } },
  ]);
  expect(told.filter((label) => label.startsWith("woken#")).length).toBeLessThan(60);
});

function nextMacrotask() {
  return new Promise((r) => setImmediate(r));
}

/** Let every fire-and-forget hop of a delivery land: each hop is a microtask chain (the loop has no
 *  timers of its own), so a handful of macrotask turns drains them all. */
async function drainDeliveries() {
  for (let i = 0; i < 20; i++) await nextMacrotask();
}

/** ONE INCARNATION of the delivery loop over `storage`: a Stream — woken as the DO wakes it — whose
 *  commit hook is the real SubscriptionDelivery. `resolve(printedExpression)` is the context's
 *  dispatch: the value an expression names, or `undefined` to default-deny exactly as the resolver
 *  does; `evaluated` records every expression the loop asked for. Pass a previous incarnation's
 *  storage to build THE NEXT ONE over it: a fresh Stream and a fresh loop that find the rows, the
 *  log, the kv and the cursor table — and nothing in memory. That is an eviction, deterministically.
 *  The DO's alarm is stood in for by a real coordinator over the loop's `deadlines()`, wired as the
 *  DO wires it (every commit and every change the loop reports reconciles): `alarms` is every instant
 *  it armed, `deletes` every deletion, `pass(work)` an alarm pass. */
function incarnation(
  resolve: (printedExpression: string) => unknown,
  storage: DurableObjectStorageSlice = nodeSqliteDurableObjectStorage(),
  {
    validForMs = Infinity,
    routeOf = (printed) => printed,
    refusedForMs,
    refusal = {},
    wake = { cause: "call", caller: "other" },
    birthEvents = [],
    deployId,
  }: {
    /** How long an evaluation may be reused: the lifetime of the snapshot it was read through. */
    validForMs?: number;
    /** Where an expression resolved (the resolver's `routedTo`): what moves when a rule re-points. */
    routeOf?: (printedExpression: string) => string;
    /** A refusal came from another context's snapshot, which lasts this long (its `validUntil`). */
    refusedForMs?: number;
    /** What else a refusal says, as the resolver marks it (`unpublishedConfig`). */
    refusal?: Record<string, unknown>;
    /** Why this incarnation woke, as the DO's first handler records it. */
    wake?: Wake;
    /** What the context is born with (app-config.ts `contextBirthEvents`). */
    birthEvents?: StreamEventInput[];
    /** The deploy this incarnation runs as (a lease names it). */
    deployId?: string;
  } = {},
) {
  const alarms: number[] = [];
  const deletes: number[] = [];
  const evaluated: string[] = [];
  /** Every reset the loop asked for (`abortIncarnation`): a test builds the next incarnation. */
  const aborts: string[] = [];
  let delivery!: SubscriptionDelivery;
  const coordinator = new AlarmCoordinator({
    setAlarm: async (at) => void alarms.push(at),
    deleteAlarm: async () => void deletes.push(1),
    deadlines: () => [delivery.deadlines()[0]?.at ?? null],
    held: () => false,
    onOverdue: () => {},
  });
  const stream = new Stream({
    storage,
    path: "/",
    projectId: "prj_delivery",
    birthEvents,
    deployId,
    cause: () => causes.getStore(),
    onCommit: (fresh, after, through) => {
      delivery.onCommit(fresh, after, through);
      coordinator.reconcile();
    },
  });
  delivery = new SubscriptionDelivery({
    stream,
    evaluateItxExpression: async (expression: ItxExpression) => {
      const printed = print(expression);
      evaluated.push(printed);
      const value = await resolve(printed);
      if (value === undefined)
        throw Object.assign(
          codedError(
            "NO_ITX_EXPRESSION_MATCH",
            `no rewrite rule matches ${JSON.stringify(printed)} (default-deny)`,
          ),
          refusedForMs === undefined ? {} : { validUntil: Date.now() + refusedForMs },
          refusal,
        );
      return { value, validUntil: Date.now() + validForMs, routedTo: routeOf(printed) };
    },
    // The facet host's platform entries (context/facet-host.ts), stood in for by each fake
    // FacetHandle's own walk: what a test's facet records is what the facet host would call.
    pushEventBatchToFacet: async (facetHandle, events, range) =>
      facetHandle.invoke([["processEventBatch", events, range]]),
    catchUpFacetFromLog: async (facetHandle) => facetHandle.invoke([["catchUpFromLog"]]),
    reconcileAlarm: () => coordinator.reconcile(),
    // as the DO runs a delivery: one hand-off deeper than what it delivers (cause.ts)
    runAsDelivery: (events, call) => causes.run(causeOfDelivery(events), call),
    abortIncarnation: (reason) => void aborts.push(reason),
  });
  // created + woken on a fresh store, the wake alone on one with rows, as the DO's first handler
  // records it — an alarm's caused by the deepest delivery it came back for
  stream.appendWakeRecord(
    wake,
    wake.cause === "alarm" ? delivery.owedCause(Date.now()) : causes.getStore(),
  );
  return {
    storage,
    stream,
    delivery,
    coordinator,
    alarms,
    deletes,
    evaluated,
    aborts,
    /** An alarm pass, as the DO runs it: the stream-kept cursors under the coordinator's hold. */
    pass: () => coordinator.pass(() => delivery.deliverEveryCursorSubscription()),
  };
}

/** A stream with ONE facet subscription (`slow`, `consumes: ["blob"]`) whose facet answers only when
 *  the test releases it: every call to the facet parks until `release()`. Pass a previous rig to
 *  construct THE NEXT INCARNATION over its store, the row already configured. */
function stuckFacetRig(previous?: { storage: DurableObjectStorageSlice }) {
  /** Every method called on the facet, in order. */
  const facetMethods: string[] = [];
  const pushes: { events: StreamEvent[]; range: ScannedRange }[] = [];
  const parked: (() => void)[] = [];
  let holding = true;
  const rig = incarnation(
    () =>
      new FacetHandle((steps) => {
        const [call] = steps;
        facetMethods.push(Array.isArray(call) ? call[0] : call);
        if (Array.isArray(call) && call[0] === "processEventBatch")
          pushes.push({ events: call[1] as StreamEvent[], range: call[2] as ScannedRange });
        return holding ? new Promise<void>((resolve) => parked.push(resolve)) : Promise.resolve();
      }),
    previous?.storage,
  );
  const configuredAtOffset = previous
    ? rig.stream.coreReducedState.subscriptions.slow.configuredAtOffset
    : configure(rig, { name: "slow", target: facetTarget("slow"), consumes: ["blob"] })[0].offset;
  /** `count` durable 1 MiB `blob` events, one commit each; returns their offsets. */
  const commitBlobs = (count: number): number[] =>
    Array.from({ length: count }, (_, i) => {
      const [event] = rig.stream.append({
        type: "blob",
        payload: { i, blob: "x".repeat(1 * MiB) },
      });
      return event.offset;
    });
  return {
    ...rig,
    facetMethods,
    pushes,
    commitBlobs,
    configuredAtOffset,
    release: async () => {
      holding = false;
      for (const resolve of parked.splice(0)) resolve();
      await drainDeliveries();
    },
  };
}

function blobIndexes(push: { events: StreamEvent[] }) {
  return push.events.map((event) => (event.payload as { i: number }).i);
}

/** Every halted fact in the log for `name` — the audit trail an operator reads. */
function haltFactsFor(stream: Stream, name: string): StreamEvent[] {
  return stream
    .read(0, 500)
    .events.filter(
      (e) =>
        e.type === "events.iterate.com/itx/subscription-delivery-halted" &&
        (e.payload as { name: string }).name === name,
    );
}

function facetTarget(name: string): ItxExpression {
  return ["itx", "facets", ["get", name], "processEventBatch"];
}

/** The `n` of each delivered event — what a sink saw, in order. */
function ns(events: { payload?: { n?: number } }[]) {
  return events.map((e) => e.payload?.n ?? -1);
}

/** A cursor row `s` on `itx.sink.push` whose sink refuses while `mode` is `throw`; every delivery
 *  it takes is recorded with its range. */
function refusingSinkRig(previous?: { storage: DurableObjectStorageSlice }) {
  const modeRef = { mode: "deliver" as "deliver" | "throw" };
  const pushes: { events: number[]; range: ScannedRange }[] = [];
  const rig = incarnation(
    (printed) =>
      printed === "itx.sink"
        ? {
            push: (events: { payload?: { n?: number } }[], range: ScannedRange) => {
              if (modeRef.mode === "throw") throw new Error("sink down");
              pushes.push({ events: ns(events), range });
            },
          }
        : undefined,
    previous?.storage,
  );
  if (!previous) configure(rig, { name: "s", target: "itx.sink.push", consumes: ["demo/ping"] });
  return { ...rig, pushes, modeRef };
}

/** A cursor row `s` on `itx.sink.push`, whose pushes park until released (each call resolves in
 *  order); `durable` commits one `demo/ping`. */
function parkedSinkRig(previous?: { storage: DurableObjectStorageSlice }) {
  const parked: (() => void)[] = [];
  const pushes: number[][] = [];
  const rig = incarnation(
    (printed) =>
      printed === "itx.sink"
        ? {
            push: (events: { payload?: { n?: number } }[]) => {
              pushes.push(ns(events));
              return new Promise<void>((resolve) => parked.push(resolve));
            },
          }
        : undefined,
    previous?.storage,
  );
  if (!previous) configure(rig, { name: "s", target: "itx.sink.push", consumes: ["demo/ping"] });
  const release = async () => {
    parked.splice(0).forEach((resolve) => resolve());
    await drainDeliveries();
  };
  return { ...rig, pushes, release };
}

/** A FAN-OUT row `f` on `itx.sink.deliverEvent` (`consumes: ["demo/ping"]`): its sink answers ping
 *  `n` as `behave` says (ack, fail, park until `settle(n)`, or throw); `previous` rigs the next incarnation. */
function fanOutRig({
  behave = () => "ack",
  previous,
  provided = () => true,
  evaluation,
  options,
}: {
  behave?: (call: { n: number }) => "ack" | "fail" | "park" | Error;
  previous?: { storage: DurableObjectStorageSlice };
  /** false: `itx.sink` resolves to nothing. */
  provided?: () => boolean;
  /** "hangs": `itx.sink`'s evaluation never resolves. */
  evaluation?: "hangs";
  /** The evaluation's lifetime, where it resolved and what a refusal says (`incarnation`). */
  options?: Parameters<typeof incarnation>[2];
}) {
  /** Every call the sink took, by `n`, in order. */
  const calls: number[] = [];
  /** Every call the sink answered, by `n`, in order. */
  const acked: number[] = [];
  const parked = new Map<number, (() => void)[]>();
  const rig = incarnation(
    (printed) =>
      printed !== "itx.sink" || !provided()
        ? undefined
        : evaluation === "hangs"
          ? new Promise<never>(() => {})
          : {
              deliverEvent: (event: StreamEvent) => {
                const { n } = event.payload as { n: number };
                calls.push(n);
                const outcome = behave({ n });
                if (outcome instanceof Error) throw outcome;
                if (outcome === "fail") throw new Error(`the sink refused ${n}`);
                if (outcome === "ack") return void acked.push(n);
                return new Promise<void>((resolve) =>
                  parked.set(n, [
                    ...(parked.get(n) ?? []),
                    () => {
                      acked.push(n);
                      resolve();
                    },
                  ]),
                );
              },
            },
    previous?.storage,
    options,
  );
  if (!previous) configure(rig, { ...SINK_ROW, consumes: ["demo/ping"] });
  const records = () =>
    rig.stream.storage
      .listSubscriptionDeliveries()
      .map(([, retry]) => retry)
      .sort((a, b) => a.offset - b.offset);
  const log = () => rig.stream.read(0, 1000).events;
  return {
    ...rig,
    calls,
    acked,
    /** One commit of `demo/ping`s, one per `n`. */
    pings: (...ns: number[]) =>
      rig.stream.append(...ns.map((n) => ({ type: "demo/ping", payload: { n } }))),
    /** The oldest parked call of ping `n` answers. */
    settle: (n: number) => parked.get(n)?.shift()?.(),
    records,
    deadLetters: () =>
      log().filter((event) => event.type === "events.iterate.com/itx/subscription-delivery-failed"),
    offsetOf: (n: number) =>
      log().find((event) => event.type === "demo/ping" && (event.payload as { n: number }).n === n)!
        .offset,
    head: () => rig.stream.highestDurableOffset(),
    /** An alarm pass once every pending retry and the row's own probe are due, and whatever it
     *  starts drained. */
    passAfterEveryRung: async () => {
      const due = Math.max(Date.now(), ...rig.delivery.deadlines().map(({ at }) => at));
      vi.useFakeTimers({ now: due + 1, toFake: ["Date"] });
      try {
        await rig.pass();
        await drainDeliveries();
      } finally {
        vi.useRealTimers();
      }
    },
  };
}

/** `from` through `to`, inclusive. */
function range(from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

const WOKEN = "events.iterate.com/itx/woken";

/** A fan-out row on every durable event, one call each, to `itx.sink.deliverEvent`. */
const SINK_ROW = { name: "f", target: "itx.sink.deliverEvent", ordered: false };

/** The config birth row's target head (../project/context-birth-events.ts), as printed. */
const CONFIG_HEAD = "itx.builtins.cd('/').config";

/** A subscription row as the context's append normalizes it. */
function configured(payload: Record<string, unknown>, path = "/") {
  return normalizeControlEvent(
    { type: "events.iterate.com/itx/subscription-configured", payload },
    path,
  );
}

/** Configure a row on `rig`'s stream: the events the append committed. */
function configure(rig: { stream: Stream }, payload: Record<string, unknown>) {
  return rig.stream.append(configured(payload));
}

/** An operator's resume of row `name`; with `offset`, of that one event again. */
function resume(rig: { stream: Stream }, name: string, offset?: number) {
  return rig.stream.append(
    normalizeControlEvent(
      { type: "events.iterate.com/itx/subscription-delivery-resumed", payload: { name, offset } },
      "/",
    ),
  );
}

/** `itx.sink`, whose `deliverEvent` records each event in `told` (a wake as `woken#<incarnation>`,
 *  a ping as `demo/ping#<n>`) and answers as `onEvent` does. */
function sink(told: string[], onEvent: (event: StreamEvent) => unknown = () => undefined) {
  return (printed: string) =>
    printed === "itx.sink"
      ? {
          deliverEvent: (event: StreamEvent) => {
            const { incarnation, n } = (event.payload || {}) as {
              incarnation?: number;
              n?: number;
            };
            told.push(
              event.type === WOKEN
                ? `woken#${incarnation}`
                : n === undefined
                  ? event.type
                  : `${event.type}#${n}`,
            );
            return onEvent(event);
          },
        }
      : undefined;
}

/** A cursor row's target that records the `n`s of each batch it is pushed into `into`. */
function pushSink(into: number[][]) {
  return { push: (events: { payload?: { n?: number } }[]) => void into.push(ns(events)) };
}

/** Date (and `also`) faked from `now` until the test finishes. */
function fakeClock(now = Date.now(), also: ("setTimeout" | "clearTimeout")[] = []) {
  vi.useFakeTimers({ now, toFake: ["Date", ...also] });
  onTestFinished(() => void vi.useRealTimers());
}

/** Every event of `type` in `rig`'s log. */
function factsOf(rig: { stream: Stream }, type: string) {
  return rig.stream.read(0, 1000).events.filter((event) => event.type === type);
}

/** A SIMULATED PROJECT: five contexts, each with a `*` fan-out row from the whole log to a seeded
 *  handler that touches, appends to and fails on random contexts, with no bound but the loop guard's;
 *  a context idle 500 ms (before any retry's rung) is evicted, and the alarm it left wakes a fresh one.
 *  `toldOf` is every wake a handler was told of, `wakes()` every wake the logs record. */
function randomHandlerWorld(seed: number) {
  const random = mulberry32(seed);
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
  const paths = ["/", "/a", "/b", "/c", "/d"] as const;
  const contexts = new Map<
    string,
    {
      storage: DurableObjectStorageSlice;
      born: boolean;
      rig?: ReturnType<typeof incarnation>;
      alarm: number | null;
      lastActivityAt: number;
    }
  >(
    paths.map((path) => [
      path,
      { storage: nodeSqliteDurableObjectStorage(), born: false, alarm: null, lastActivityAt: 0 },
    ]),
  );
  const toldOf: string[] = [];
  /** A call reaching `path`: the running incarnation, or a fresh one it wakes. */
  const reach = (path: string, wake: Wake) => {
    const context = contexts.get(path)!;
    context.lastActivityAt = Date.now();
    if (context.rig) return context.rig;
    // a call past the loop limit wakes nothing: it throws, and the context sleeps on
    context.rig = incarnation(
      (printed) => (printed === "itx.handler" ? { deliverEvent: handler(path) } : undefined),
      context.storage,
      { wake },
    );
    if (!context.born) {
      context.born = true;
      // what a deployment's birth events append: the row, from the whole log
      context.rig.stream.append(
        configured(
          { name: "config", target: "itx.handler.deliverEvent", afterOffset: 0, ordered: false },
          path,
        ),
      );
    }
    return context.rig;
  };
  const handler = (path: string) => (event: StreamEvent) => {
    contexts.get(path)!.lastActivityAt = Date.now();
    if (event.type === "events.iterate.com/itx/woken")
      toldOf.push(`${path}#${(event.payload as { incarnation: number }).incarnation}`);
    for (let actions = Math.floor(random() * 3); actions > 0; actions--) {
      const rig = reach(pick(paths), { cause: "call", caller: "loaded" });
      if (random() < 0.4) rig.stream.append({ type: "test/echo" });
    }
    const failure = random();
    if (failure < 0.02) throw codedError("PERMANENT_FAILURE", "this handler gives up on it");
    if (failure < 0.3) throw new Error("this handler failed this time");
  };
  const organicCalls = Array.from({ length: 6 }, () => ({
    at: Date.parse("2035-01-01T00:00:00Z") + Math.floor(random() * 60_000),
    path: pick(paths),
    caller: pick(["other", "context"] as const),
  })).sort((a, b) => a.at - b.at);
  return {
    toldOf,
    /** Every organic call, then whatever follows — deliveries, evictions, alarms — in time order,
     *  until nothing is left to happen. */
    async run() {
      for (let step = 0; step < 10_000; step++) {
        await drainDeliveries();
        const next = [
          ...organicCalls
            .slice(0, 1)
            .map((call) => ({ at: call.at, kind: "organic" as const, path: call.path })),
          ...[...contexts].flatMap(([path, context]) => {
            const alarm = context.rig ? context.rig.coordinator.snapshot().armedAt : context.alarm;
            return [
              ...(alarm === null ? [] : [{ at: alarm, kind: "alarm" as const, path }]),
              ...(context.rig
                ? [{ at: context.lastActivityAt + 500, kind: "evict" as const, path }]
                : []),
            ];
          }),
        ].sort((a, b) => a.at - b.at)[0];
        if (!next) return;
        vi.setSystemTime(Math.max(Date.now(), next.at));
        const context = contexts.get(next.path)!;
        if (next.kind === "organic") {
          const call = organicCalls.shift()!;
          reach(call.path, { cause: "call", caller: call.caller }).stream.append({
            type: "test/organic",
          });
        } else if (next.kind === "evict") {
          context.alarm = context.rig!.coordinator.snapshot().armedAt;
          context.rig = undefined;
        } else {
          context.alarm = null;
          await reach(next.path, { cause: "alarm", due: ["retry"] }).pass();
        }
      }
      throw new Error(`seed ${seed}: still busy after 10,000 steps`);
    },
    /** Every wake the logs record. */
    wakes: () =>
      [...contexts].flatMap(([path, context]) =>
        context.born
          ? context.storage.sql
              .exec<{ body: string }>("SELECT body FROM events ORDER BY offset")
              .toArray()
              .map((row) => JSON.parse(row.body) as StreamEvent)
              .filter((event) => event.type === "events.iterate.com/itx/woken")
              .map((event) => `${path}#${(event.payload as { incarnation: number }).incarnation}`)
          : [],
      ),
    /** The deepest cause of anything code appended — every event but the platform's own facts. */
    deepestAct: () =>
      Math.max(
        0,
        ...[...contexts].flatMap(([, context]) =>
          context.born
            ? context.storage.sql
                .exec<{ body: string }>("SELECT body FROM events")
                .toArray()
                .map((row) => JSON.parse(row.body) as StreamEvent)
                .filter((event) => event.type.startsWith("test/"))
                .map((event) => event.source!.cause!.depth)
            : [],
        ),
      ),
    /** What is left: contexts still awake, alarms stored, retries pending. */
    quiet: () => ({
      awake: [...contexts].filter(([, context]) => context.rig).map(([path]) => path),
      alarms: [...contexts].filter(([, context]) => context.alarm !== null).map(([path]) => path),
      retries: [...contexts].flatMap(([path, context]) =>
        context.born
          ? context.storage.sql
              .exec<{ offset: number }>("SELECT offset FROM subscription_deliveries")
              .toArray()
              .map((row) => `${path}@${row.offset}`)
          : [],
      ),
    }),
  };
}

/** A small seeded PRNG (mulberry32): one seed, one sequence, on any machine. */
function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

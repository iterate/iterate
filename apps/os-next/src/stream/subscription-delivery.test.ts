/// <reference types="node" />
// subscription-delivery.test.ts — the one delivery loop in node over the real Stream (node:sqlite
// storage), `evaluateItxExpression` standing in for the context's dispatch:
//   • THE PENDING-PUSH BOUND: commits that land while a delivery is in flight FOLD into one pending
//     push; past PENDING_PUSHES_TOTAL_BUDGET_CHARS the oldest events are dropped and the push's `after`
//     moves up to the last dropped offset — the gap a facet's own repair reads from the log. The
//     memory half (200 × 1 MiB behind a stuck facet survives a 128 MiB budget) is
//     memory-budget.test.ts's row; this file is the semantics.
//   • A RESUME wakes a halted facet row NOW, on the incarnation that halted it or a fresh one: the
//     resume classifies the row by evaluating its target, never by what this incarnation remembers.
//   • THE CURSOR LANE across an eviction and a replace: the alarm's ROW-driven pass recovers a first
//     delivery an eviction interrupted, a row replaced mid-delivery delivers to the NEW target, and a
//     two-step target (`itx.<alias>`, the spelling every `provide` mints) is the callee itself.
//   • HALT ONCE, FOR THE RIGHT ROW (v4 §2.3): a push queued behind a delivery never lands on a row
//     that halted meanwhile; a facet catch-up refused for good halts the row like a push's refusal;
//     a push and a resume's catch-up seeing the same refusal append ONE fact; a refusal of a call
//     made for a row since replaced halts nothing.
//   • `subscribe({ afterOffset })`: the cursor is born where the row asked (0 = the whole log) and
//     the configure is its wake — history is delivered now; the push lane is unaffected.
//   • THE CURSOR LANE'S READ RESERVATION is never re-acquired while held: a page whose events
//     serialize past it (a body near the ceiling plus its envelope) is delivered, and the other
//     cursor rows keep flowing.
//   • A rule RE-POINT re-classifies: a facet row re-pointed at a cursor target leaves the push set,
//     so the alarm's pass retries its ladder.
//   • A SUPERSEDED evaluation (the row replaced while its target evaluated) can neither classify nor
//     invoke its replacement.

import { describe, expect, test, vi } from "vitest";
import {
  print,
  registerPipelinedRpcBrand,
  type ItxExpression,
  FacetHandle,
} from "../context/expression.ts";
import { codedError } from "../lib.ts";
import { AlarmCoordinator } from "../alarm-coordinator.ts";
import type { StreamEvent, ScannedRange } from "./processor.ts";
import { nodeSqliteDurableObjectStorage } from "./test-support.ts";
import { Stream, type DurableObjectStorageSlice } from "./stream.ts";
import { SubscriptionDelivery } from "./subscription-delivery.ts";
import { normalizeControlEvent } from "./core-processor.ts";

const MiB = 1024 * 1024;
const settle = () => new Promise((r) => setImmediate(r));
/** Let every fire-and-forget hop of a delivery land: each hop is a microtask chain (the loop has no
 *  timers of its own), so a handful of macrotask turns drains them all. */
const settled = async () => {
  for (let i = 0; i < 20; i++) await settle();
};

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
) {
  const alarms: number[] = [];
  const deletes: number[] = [];
  const evaluated: string[] = [];
  let delivery!: SubscriptionDelivery;
  const coordinator = new AlarmCoordinator({
    setAlarm: async (at) => void alarms.push(at),
    deleteAlarm: async () => void deletes.push(1),
    deadlines: () => [delivery.deadlines()[0]?.at ?? null],
  });
  const stream = new Stream({
    storage,
    path: "/",
    projectId: "prj_delivery",
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
      const value = resolve(printed);
      if (value === undefined)
        throw codedError(
          "NO_ITX_EXPRESSION_MATCH",
          `no rewrite rule matches ${JSON.stringify(printed)} (default-deny)`,
        );
      return value;
    },
    recordActivityForQuietClock: () => {},
    reconcileAlarm: () => coordinator.reconcile(),
  });
  stream.appendCreatedAndWokenEvents();
  return {
    storage,
    stream,
    delivery,
    coordinator,
    alarms,
    deletes,
    evaluated,
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
    : rig.stream.append(
        normalizeControlEvent({
          type: "events.iterate.com/stream/subscription-configured",
          payload: {
            name: "slow",
            target: ["itx", "facets", ["get", "slow"], "processEventBatch"],
            consumes: ["blob"],
          },
        }),
      )[0].offset;
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
      await settled();
    },
  };
}

const blobIndexes = (push: { events: StreamEvent[] }) =>
  push.events.map((event) => (event.payload as { i: number }).i);

describe("the pending push is bounded", () => {
  test("control: under the budget, commits behind an in-flight delivery fold into ONE push, in order, ranging from the first commit", async () => {
    const rig = stuckFacetRig();
    await settle(); // the materialization (catchUpFromLog) parks — the chain's head
    const offsets = rig.commitBlobs(4);
    await rig.release();
    expect(rig.pushes).toHaveLength(1);
    expect(blobIndexes(rig.pushes[0])).toEqual([0, 1, 2, 3]);
    // A row's first push ranges from its first commit's afterOffset (the span since the row's
    // configuration — here one ephemeral core delta — is the facet's own gap repair to read).
    expect(rig.pushes[0].range).toEqual({ after: offsets[0] - 1, through: offsets[3] });
    expect(rig.pushes[0].range.after).toBeGreaterThan(rig.configuredAtOffset);
  });

  test("over the budget, the OLDEST events are dropped and the push's `after` moves up to the last dropped offset", async () => {
    const rig = stuckFacetRig();
    await settle();
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
    expect(rig.pushes[0].range).toEqual({ after: offsets[delivered[0] - 1], through: offsets[11] });
  });
});

describe("an operator's resume wakes a halted FACET row now — the facet catches up from the log itself", () => {
  test.each([
    { incarnation: "the incarnation that halted it", evicted: false },
    { incarnation: "a FRESH incarnation (evicted between the halt and the resume)", evicted: true },
  ])("on $incarnation: ONE catchUpFromLog, no cursor", async ({ evicted }) => {
    const first = stuckFacetRig();
    await first.release(); // materialized
    first.stream.append({
      type: "events.iterate.com/stream/subscription-delivery-halted",
      payload: { name: "slow", afterOffset: first.configuredAtOffset, attempts: 1, error: "halt" },
    });
    first.commitBlobs(1); // lands on a halted row: undelivered until the operator resumes it
    await settle();
    const rig = evicted ? stuckFacetRig(first) : first;
    await settle();
    if (evicted) expect(rig.facetMethods).toEqual([]); // the wake does not wake a halted row
    const before = rig.facetMethods.length;
    rig.stream.append({
      type: "events.iterate.com/stream/subscription-delivery-resumed",
      payload: { name: "slow" },
    });
    await rig.release();
    expect(rig.facetMethods.slice(before)).toEqual(["catchUpFromLog"]);
    expect(rig.stream.coreReducedState.subscriptions.slow.halted).toBeUndefined();
    expect(rig.delivery.cursor("slow")).toBeUndefined(); // a facet owns its progress — never this lane's
  });
});

const HALTED = "events.iterate.com/stream/subscription-delivery-halted";
const RESUMED = "events.iterate.com/stream/subscription-delivery-resumed";
/** Every halted fact in the log for `name` — the audit trail an operator reads. */
const haltFactsFor = (stream: Stream, name: string): StreamEvent[] =>
  stream
    .read(0, 500)
    .events.filter((e) => e.type === HALTED && (e.payload as { name: string }).name === name);
const facetTarget = (name: string): ItxExpression => [
  "itx",
  "facets",
  ["get", name],
  "processEventBatch",
];

describe("halt once, for the right row", () => {
  test("a push queued behind an in-flight delivery is NOT delivered to a row that halted meanwhile", async () => {
    const rig = stuckFacetRig();
    await settle(); // the materialization (catchUpFromLog) parks — the chain's head
    rig.commitBlobs(1); // queued behind it
    rig.stream.append({
      type: HALTED,
      payload: { name: "slow", afterOffset: rig.configuredAtOffset, attempts: 1, error: "halt" },
    });
    await rig.release();
    expect(rig.facetMethods).toEqual(["catchUpFromLog"]); // the queued push never reached the facet
    expect(rig.pushes).toEqual([]);
  });

  test("a facet catch-up refused for good (retryable: false — a latched checkpoint) HALTS the row at once, ONE fact; on a resume, the catch-up and the resumed event's push see the same refusal and append ONE more fact, not two", async () => {
    const latched = Object.assign(new Error("checkpoint latched"), { retryable: false });
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
    rig.stream.append(
      normalizeControlEvent({
        type: "events.iterate.com/stream/subscription-configured",
        payload: { name: "poison", target: facetTarget("poison") },
      }),
    );
    await settled();
    expect(rig.stream.coreReducedState.subscriptions.poison.halted).toMatchObject({
      attempts: 1,
      error: "checkpoint latched",
    });
    expect(haltFactsFor(rig.stream, "poison")).toHaveLength(1);
    expect(facetMethods).toEqual(["catchUpFromLog"]); // the configure's own push found the row halted
    rig.stream.append({ type: RESUMED, payload: { name: "poison" } });
    await settled();
    expect(facetMethods.slice(1).sort()).toEqual(["catchUpFromLog", "processEventBatch"]); // both refused …
    expect(haltFactsFor(rig.stream, "poison")).toHaveLength(2); // … one fact between them
    expect(rig.stream.coreReducedState.subscriptions.poison.halted).toBeDefined();
  });

  test("a push answered with a PIPELINED refusal (a sibling hop's FORBIDDEN) is settled before it is released — the row halts, the batch is never acked as delivered", async () => {
    // On workerd a call on a sibling context answers with a branded promise the step walk hands back
    // UNAWAITED (expression.ts). Before the delivery loop settled it, the branded rejection was
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
    rig.stream.append(
      normalizeControlEvent({
        type: "events.iterate.com/stream/subscription-configured",
        payload: { name: "laundered", target: facetTarget("laundered") },
      }),
    );
    await settled();
    expect(facetMethods).toEqual(["catchUpFromLog", "processEventBatch"]);
    expect(rig.stream.coreReducedState.subscriptions.laundered.halted).toMatchObject({
      attempts: 1,
      error: "a global context is reached by identity, never by path",
    });
    expect(haltFactsFor(rig.stream, "laundered")).toHaveLength(1);
  });

  test("a refusal of a call made for a row since REPLACED halts nothing — the replacement is not its predecessor", async () => {
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
    const configure = () =>
      rig.stream.append(
        normalizeControlEvent({
          type: "events.iterate.com/stream/subscription-configured",
          payload: {
            name: "swap",
            target: facetTarget("swap"),
            consumes: ["blob"],
          },
        }),
      )[0].offset;
    configure();
    await settled();
    rig.stream.append({ type: "blob" });
    await settled(); // the push is in flight, parked
    const replacement = configure(); // REPLACES the row (a new identity) under the parked push
    await settled();
    refuseInFlightPush(Object.assign(new Error("poison"), { retryable: false }));
    await settled();
    expect(haltFactsFor(rig.stream, "swap")).toEqual([]);
    expect(rig.stream.coreReducedState.subscriptions.swap).toMatchObject({
      configuredAtOffset: replacement,
    });
    expect(rig.stream.coreReducedState.subscriptions.swap.halted).toBeUndefined();
  });
});

/** The `n` of each delivered event — what a sink saw, in order. */
const ns = (events: { payload?: { n?: number } }[]) => events.map((e) => e.payload?.n ?? -1);

describe("subscribe({ afterOffset }) — the cursor lane starts where the row asked", () => {
  test("a row configured with afterOffset: 0 after three durable events delivers those three NOW (its configure is its wake); a row without it starts from its configure offset; both take what lands next", async () => {
    const history: number[][] = [];
    const now: number[][] = [];
    const rig = incarnation((printed) =>
      printed === "itx.history"
        ? { push: (events: { payload?: { n?: number } }[]) => void history.push(ns(events)) }
        : printed === "itx.now"
          ? { push: (events: { payload?: { n?: number } }[]) => void now.push(ns(events)) }
          : undefined,
    );
    for (const n of [1, 2, 3]) rig.stream.append({ type: "demo/ping", payload: { n } });
    rig.stream.append(
      normalizeControlEvent({
        type: "events.iterate.com/stream/subscription-configured",
        payload: { name: "now", target: "itx.now.push", consumes: ["demo/ping"] },
      }),
    );
    rig.stream.append(
      normalizeControlEvent({
        type: "events.iterate.com/stream/subscription-configured",
        payload: {
          name: "history",
          target: "itx.history.push",
          consumes: ["demo/ping"],
          afterOffset: 0,
        },
      }),
    );
    await settled();
    expect({ history, now }).toEqual({ history: [[1, 2, 3]], now: [] });
    expect(rig.delivery.cursor("history")?.confirmedOffset).toBe(rig.stream.highestDurableOffset());
    rig.stream.append({ type: "demo/ping", payload: { n: 4 } });
    await settled();
    expect({ history, now }).toEqual({ history: [[1, 2, 3], [4]], now: [[4]] });
  });
});

describe("a wake makes no work", () => {
  test('the wake record is delivered to NO "*" row — an alarm-only incarnation evaluates no target and arms no alarm', async () => {
    const delivered: string[] = [];
    const sink = {
      push: (events: { type: string }[]) => void delivered.push(...events.map((e) => e.type)),
    };
    const first = incarnation((printed) => (printed === "itx.sink" ? sink : undefined));
    first.stream.append(
      normalizeControlEvent({
        type: "events.iterate.com/stream/subscription-configured",
        payload: { name: "config", target: "itx.sink.push", consumes: ["*"] },
      }),
    );
    first.stream.append({ type: "demo/ping", payload: {} });
    await settled();
    expect(delivered).toEqual(["demo/ping"]); // the row works; the birth's created/woken were never its

    // THE EVICTION AND THE WAKE: a fresh incarnation over the same storage appends its woken.
    const second = incarnation(
      (printed) => (printed === "itx.sink" ? sink : undefined),
      first.storage,
    );
    await settled();
    expect(delivered).toEqual(["demo/ping"]); // the wake reached nobody…
    expect(second.evaluated).toEqual([]); // …no target was evaluated for it…
    expect(second.delivery.deadlines()).toEqual([]); // …nothing is owed for it…
    expect(second.alarms).toEqual([]); // …and nothing was armed: this incarnation can idle out
  });

  test("a row that NAMES stream/woken is the opt-in and does receive it", async () => {
    const delivered: string[] = [];
    const sink = {
      push: (events: { type: string }[]) => void delivered.push(...events.map((e) => e.type)),
    };
    const first = incarnation((printed) => (printed === "itx.sink" ? sink : undefined));
    first.stream.append(
      normalizeControlEvent({
        type: "events.iterate.com/stream/subscription-configured",
        payload: {
          name: "wakes",
          target: "itx.sink.push",
          consumes: ["events.iterate.com/stream/woken"],
        },
      }),
    );
    incarnation((printed) => (printed === "itx.sink" ? sink : undefined), first.storage);
    await settled();
    expect(delivered).toEqual(["events.iterate.com/stream/woken"]);
  });
});

describe("the cursor lane across an eviction and a replace", () => {
  test("the alarm's cursor pass recovers a row whose FIRST delivery an eviction interrupted — ROW-driven (the cursor table holds nothing before the first ack), and the lane had armed the alarm to come back", async () => {
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
    first.stream.append(
      normalizeControlEvent({
        type: "events.iterate.com/stream/subscription-configured",
        payload: { name: "s", target: "itx.sink.push", consumes: ["demo/ping"] },
      }),
    );
    const armedBeforeAnyDelivery = first.alarms.length;
    first.stream.append({ type: "demo/ping", payload: { n: 1 } });
    first.stream.append({ type: "demo/ping", payload: { n: 2 } });
    await settled();
    expect(beforeEviction).toEqual([1]); // in flight, never acked
    expect(first.stream.storage.listSubscriptionCursors()).toEqual([]); // …so the table holds nothing
    expect(first.alarms.length).toBeGreaterThan(armedBeforeAnyDelivery); // …but the lane armed the alarm

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
    await second.delivery.deliverEveryCursorSubscription(); // THE ALARM'S OWN DOOR
    await settled();
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
      if (printed === "itx.sinkB")
        return { push: (events: { payload?: { n?: number } }[]) => void sinkB.push(ns(events)) };
      return undefined;
    });
    stream.append(
      normalizeControlEvent({
        type: "events.iterate.com/stream/subscription-configured",
        payload: { name: "s", target: "itx.sinkA.push", consumes: ["demo/ping"] },
      }),
    );
    stream.append({ type: "demo/ping", payload: { n: 1 } });
    await settled();
    expect(sinkA).toEqual([[1]]); // the first batch is in flight, parked on the gate

    // The row is REPLACED while that delivery is parked, and a second batch lands behind it.
    stream.append(
      normalizeControlEvent({
        type: "events.iterate.com/stream/subscription-configured",
        payload: { name: "s", target: "itx.sinkB.push", consumes: ["demo/ping"] },
      }),
    );
    stream.append({ type: "demo/ping", payload: { n: 2 } });
    await settled();
    releaseSinkA();
    await settled();
    expect({ sinkA, sinkB }).toEqual({ sinkA: [[1]], sinkB: [[2]] });
  });

  test("a two-step target (`itx.<alias>` — the spelling every provide mints) IS the callee: delivered to whole, never split into a bare root and a method", async () => {
    const delivered: number[][] = [];
    const { stream, evaluated } = incarnation((printed) =>
      // What a rewrite rule resolves `itx.sink` to: the bare callable a client lent.
      printed === "itx.sink"
        ? (events: { payload?: { n?: number } }[]) => void delivered.push(ns(events))
        : undefined,
    );
    stream.append(
      normalizeControlEvent({
        type: "events.iterate.com/stream/subscription-configured",
        payload: { name: "mirror", target: "itx.sink", consumes: ["demo/ping"] },
      }),
    );
    stream.append({ type: "demo/ping", payload: { n: 1 } });
    await settled();
    // the target evaluated is `itx.sink` itself — at configure, then per commit that reached the row
    expect(delivered).toEqual([[1]]);
    expect(evaluated.length).toBeGreaterThan(0);
    expect(evaluated.every((printed) => printed === "itx.sink")).toBe(true);
  });
});

describe("the cursor lane's read reservation is never re-acquired while held", () => {
  // The read branch reserves the whole cursor budget (8 MiB) before its read. A page's BODIES fill
  // the read budget (8 MiB of stored bytes) and each event's offset and path ride on top, so a full
  // page serializes PAST the reservation. Acquiring the overshoot while holding the whole budget
  // waited on the reservation itself — forever — and every other cursor row on the context behind it.
  test.each([
    { bodyShortfall: 100, label: "CONTROL: a body 100 chars under the ceiling (the page fits)" },
    {
      bodyShortfall: 5,
      label: "a body 5 chars under the ceiling (the page overshoots by its envelope)",
    },
  ])("$label — delivered, and the other cursor row keeps flowing", async ({ bodyShortfall }) => {
    const delivered: Record<string, number[]> = { history: [], now: [] };
    const rig = incarnation((printed) => {
      const name =
        printed === "itx.history" ? "history" : printed === "itx.now" ? "now" : undefined;
      return (
        name && {
          push: (events: { offset: number }[]) =>
            void delivered[name].push(...events.map((e) => e.offset)),
        }
      );
    });
    const overhead = JSON.stringify({
      type: "blob",
      payload: { blob: "" },
      createdAt: new Date().toISOString(),
    }).length;
    const [big] = rig.stream.append({
      type: "blob",
      payload: { blob: "x".repeat(8 * MiB - overhead - bodyShortfall) },
    });
    // `history` must READ the page holding the big event (the whole log); `now` is "from now".
    rig.stream.append(
      normalizeControlEvent({
        type: "events.iterate.com/stream/subscription-configured",
        payload: {
          name: "history",
          target: "itx.history.push",
          consumes: ["blob"],
          afterOffset: 0,
        },
      }),
    );
    rig.stream.append(
      normalizeControlEvent({
        type: "events.iterate.com/stream/subscription-configured",
        payload: { name: "now", target: "itx.now.push", consumes: ["tick"] },
      }),
    );
    const [tick] = rig.stream.append({ type: "tick" });
    await settled();
    expect(delivered).toEqual({ history: [big.offset], now: [tick.offset] });
    expect(rig.delivery.cursor("now")?.confirmedOffset).toBe(tick.offset);
  });
});

describe("a rule re-point re-classifies a row", () => {
  test("push → cursor: a facet row re-pointed at a plain function leaves the push set, so the alarm's pass retries its ladder", async () => {
    let lane: "facet" | "sink" = "facet";
    let sinkCalls = 0;
    const rig = incarnation((printed) =>
      printed !== "itx.proc"
        ? undefined
        : lane === "facet"
          ? new FacetHandle(() => Promise.resolve())
          : () => {
              sinkCalls++;
              throw new Error("sink down");
            },
    );
    // A two-step target (`itx.proc`) — root-called whole; what it evaluates to decides the lane.
    rig.stream.append(
      normalizeControlEvent({
        type: "events.iterate.com/stream/subscription-configured",
        payload: { name: "s", target: "itx.proc", consumes: ["blob"] },
      }),
    );
    await settled();
    rig.stream.append({ type: "blob" });
    await settled();
    expect(rig.delivery.cursor("s")).toBeUndefined(); // a facet: the push lane keeps no cursor
    // THE RE-POINT: a rule commit replaces the rule table (the per-row target memo keys on it), and
    // `itx.proc` now evaluates to a plain function — a target that cannot own its progress.
    lane = "sink";
    rig.stream.append({
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: { match: "itx.unrelated", target: "itx.kv" },
    });
    rig.stream.append({ type: "blob" });
    await settled();
    const failed = rig.delivery.cursor("s");
    expect(sinkCalls).toBe(1);
    expect(failed).toMatchObject({ attempt: 1 });
    // The alarm's row-driven pass, past the ladder's next attempt: the row is retried from its cursor.
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
    try {
      vi.setSystemTime(failed!.nextAttemptAtMs! + 1);
      await rig.delivery.deliverEveryCursorSubscription();
    } finally {
      vi.useRealTimers();
    }
    await settled();
    expect(sinkCalls).toBe(2);
    expect(rig.delivery.cursor("s")).toMatchObject({ attempt: 2 });
  });
});

describe("a superseded evaluation can neither classify nor invoke its replacement", () => {
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
          ? { push: (events: { payload?: { n?: number } }[]) => void sink.push(ns(events)) }
          : undefined,
    );
    const configureFacet = () =>
      rig.stream.append(
        normalizeControlEvent({
          type: "events.iterate.com/stream/subscription-configured",
          payload: {
            name: "s",
            target: "itx.proc.processEventBatch",
            consumes: ["blob"],
          },
        }),
      );
    const configureSink = () =>
      rig.stream.append(
        normalizeControlEvent({
          type: "events.iterate.com/stream/subscription-configured",
          payload: { name: "s", target: "itx.sink.push", consumes: ["blob"] },
        }),
      );
    // AT CONFIGURE: the facet row's catch-up parks on its evaluation; the row is replaced meanwhile.
    gate = new Promise((r) => (openGate = r));
    configureFacet();
    await settled();
    configureSink(); // REPLACES the row (a new identity) under the parked evaluation
    await settled();
    openGate();
    await settled();
    expect(facetCalls).toEqual([]); // the superseded catch-up called nothing
    rig.stream.append({ type: "blob", payload: { n: 1 } });
    await settled();
    expect(sink).toEqual([[1]]); // the replacement is its own row: a cursor target, delivered
    expect(rig.delivery.cursor("s")).toBeDefined();
    // UNDER A PUSH: back to a facet row (caught up), then a push whose evaluation parks.
    gate = Promise.resolve();
    configureFacet();
    await settled();
    expect(facetCalls).toEqual(["catchUpFromLog"]);
    gate = new Promise((r) => (openGate = r));
    rig.stream.append({ type: "blob", payload: { n: 2 } });
    await settled(); // the push's evaluation is parked
    configureSink();
    await settled();
    openGate();
    await settled();
    expect(facetCalls).toEqual(["catchUpFromLog"]); // the superseded push called nothing
    rig.stream.append({ type: "blob", payload: { n: 3 } });
    await settled();
    expect(sink).toEqual([[1], [3]]);
  });
});

describe("the delivery loop's deadline on the DO's alarm (`deadlines()`)", () => {
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
    if (!previous)
      rig.stream.append(
        normalizeControlEvent({
          type: "events.iterate.com/stream/subscription-configured",
          payload: { name: "s", target: "itx.sink.push", consumes: ["demo/ping"] },
        }),
      );
    const release = async () => {
      parked.splice(0).forEach((resolve) => resolve());
      await settled();
    };
    return { ...rig, pushes, release };
  }

  test("a queued durable delivery is insured, an acked one is not: the alarm is armed once and deleted once, a burst mid-call included", async () => {
    const rig = parkedSinkRig();
    expect(rig.delivery.deadlines()).toEqual([]);
    expect(rig.alarms).toEqual([]);
    rig.stream.append({ type: "demo/ping", payload: { n: 1 } });
    expect(rig.delivery.deadlines()).toMatchObject([{ name: "s" }]);
    expect(rig.alarms).toHaveLength(1);
    await settled();
    rig.stream.append({ type: "demo/ping", payload: { n: 2 } }); // lands while n=1 is in flight
    expect(rig.alarms).toHaveLength(1); // the insurance already stands: no second write
    await rig.release(); // acks n=1; the loop takes n=2
    await rig.release(); // acks n=2; caught up
    expect(rig.pushes).toEqual([[1], [2]]);
    expect(rig.delivery.deadlines()).toEqual([]);
    expect(rig.deletes).toEqual([1]);
    expect(rig.alarms).toHaveLength(1);
  });

  test("an ephemeral-only push to a caught-up cursor row is uninsurable: it arms nothing", async () => {
    const rig = parkedSinkRig();
    rig.stream.append({ type: "demo/ping", payload: { n: 1 } });
    await settled();
    await rig.release(); // caught up: armed once, deleted once
    expect({ alarms: rig.alarms.length, deletes: rig.deletes }).toEqual({
      alarms: 1,
      deletes: [1],
    });
    rig.stream.append({ type: "demo/ping", ephemeral: true });
    await settled();
    expect(rig.pushes).toEqual([[1], [-1]]); // `ns` reads -1 for a payload-less event
    expect(rig.delivery.deadlines()).toEqual([]);
    expect({ alarms: rig.alarms.length, deletes: rig.deletes }).toEqual({
      alarms: 1,
      deletes: [1],
    });
    await rig.release();
  });

  test("a pass that finds a call in flight past its insurance re-arms AHEAD, never in the past; a row nobody holds is released", async () => {
    const rig = parkedSinkRig();
    rig.stream.append({ type: "demo/ping", payload: { n: 1 } });
    await settled();
    const [insured] = rig.delivery.deadlines();
    expect(insured.inFlight).toBe(true);
    vi.useFakeTimers({ now: insured.at + 5_000, toFake: ["Date"] });
    try {
      await rig.pass();
      const [swept] = rig.delivery.deadlines();
      expect(swept.at).toBeGreaterThan(Date.now());
      expect(rig.alarms.at(-1)).toBe(swept.at);
    } finally {
      vi.useRealTimers();
    }
    await rig.release();
    expect(rig.delivery.deadlines()).toEqual([]);
  });

  test("a facet row classified on a fresh incarnation leaves no deadline behind", async () => {
    const first = stuckFacetRig();
    first.release();
    await settled();
    const second = stuckFacetRig(first);
    second.stream.append({ type: "blob", payload: { blob: "x" } });
    // Queued for a row this incarnation does not yet know as a push row: insured…
    expect(second.delivery.deadlines()).toMatchObject([{ name: "slow" }]);
    await settled();
    // …until its target evaluates to a facet: the row owns its progress, the insurance goes.
    expect(second.delivery.deadlines()).toEqual([]);
    expect(second.deletes).toEqual([1]);
    second.release();
    await settled();
  });

  test("the ladder's next attempt IS the row's deadline, and survives an eviction before any pass", async () => {
    const first = incarnation((printed) =>
      printed === "itx.sink"
        ? {
            push: () => {
              throw new Error("sink down");
            },
          }
        : undefined,
    );
    first.stream.append(
      normalizeControlEvent({
        type: "events.iterate.com/stream/subscription-configured",
        payload: { name: "s", target: "itx.sink.push", consumes: ["demo/ping"] },
      }),
    );
    first.stream.append({ type: "demo/ping", payload: { n: 1 } });
    await settled();
    const failed = first.delivery.cursor("s")!;
    expect(failed.attempt).toBe(1);
    expect(first.delivery.deadlines()).toMatchObject([
      { name: "s", at: failed.nextAttemptAtMs, deadlineAt: undefined },
    ]);
    expect(first.alarms.at(-1)).toBe(failed.nextAttemptAtMs);
    // A commit during the wait insures nothing: the ladder covers the row.
    first.stream.append({ type: "demo/ping", payload: { n: 2 } });
    await settled();
    expect(first.delivery.deadlines()).toMatchObject([{ at: failed.nextAttemptAtMs }]);
    const second = incarnation(() => undefined, first.storage);
    expect(second.delivery.deadlines()).toMatchObject([{ name: "s", at: failed.nextAttemptAtMs }]);
  });

  test("a DUE ladder time is no claim — the pass acts on it; one the pass could not act on never re-arms an alarm into the same state", async () => {
    let refuse = true;
    const rig = incarnation((printed) =>
      printed === "itx.sink"
        ? {
            push: () => {
              if (refuse) throw new Error("sink down");
            },
          }
        : undefined,
    );
    rig.stream.append(
      normalizeControlEvent({
        type: "events.iterate.com/stream/subscription-configured",
        payload: { name: "s", target: "itx.sink.push", consumes: ["demo/ping"] },
      }),
    );
    rig.stream.append({ type: "demo/ping", payload: { n: 1 } });
    await settled();
    const failed = rig.delivery.cursor("s")!;
    expect(rig.delivery.deadlines()).toMatchObject([{ at: failed.nextAttemptAtMs }]); // ahead: a claim
    vi.useFakeTimers({ now: failed.nextAttemptAtMs! + 1, toFake: ["Date"] });
    try {
      expect(rig.delivery.deadlines()).toEqual([]); // due: the pass's, not the alarm's
      await rig.pass(); // the retry fails again → a new rung, ahead again
      const again = rig.delivery.cursor("s")!;
      expect(again.attempt).toBe(2);
      expect(rig.delivery.deadlines()).toMatchObject([{ at: again.nextAttemptAtMs }]);
      expect(rig.alarms.at(-1)).toBe(again.nextAttemptAtMs);
      refuse = false;
      vi.setSystemTime(again.nextAttemptAtMs! + 1);
      await rig.pass(); // acked: caught up, nothing claimed — and the spent alarm needs no delete
      expect(rig.delivery.deadlines()).toEqual([]);
      expect(rig.coordinator.snapshot().armedAt).toBeNull();
      expect(rig.deletes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a cursor row whose subscription is gone claims nothing", async () => {
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
    expect(second.alarms).toEqual([]);
  });

  test("a HALTED row owes nothing — even one whose persisted cursor still carries the retry time that halted it", async () => {
    const first = incarnation(() => undefined);
    first.stream.append(
      normalizeControlEvent({
        type: "events.iterate.com/stream/subscription-configured",
        payload: { name: "s", target: "itx.sink.push", consumes: ["demo/ping"] },
      }),
    );
    // A cursor as an earlier build persisted it at the halt: attempt 0, a past retry time kept.
    first.stream.storage.writeSubscriptionCursor("s", {
      confirmedOffset: 1,
      attempt: 0,
      nextAttemptAtMs: Date.now() - 60_000,
    });
    first.stream.append({
      type: "events.iterate.com/stream/subscription-delivery-halted",
      payload: { name: "s", afterOffset: 1, attempts: 15, error: "sink down" },
    });
    const second = incarnation(() => undefined, first.storage);
    expect(second.delivery.cursor("s")?.nextAttemptAtMs).toBeLessThan(Date.now());
    expect(second.delivery.deadlines()).toEqual([]);
    await second.pass();
    expect(second.alarms).toEqual([]);
  });
});

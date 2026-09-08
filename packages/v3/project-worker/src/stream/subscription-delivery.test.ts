/// <reference types="node" />
// subscription-delivery.test.ts — the one delivery loop in node over the real Stream (node:sqlite
// storage), `evaluateItxExpression` standing in for the context's dispatch:
//   • THE PENDING-PUSH BOUND: commits that land while a delivery is in flight FOLD into one pending
//     push; past PENDING_PUSH_BUDGET_CHARS the oldest events are dropped and the push's `after`
//     moves up to the last dropped offset — the gap a facet's own repair reads from the log. The
//     memory half (200 × 1 MiB behind a stuck facet survives a 128 MiB budget) is
//     memory-budget.test.ts's row; this file is the semantics.
//   • A RESUME wakes a halted facet row NOW, on the incarnation that halted it or a fresh one: the
//     resume classifies the row by evaluating its target, never by what this incarnation remembers.
//   • THE CURSOR LANE across an eviction and a replace: the alarm's ROW-driven pass recovers a first
//     delivery an eviction interrupted, a row replaced mid-delivery delivers to the NEW target, and a
//     two-step target (`itx.<alias>`, the spelling every `provide` mints) is the callee itself.

import { describe, expect, test } from "vitest";
import { print, type ItxExpression } from "../context/expression.ts";
import { FacetHandle } from "../context/invoke-handle.ts";
import { codedError } from "../lib/errors.ts";
import type { StreamEvent } from "./events.ts";
import { nodeSqliteDurableObjectStorage } from "./node-sqlite-durable-object-storage.ts";
import type { ScannedRange } from "./processor.ts";
import { Stream } from "./stream.ts";
import type { DurableObjectStorageSlice } from "./stream-storage.ts";
import { SubscriptionDelivery } from "./subscription-delivery.ts";
import { subscriptionConfiguredEvent } from "./subscriptions.ts";

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
 *  `alarms` is every instant the stream armed (node's storage slice has no alarm of its own). */
function incarnation(
  resolve: (printedExpression: string) => unknown,
  storage: DurableObjectStorageSlice = nodeSqliteDurableObjectStorage(),
) {
  const alarms: number[] = [];
  const evaluated: string[] = [];
  let delivery!: SubscriptionDelivery;
  const stream = new Stream({
    storage: {
      ...storage,
      setAlarm: async (atMs: number | Date) => void alarms.push(Number(atMs)),
    },
    path: "/",
    projectId: "prj_delivery",
    onCommit: (fresh, after, through) => delivery.onCommit(fresh, after, through),
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
  });
  stream.appendCreatedAndWokenEvents();
  return { storage, stream, delivery, alarms, evaluated };
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
        subscriptionConfiguredEvent({
          name: "slow",
          target: ["itx", "facets", ["get", "slow"], "processEventBatch"],
          consumes: ["blob"],
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

/** The `n` of each delivered event — what a sink saw, in order. */
const ns = (events: { payload?: { n?: number } }[]) => events.map((e) => e.payload?.n ?? -1);

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
      subscriptionConfiguredEvent({ name: "s", target: "itx.sink.push", consumes: ["demo/ping"] }),
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
      subscriptionConfiguredEvent({ name: "s", target: "itx.sinkA.push", consumes: ["demo/ping"] }),
    );
    stream.append({ type: "demo/ping", payload: { n: 1 } });
    await settled();
    expect(sinkA).toEqual([[1]]); // the first batch is in flight, parked on the gate

    // The row is REPLACED while that delivery is parked, and a second batch lands behind it.
    stream.append(
      subscriptionConfiguredEvent({ name: "s", target: "itx.sinkB.push", consumes: ["demo/ping"] }),
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
      subscriptionConfiguredEvent({ name: "mirror", target: "itx.sink", consumes: ["demo/ping"] }),
    );
    stream.append({ type: "demo/ping", payload: { n: 1 } });
    await settled();
    // the target evaluated is `itx.sink` itself — at configure, then per commit that reached the row
    expect(delivered).toEqual([[1]]);
    expect(evaluated.length).toBeGreaterThan(0);
    expect(evaluated.every((printed) => printed === "itx.sink")).toBe(true);
  });
});

/// <reference types="node" />
// Live processor delivery over the real Stream. Durable ordered and fan-out progress belongs to
// DurableDeliveryProcessor; Workers exercise the subscriptions facet that hosts it.

import { AsyncLocalStorage } from "node:async_hooks";
import { expect, test } from "vitest";
import { print, type ItxExpression } from "iterate/expression";
import { codedError } from "iterate/lib";
import type { StreamEvent, ScannedRange } from "iterate/stream/processor";
import { nodeSqliteDurableObjectStorage } from "iterate/stream/test-support";
import { type Cause } from "../cause.ts";
import { registerPipelinedRpcBrand, FacetHandle } from "../context/dispatch.ts";
import { Stream, type DurableObjectStorageSlice } from "./stream.ts";
import { SubscriptionDelivery } from "./subscription-delivery.ts";
import { normalizeControlEvent } from "./core-processor.ts";

const MiB = 1024 * 1024;
const causes = new AsyncLocalStorage<Cause>();

test("pending processor pushes coalesce behind an in-flight delivery, in order", async () => {
  const rig = stuckFacetRig();
  await nextMacrotask();
  rig.stream.append({ type: "noise", ephemeral: true });
  const offsets = rig.commitBlobs(4);
  await rig.release();
  expect(rig.pushes).toHaveLength(1);
  expect(blobIndexes(rig.pushes[0]!)).toEqual([0, 1, 2, 3]);
  expect(rig.pushes[0]).toMatchObject({ range: { after: offsets[0]! - 1, through: offsets[3] } });
});

test("the bounded live queue drops oldest batches and moves its repair range", async () => {
  const rig = stuckFacetRig();
  await nextMacrotask();
  const offsets = rig.commitBlobs(12);
  await rig.release();
  const delivered = blobIndexes(rig.pushes[0]!);
  expect(delivered.length).toBeGreaterThan(0);
  expect(delivered.length).toBeLessThan(12);
  expect(delivered.at(-1)).toBe(11);
  expect(delivered).toEqual([...delivered].sort((a, b) => a - b));
  expect(rig.pushes[0]).toMatchObject({
    range: { after: offsets[delivered[0]! - 1], through: offsets[11] },
  });
});

test("a matching ephemeral reaches a live processor without creating durable subscription progress", async () => {
  const rig = stuckFacetRig();
  await rig.release();
  const [ephemeral] = rig.stream.append({ type: "blob", ephemeral: true, payload: { i: 1 } });
  await drainDeliveries();
  expect(rig.pushes).toHaveLength(1);
  expect(rig).toMatchObject({
    pushes: [
      expect.objectContaining({
        events: [expect.objectContaining({ offset: ephemeral!.offset, ephemeral: true })],
        range: { after: ephemeral!.offset - 1, through: ephemeral!.offset },
      }),
    ],
  });
});

test("a read waits for the processor materialization and its queued push", async () => {
  const rig = stuckFacetRig();
  await nextMacrotask();
  rig.commitBlobs(1);
  void rig.delivery.deliveriesQueuedFor("slow").then(() => rig.facetMethods.push("read"));
  void rig.delivery.deliveriesQueuedFor("unpushed").then(() => rig.facetMethods.push("unpushed"));
  await drainDeliveries();
  expect(rig.facetMethods).toHaveLength(2);
  expect(rig).toMatchObject({ facetMethods: ["catchUpFromLog", "unpushed"] });
  await rig.release();
  expect(rig.facetMethods).toHaveLength(4);
  expect(rig).toMatchObject({
    facetMethods: ["catchUpFromLog", "unpushed", "processEventBatch", "read"],
  });
});

test.for([{ evicted: false }, { evicted: true }])(
  "resume wakes a halted processor on the current or a fresh incarnation without a durable cursor",
  async ({ evicted }) => {
    const first = stuckFacetRig();
    await first.release();
    first.stream.append({
      type: "events.iterate.com/itx/subscription-delivery-halted",
      payload: { name: "slow", afterOffset: first.configuredAtOffset, attempts: 1, error: "halt" },
    });
    first.commitBlobs(1);
    await nextMacrotask();
    const rig = evicted ? stuckFacetRig(first) : first;
    await nextMacrotask();
    const before = rig.facetMethods.length;
    resume(rig, "slow");
    await rig.release();
    expect(rig.facetMethods.slice(before)).toEqual(["catchUpFromLog"]);
    expect(rig.stream.coreReducedState.subscriptions.slow.halted).toBeUndefined();
  },
);

test("a queued processor push is suppressed when that row halts before it runs", async () => {
  const rig = stuckFacetRig();
  await nextMacrotask();
  rig.commitBlobs(1);
  rig.stream.append({
    type: "events.iterate.com/itx/subscription-delivery-halted",
    payload: { name: "slow", afterOffset: rig.configuredAtOffset, attempts: 1, error: "halt" },
  });
  await rig.release();
  expect(rig).toMatchObject({ facetMethods: ["catchUpFromLog"], pushes: [] });
});

test("a permanent processor refusal records one halt per resumed generation", async () => {
  const latched = codedError("REDUCE_CHECKPOINT_TOO_LARGE", "checkpoint latched");
  const methods: string[] = [];
  const rig = incarnation(
    () =>
      new FacetHandle((steps) => {
        const [call] = steps;
        methods.push(Array.isArray(call) ? (call[0] as string) : (call as string));
        return Promise.reject(latched);
      }),
  );
  configure(rig, { name: "poison", target: facetTarget("poison"), delivery: "processor" });
  await drainDeliveries();
  expect(haltFactsFor(rig.stream, "poison")).toHaveLength(1);
  resume(rig, "poison");
  await drainDeliveries();
  expect(methods.slice(1).sort()).toEqual(["catchUpFromLog", "processEventBatch"]);
  expect(haltFactsFor(rig.stream, "poison")).toHaveLength(2);
});

test("a pipelined processor refusal is settled and halts the row", async () => {
  class PipelinedAnswer<T> extends Promise<T> {}
  registerPipelinedRpcBrand(PipelinedAnswer);
  const rig = incarnation(
    () =>
      new FacetHandle((steps) => {
        const [call] = steps;
        return Array.isArray(call) && call[0] === "processEventBatch"
          ? PipelinedAnswer.reject(
              codedError("FORBIDDEN", "a global context is reached by identity, never by path"),
            )
          : Promise.resolve();
      }),
  );
  configure(rig, { name: "laundered", target: facetTarget("laundered"), delivery: "processor" });
  await drainDeliveries();
  expect(rig.stream.coreReducedState.subscriptions.laundered.halted).toMatchObject({ attempts: 1 });
  expect(haltFactsFor(rig.stream, "laundered")).toHaveLength(1);
});

test("a refusal from a replaced processor generation cannot halt its replacement", async () => {
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
    configure(rig, {
      name: "swap",
      target: facetTarget("swap"),
      consumes: ["blob"],
      delivery: "processor",
    })[0]!.offset;
  swap();
  await drainDeliveries();
  rig.stream.append({ type: "blob" });
  await drainDeliveries();
  const replacement = swap();
  await drainDeliveries();
  refuseInFlightPush(codedError("PERMANENT_FAILURE", "poison"));
  await drainDeliveries();
  expect(haltFactsFor(rig.stream, "swap")).toEqual([]);
  expect(rig.stream.coreReducedState.subscriptions.swap).toMatchObject({
    configuredAtOffset: replacement,
  });
});

function nextMacrotask() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}
async function drainDeliveries() {
  for (let i = 0; i < 20; i++) await nextMacrotask();
}

function incarnation(
  resolve: (printedExpression: string) => unknown,
  storage: DurableObjectStorageSlice = nodeSqliteDurableObjectStorage(),
) {
  let delivery!: SubscriptionDelivery;
  const stream = new Stream({
    storage,
    path: "/",
    projectId: "prj_delivery",
    cause: () => causes.getStore(),
    onCommit: (fresh, after, through) => {
      delivery.onCommit(fresh, after, through);
    },
  });
  delivery = new SubscriptionDelivery({
    stream,
    evaluateItxExpression: async (expression: ItxExpression) => {
      const printed = print(expression);
      const value = await resolve(printed);
      if (value === undefined)
        throw codedError(
          "NO_ITX_EXPRESSION_MATCH",
          `no rewrite rule matches ${JSON.stringify(printed)} (default-deny)`,
        );
      return { value, validUntil: Infinity, routedTo: printed };
    },
    pushEventBatchToFacet: async (facet, events, range) =>
      await facet.invoke([["processEventBatch", events, range]]),
    catchUpFacetFromLog: async (facet) => await facet.invoke([["catchUpFromLog"]]),
  });
  stream.appendWakeRecord({ cause: "call", caller: "other" }, causes.getStore());
  return { storage, stream, delivery };
}

function stuckFacetRig(previous?: { storage: DurableObjectStorageSlice }) {
  const facetMethods: string[] = [];
  const pushes: { events: StreamEvent[]; range: ScannedRange }[] = [];
  const parked: (() => void)[] = [];
  let holding = true;
  const rig = incarnation(
    () =>
      new FacetHandle((steps) => {
        const [call] = steps;
        const method = Array.isArray(call) ? (call[0] as string) : (call as string);
        facetMethods.push(method);
        if (Array.isArray(call) && call[0] === "processEventBatch")
          pushes.push({ events: call[1] as StreamEvent[], range: call[2] as ScannedRange });
        return holding ? new Promise<void>((resolve) => parked.push(resolve)) : Promise.resolve();
      }),
    previous?.storage,
  );
  const configuredAtOffset = previous
    ? rig.stream.coreReducedState.subscriptions.slow.configuredAtOffset
    : configure(rig, {
        name: "slow",
        target: facetTarget("slow"),
        consumes: ["blob"],
        delivery: "processor",
      })[0]!.offset;
  return {
    ...rig,
    facetMethods,
    pushes,
    configuredAtOffset,
    commitBlobs: (count: number) =>
      Array.from(
        { length: count },
        (_, i) =>
          rig.stream.append({ type: "blob", payload: { i, blob: "x".repeat(MiB) } })[0]!.offset,
      ),
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
function haltFactsFor(stream: Stream, name: string) {
  return stream
    .read(0, 500)
    .events.filter(
      (event) =>
        event.type === "events.iterate.com/itx/subscription-delivery-halted" &&
        (event.payload as { name: string }).name === name,
    );
}
function facetTarget(name: string): ItxExpression {
  return ["itx", "facets", ["get", name], "processEventBatch"];
}
function configured(payload: Record<string, unknown>) {
  return normalizeControlEvent(
    { type: "events.iterate.com/itx/subscription-configured", payload },
    "/",
  );
}
function configure(rig: { stream: Stream }, payload: Record<string, unknown>) {
  return rig.stream.append(configured(payload));
}
function resume(rig: { stream: Stream }, name: string) {
  return rig.stream.append(
    normalizeControlEvent(
      { type: "events.iterate.com/itx/subscription-delivery-resumed", payload: { name } },
      "/",
    ),
  );
}

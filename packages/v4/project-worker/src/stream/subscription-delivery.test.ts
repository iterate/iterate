/// <reference types="node" />
// subscription-delivery.test.ts — the PENDING-PUSH BOUND of the one delivery loop, in node over the
// real Stream (node:sqlite storage) with a facet target whose calls the test holds open: commits that
// land while a delivery is in flight FOLD into one pending push; past PENDING_PUSH_BUDGET_CHARS the
// oldest events are dropped and the push's `after` moves up to the last dropped offset — the gap a
// facet's own repair reads from the log. The memory half (200 × 1 MiB behind a stuck facet survives
// a 128 MiB budget) is memory-budget.test.ts's row; this file is the semantics.

import { describe, expect, test } from "vitest";
import { FacetHandle } from "../context/invoke-handle.ts";
import type { StreamEvent } from "./events.ts";
import { nodeSqliteDurableObjectStorage } from "./node-sqlite-durable-object-storage.ts";
import type { ScannedRange } from "./processor.ts";
import { Stream } from "./stream.ts";
import { StreamStorage } from "./stream-storage.ts";
import { SubscriptionDelivery } from "./subscription-delivery.ts";
import { subscriptionConfiguredEvent } from "./subscriptions.ts";

const MiB = 1024 * 1024;
const settle = () => new Promise((r) => setImmediate(r));

/** A stream with ONE facet subscription (`consumes: ["blob"]`) whose facet answers only when the
 *  test releases it: every call to the facet parks until `release()`. */
function stuckFacetRig() {
  const storage = nodeSqliteDurableObjectStorage();
  let delivery!: SubscriptionDelivery;
  const stream = new Stream({
    storage,
    path: "/",
    projectId: "prj_backlog",
    onCommit: (fresh, after, through) => delivery.onCommit(fresh, after, through),
  });
  const pushes: { events: StreamEvent[]; range: ScannedRange }[] = [];
  const parked: (() => void)[] = [];
  let holding = true;
  delivery = new SubscriptionDelivery({
    stream,
    evaluateItxExpression: async () =>
      new FacetHandle((steps) => {
        const [call] = steps;
        if (Array.isArray(call) && call[0] === "processEventBatch")
          pushes.push({ events: call[1] as StreamEvent[], range: call[2] as ScannedRange });
        return holding ? new Promise<void>((resolve) => parked.push(resolve)) : Promise.resolve();
      }),
    recordActivityForQuietClock: () => {},
  });
  const [configured] = stream.append(
    subscriptionConfiguredEvent({
      name: "slow",
      target: ["itx", "facets", ["get", "slow"], "processEventBatch"],
      consumes: ["blob"],
    }),
  );
  /** `count` durable 1 MiB `blob` events, one commit each; returns their offsets. */
  const commitBlobs = (count: number): number[] =>
    Array.from({ length: count }, (_, i) => {
      const [event] = stream.append({ type: "blob", payload: { i, blob: "x".repeat(1 * MiB) } });
      return event.offset;
    });
  return {
    pushes,
    commitBlobs,
    configuredAtOffset: configured.offset,
    release: async () => {
      holding = false;
      for (const resolve of parked.splice(0)) resolve();
      for (let i = 0; i < 20; i++) await settle();
    },
  };
}

const blobIndexes = (push: { events: StreamEvent[] }) =>
  push.events.map((event) => (event.payload as { i: number }).i);

describe("the pending push is bounded", () => {
  test("the activity head survives an incarnation and is absent until its first external activation", () => {
    const storage = nodeSqliteDurableObjectStorage();
    const first = new StreamStorage(storage);
    expect(first.readActivityHead()).toBeUndefined();
    first.writeActivityHead(12);
    expect(new StreamStorage(storage).readActivityHead()).toBe(12);
  });

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

  test("a durable activity head holds an unactivated wake across alarm passes, then releases it after a public door activates it", async () => {
    const storage = nodeSqliteDurableObjectStorage();
    let delivery!: SubscriptionDelivery;
    const stream = new Stream({
      storage,
      path: "/",
      projectId: "prj_alarm_cap",
      onCommit: () => {},
    });
    const delivered: string[][] = [];
    delivery = new SubscriptionDelivery({
      stream,
      evaluateItxExpression: async () => ({
        processEventBatch: async (events: StreamEvent[]) => {
          delivered.push(events.map((event) => event.type));
        },
      }),
      recordActivityForQuietClock: () => {},
    });
    const [configured] = stream.append(
      subscriptionConfiguredEvent({
        name: "cursor",
        target: "itx.cursorWorker.processEventBatch",
        consumes: ["*"],
      }),
    );
    const [oldWork] = stream.append({ type: "old-work" });
    const [wake] = stream.append({ type: "events.iterate.com/stream/woken" });
    let activityHead = oldWork.offset;

    await delivery.deliverEveryCursorSubscription(() => activityHead);
    await delivery.deliverEveryCursorSubscription(() => activityHead);

    expect(configured.offset).toBeLessThan(oldWork.offset);
    expect(delivered).toEqual([["old-work"]]);
    expect(delivery.cursor("cursor")?.confirmedOffset).toBe(oldWork.offset);

    activityHead = wake.offset; // a public door flushes the pending wake and durably activates head
    await delivery.deliverEveryCursorSubscription(() => activityHead);

    expect(delivered).toEqual([["old-work"], ["events.iterate.com/stream/woken"]]);
    expect(delivery.cursor("cursor")?.confirmedOffset).toBe(wake.offset);
  });

  test("a capped pushed batch keeps an ephemeral tail, including after a zero-width cap", async () => {
    const storage = nodeSqliteDurableObjectStorage();
    let delivery!: SubscriptionDelivery;
    let releaseTarget!: (target: {
      processEventBatch(events: StreamEvent[]): Promise<void>;
    }) => void;
    const target = new Promise<{ processEventBatch(events: StreamEvent[]): Promise<void> }>(
      (resolve) => (releaseTarget = resolve),
    );
    const delivered: string[][] = [];
    const stream = new Stream({
      storage,
      path: "/",
      projectId: "prj_pushed_cap",
      onCommit: (events, after, through) => delivery.onCommit(events, after, through),
    });
    delivery = new SubscriptionDelivery({
      stream,
      evaluateItxExpression: async () => target,
      recordActivityForQuietClock: () => {},
    });
    const [configured] = stream.append(
      subscriptionConfiguredEvent({
        name: "cursor",
        target: "itx.cursorWorker.processEventBatch",
        consumes: ["durable", "ephemeral"],
      }),
    );
    const [durable, ephemeral] = stream.append(
      { type: "durable" },
      { type: "ephemeral", ephemeral: true },
    );

    const zeroCap = delivery.deliverEveryCursorSubscription(() => configured.offset);
    const partialCap = delivery.deliverEveryCursorSubscription(() => durable.offset);
    releaseTarget({
      processEventBatch: async (events) => {
        delivered.push(events.map((event) => event.type));
      },
    });
    await Promise.all([zeroCap, partialCap]);
    await delivery.deliverEveryCursorSubscription(() => ephemeral.offset);
    for (let i = 0; i < 10; i++) await settle();

    expect(delivered).toEqual([["durable"], ["ephemeral"]]);
    expect(delivery.cursor("cursor")?.confirmedOffset).toBe(ephemeral.offset);
  });
});

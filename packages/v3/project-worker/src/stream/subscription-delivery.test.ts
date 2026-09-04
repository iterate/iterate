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

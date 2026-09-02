// SCRATCH PROBE — the head-clamp / stale-push named-ephemeral drop.
//
// BUG: a read/barrier verb (wake/snapshot/waitUntilProcessed) that reaches the stream HEAD advances
//   the in-memory cursor OVER an ephemeral offset — because read()'s scanned-range proof clamps to
//   highestAssignedOffset (which counts ephemeral offsets as valid gaps). If that cursor advance wins
//   the race against the ephemeral commit's OWN fire-and-forget push, the push then looks fully STALE
//   (scannedThroughOffset <= progress) and processEventBatch discards it at the `else` no-op —
//   silently dropping a NAMED, deliverable ephemeral that was handed to a LIVE processor.
//
// This is the defect-21 class ("deliverable, delivered named ephemerals must not be discarded"),
// but via the symmetric after<progress path the defect-21 fix (#repairThrough, after>progress) never
// covers. Reachable in the real DO: drives are fire-and-forget behind an async #facet(configure);
// reads/barriers reach the same facet through their own async #facet — so the barrier's wake CAN
// enqueue on the facet's serial chain before that commit's push. Named ephemerals (voice/telemetry)
// ride pushes as their ONLY delivery.

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { defineProcessorContract, type StreamEvent, type StreamEventInput } from "./events.ts";
import {
  StreamProcessor,
  type ProcessorStorage,
  type ProcessorStream,
  type ReduceArgs,
} from "./processor.ts";

// Faithful in-memory stream: one shared offset sequence, ephemerals consume offsets but never land
// in the durable log, and read()'s short-page proof clamps to the HEAD (highestAssignedOffset).
function memoryStream(path = "/") {
  const durable: StreamEvent[] = [];
  let maxAssigned = 0;
  const stream: ProcessorStream = {
    append: (...inputs: StreamEventInput[]) => {
      return inputs.map((input) => {
        maxAssigned += 1;
        const event = { ...input, offset: maxAssigned, createdAt: "t", path } as StreamEvent;
        if (!input.ephemeral) durable.push(event);
        return event;
      });
    },
    read: (afterOffset = 0, limit = 500) => {
      const page = durable.filter((e) => e.offset > afterOffset).slice(0, limit);
      return Promise.resolve({
        events: page,
        scannedThroughOffset: page.length === limit ? page[page.length - 1].offset : maxAssigned,
      });
    },
  };
  return { stream };
}

const memoryStorage = (): ProcessorStorage => {
  const map = new Map<string, unknown>();
  return {
    get: <T>(k: string) => map.get(k) as T | undefined,
    put: (k, v) => void map.set(k, structuredClone(v)),
  };
};

const contract = defineProcessorContract({
  slug: "probe",
  version: "1",
  description: "",
  stateSchema: z.object({ seen: z.array(z.string()).default([]) }),
  events: {},
  consumes: ["tick", "chunk"], // 'chunk' arrives ephemeral — NAMED, so it IS consumed
  emits: [],
});
class Probe extends StreamProcessor<{ seen: string[] }> {
  readonly contract = contract;
  protected override reduce({ event, state }: ReduceArgs<{ seen: string[] }>) {
    return { seen: [...state.seen, `${event.type}@${event.offset}`] };
  }
  // exact-offset suite: opt out of the default live-state emit (a constant projection never diffs)
  protected override projectLiveState() {
    return null;
  }
}

describe("head-clamp stale-push named-ephemeral drop", () => {
  test("CONTROL — push BEFORE the barrier: the named ephemeral is consumed (it is deliverable)", async () => {
    const { stream } = memoryStream();
    const p = new Probe({ stream, storage: memoryStorage(), path: "/", projectId: "p" });
    stream.append({ type: "tick" }); // offset 1, durable
    await p.wake();
    // one commit: durable tick@2 + ephemeral chunk@3 → range (1,3]
    const committed = await stream.append({ type: "tick" }, { type: "chunk", ephemeral: true });
    // the commit's fire-and-forget push lands FIRST…
    await p.processEventBatch(committed, { after: 1, through: 3 });
    // …then a barrier wake (now a no-op — already at head)
    await p.waitUntilProcessed({ offset: 3, timeoutMs: 1000 });
    expect((await p.snapshot()).state.seen).toEqual(["tick@1", "tick@2", "chunk@3"]);
  });

  test("FIXED — barrier BEFORE the push: the named ephemeral is still delivered (rides its one push)", async () => {
    const { stream } = memoryStream();
    const p = new Probe({ stream, storage: memoryStorage(), path: "/", projectId: "p" });
    stream.append({ type: "tick" }); // offset 1, durable
    await p.wake();
    // identical commit: durable tick@2 + ephemeral chunk@3 → range (1,3]
    const committed = await stream.append({ type: "tick" }, { type: "chunk", ephemeral: true });
    // a read-your-writes barrier for offset 3 reaches the facet's serial chain FIRST: its wake
    // catches up the durable log and, via the head-clamped proof, advances the cursor to 3 —
    // OVER the ephemeral offset — while consuming only the durable tick@2.
    await p.waitUntilProcessed({ offset: 3, timeoutMs: 1000 });
    // now the commit's own fire-and-forget push arrives — but progress already == 3, so it is
    // judged a stale redelivery and discarded whole.
    await p.processEventBatch(committed, { after: 1, through: 3 });
    // chunk@3 was NAMED, ephemeral, deliverable, and handed to a LIVE processor — it must appear.
    expect((await p.snapshot()).state.seen).toEqual(["tick@1", "tick@2", "chunk@3"]);
  });
});

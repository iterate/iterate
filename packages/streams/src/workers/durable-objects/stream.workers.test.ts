/// <reference types="@cloudflare/vitest-pool-workers/types" />
// Stream Durable Object tests, run inside workerd via vitest.workers.config.ts.
// See tasks/streams-review-fixes.md (Stage 0). These exercise the real SQL
// storage path that node tests can't reach.
//
// Pattern (borrowed from cloudflare/agents + the workers-sdk rpc fixture): most
// tests use `runInDurableObject` to call the DO instance directly and read its
// `state.storage`, instead of going over an RPC stub. That keeps thrown errors
// as ordinary local throws (so `expect().toThrow()` works without RPC
// unhandled-rejection noise) and lets storage be inspected directly. One test
// still goes over the RPC stub to cover the production boundary.
//
// T3 (C3) and T4 (M2) assert not-yet-true behavior with `it.fails` ratchets:
// they pass today because the correct behavior is currently violated, and flip
// to failing the moment the bug is fixed (then change `it.fails` -> `it`).
// T7 and T8 are coverage for behavior that is already correct, so they pass now.

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { StreamEvent } from "../../shared/event.ts";
import type { StreamEventBatch } from "../../types.ts";
import { PublicStreamRpcTarget, type Stream } from "./stream.ts";

const STREAM = (env as unknown as { STREAM: DurableObjectNamespace<Stream> }).STREAM;

// Each test uses a fresh DO name. The DO constructor seeds `created` (offset 1)
// and `woken` (offset 2) on first touch, so user appends start at offset 3.
let counter = 0;
function freshStream() {
  counter += 1;
  return STREAM.getByName(`stream:/review/t${counter}`);
}

describe("T3 — PublicStreamRpcTarget must not expose protected DO methods (C3)", () => {
  // Fixed in Stage 1: makeRpcTargetClass now allowlists the StreamRpc API, so
  // the protected core-state helpers are no longer proxied.
  it("does not proxy readCoreProcessorState / writeCoreProcessorState", () => {
    const exposed = Object.getOwnPropertyNames(PublicStreamRpcTarget.prototype);
    expect(exposed).not.toContain("writeCoreProcessorState");
    expect(exposed).not.toContain("readCoreProcessorState");
  });
});

describe("T4 — events carrying a `source` field must commit (M2)", () => {
  // Fixed in Stage 3: getEventSchema / getEventInputSchema now accept `source`
  // (shared StreamEventSourceSchema), matching the DO append.
  it("appends and reads back an event with a source", async () => {
    await runInDurableObject(freshStream(), async (stream) => {
      const committed = await stream.append({
        event: {
          type: "events.iterate.com/review/with-source",
          payload: { ok: true },
          source: { processor: { slug: "reviewer", version: "0.1.0" } },
        },
      });
      const read = await stream.getEvent({ offset: committed.offset });
      expect(read?.source).toEqual({ processor: { slug: "reviewer", version: "0.1.0" } });
    });
  });
});

describe("T7 — idempotency keys (coverage)", () => {
  it("dedups a repeated idempotencyKey and returns the existing event", async () => {
    await runInDurableObject(freshStream(), async (stream) => {
      const first = await stream.append({
        event: { type: "test.idem", payload: { n: 1 }, idempotencyKey: "dup-key" },
      });
      const second = await stream.append({
        event: { type: "test.idem", payload: { n: 2 }, idempotencyKey: "dup-key" },
      });

      expect(second.offset).toBe(first.offset);
      expect(second.payload).toEqual({ n: 1 }); // the original wins; the new payload is ignored
    });
  });

  it("rejects an offset precondition that disagrees with the idempotency hit", async () => {
    await runInDurableObject(freshStream(), async (stream) => {
      const first = await stream.append({
        event: { type: "test.idem", payload: {}, idempotencyKey: "precondition" },
      });

      // A plain local throw via runInDurableObject — no RPC boundary, so
      // expect().toThrow() works directly.
      expect(() =>
        stream.append({
          event: {
            type: "test.idem",
            payload: {},
            idempotencyKey: "precondition",
            offset: first.offset + 10,
          },
        }),
      ).toThrow(/idempotency hit/);
    });
  });
});

describe("T8 — Stream DO smoke (coverage)", () => {
  it("assigns consecutive offsets over the RPC stub and round-trips via getEvent", async () => {
    // This one goes over the real DurableObjectStub RPC boundary on purpose.
    // The stub promisifies the method's `MaybePromise` return into an awkward
    // type, hence the casts (the in-instance calls below need none).
    const stream = freshStream();
    const first = (await stream.append({
      event: { type: "test.smoke", payload: { i: 1 } },
    })) as StreamEvent;
    const second = (await stream.append({
      event: { type: "test.smoke", payload: { i: 2 } },
    })) as StreamEvent;

    expect(second.offset).toBe(first.offset + 1);
    const read = (await stream.getEvent({ offset: second.offset })) as StreamEvent | undefined;
    expect(read?.payload).toEqual({ i: 2 });
  });

  it("honors getEvents afterOffset + limit", async () => {
    await runInDurableObject(freshStream(), async (stream) => {
      const appended: StreamEvent[] = [];
      for (let i = 0; i < 5; i += 1) {
        appended.push(await stream.append({ event: { type: "test.range", payload: { i } } }));
      }
      const startOffset = appended[0]!.offset;
      const page = await stream.getEvents({ afterOffset: startOffset, limit: 2 });

      expect(page.map((e) => e.offset)).toEqual([startOffset + 1, startOffset + 2]);
    });
  });

  it("round-trips a >512KB event and splits it across multiple chunk rows", async () => {
    await runInDurableObject(freshStream(), async (stream, state) => {
      const big = "x".repeat(700 * 1024); // > EVENT_CHUNK_SIZE (512KB) → multiple chunks
      const committed = await stream.append({ event: { type: "test.big", payload: { big } } });

      const read = await stream.getEvent({ offset: committed.offset });
      expect(read).toBeDefined();
      expect((read!.payload as { big: string }).big).toBe(big);

      // Direct storage inspection (the cloudflare/agents pattern): the event JSON
      // really is chunked, not stored in one oversized cell.
      const chunkCount =
        state.storage.sql
          .exec<{ n: number }>(
            "select count(*) as n from event_chunks where offset = ?",
            committed.offset,
          )
          .toArray()[0]?.n ?? 0;
      expect(chunkCount).toBeGreaterThan(1);
    });
  });

  it("delivers replay from replayAfterOffset to a subscriber", async () => {
    await runInDurableObject(freshStream(), async (stream) => {
      const target = await stream.append({ event: { type: "test.replay", payload: {} } });

      const seen: number[] = [];
      const subscription = await stream.subscribe({
        replayAfterOffset: 0,
        processEventBatch: (batch) => {
          for (const event of batch.events) seen.push(event.offset);
        },
      });

      try {
        // Same isolate + synchronous storage reads, so the pump drains in a few
        // microtasks — no cross-isolate RPC and no long polling.
        for (let i = 0; i < 20 && !seen.includes(target.offset); i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        // Replay from 0 includes the seeded created/woken events plus our append.
        expect(seen).toContain(target.offset);
        expect(Math.min(...seen)).toBe(1);
      } finally {
        subscription.unsubscribe();
      }
    });
  });
});

describe("subscription protocol — every batch carries state, every subscribe gets an initial push", () => {
  // Drain helper: the pump delivers through microtasks/timers in the same
  // isolate, so a few timer ticks are enough for it to park.
  async function settlePump(until: () => boolean, ticks = 20) {
    for (let i = 0; i < ticks && !until(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  it("attaches state matching the stream's own reduced state (the getState source) to each batch", async () => {
    await runInDurableObject(freshStream(), async (stream) => {
      await stream.append({ event: { type: "test.state", payload: { n: 1 } } });

      const batches: StreamEventBatch[] = [];
      const subscription = await stream.subscribe({
        replayAfterOffset: 0,
        processEventBatch: (batch) => void batches.push(batch),
      });

      try {
        await settlePump(() => batches.length >= 1);
        const runtime = await stream.runtimeState();
        const last = batches.at(-1)!;
        // The exact object getState projections are built from — at the live
        // edge, state-as-of-batch-end IS the current core processor state.
        expect(last.state).toEqual(runtime.coreProcessorState);
        expect(last.state.maxOffset).toBe(last.streamMaxOffset);

        const appended = await stream.append({ event: { type: "test.state", payload: { n: 2 } } });
        await settlePump(() => batches.at(-1)?.events.at(-1)?.offset === appended.offset);
        const live = batches.at(-1)!;
        expect(live.events.at(-1)?.offset).toBe(appended.offset);
        expect(live.state.maxOffset).toBe(appended.offset);
        expect(live.state.eventCount).toBe(appended.offset);
      } finally {
        subscription.unsubscribe();
      }
    });
  });

  it("delivers an immediate initial state batch on a live-only subscription (no replay)", async () => {
    await runInDurableObject(freshStream(), async (stream) => {
      const batches: StreamEventBatch[] = [];
      const subscription = await stream.subscribe({
        // No replayAfterOffset: live-only. Before this protocol existed, this
        // subscription heard nothing until the next append.
        processEventBatch: (batch) => void batches.push(batch),
      });

      try {
        await settlePump(() => batches.length >= 1);
        expect(batches).toHaveLength(1);
        expect(batches[0]!.events).toEqual([]);
        expect(batches[0]!.streamMaxOffset).toBe(subscription.streamMaxOffset);
        expect(batches[0]!.state.maxOffset).toBe(subscription.streamMaxOffset);
      } finally {
        subscription.unsubscribe();
      }
    });
  });

  it("folds the initial push into the replay batch when replayAfterOffset yields events", async () => {
    await runInDurableObject(freshStream(), async (stream) => {
      const appended = await stream.append({ event: { type: "test.replay-state", payload: {} } });

      const batches: StreamEventBatch[] = [];
      const subscription = await stream.subscribe({
        replayAfterOffset: 0,
        processEventBatch: (batch) => void batches.push(batch),
      });

      try {
        await settlePump(() => batches.length >= 1);
        // ONE batch: the replayed events carry the state — no separate empty
        // initial batch when replay already delivered something.
        expect(batches).toHaveLength(1);
        expect(batches[0]!.events.map((event) => event.offset)).toEqual([1, 2, appended.offset]);
        expect(batches[0]!.state.maxOffset).toBe(appended.offset);
      } finally {
        subscription.unsubscribe();
      }
    });
  });

  it("events: false delivers state-bearing batches with no events, coalescing appends", async () => {
    await runInDurableObject(freshStream(), async (stream) => {
      const batches: StreamEventBatch[] = [];
      const subscription = await stream.subscribe({
        events: false,
        // Ignored: state-only subscriptions are implicitly live-from-now.
        replayAfterOffset: 0,
        processEventBatch: (batch) => void batches.push(batch),
      });

      try {
        await settlePump(() => batches.length >= 1);
        // Initial push only — replayAfterOffset: 0 must NOT replay history.
        expect(batches).toHaveLength(1);
        expect(batches[0]!.events).toEqual([]);
        expect(batches[0]!.state.maxOffset).toBe(subscription.streamMaxOffset);

        const last = (await stream.appendBatch({
          events: [
            { type: "test.state-only", payload: { n: 1 } },
            { type: "test.state-only", payload: { n: 2 } },
          ],
        }))!.at(-1)!;
        await settlePump(() => (batches.at(-1)?.state.maxOffset ?? 0) >= last.offset);

        // Every delivery is events-free; the latest carries the latest state.
        expect(batches.every((batch) => batch.events.length === 0)).toBe(true);
        expect(batches.at(-1)!.state.maxOffset).toBe(last.offset);
        expect(batches.at(-1)!.streamMaxOffset).toBe(last.offset);
      } finally {
        subscription.unsubscribe();
      }
    });
  });
});

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
import { PublicStreamRpcTarget, type Stream } from "./stream.ts";

const STREAM = (env as unknown as { STREAM: DurableObjectNamespace<Stream> }).STREAM;

// Each test uses a fresh DO name. Storage is lazy: a never-appended stream has
// no events. The first append prepends `created` (offset 1) + `woken` (offset
// 2), so the caller's first event is offset 3. Each later incarnation appends
// its own `woken` on wake (see the lazy-initialization tests below).
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
        // Replay from 0 includes the lazily-seeded `created` event plus our append.
        expect(seen).toContain(target.offset);
        expect(Math.min(...seen)).toBe(1);
      } finally {
        subscription.unsubscribe();
      }
    });
  });
});

describe("Stage 2 — lazy initialization", () => {
  it("a never-appended stream has no events and no storage", async () => {
    await runInDurableObject(freshStream(), async (stream, state) => {
      expect(await stream.getEvents()).toEqual([]);
      // The runtime state is the uninitialized placeholder, max offset 0.
      const runtime = await stream.runtimeState();
      expect(runtime.coreProcessorState.maxOffset).toBe(0);
      // And no SQLite tables were created just by instantiating + reading.
      const tables = state.storage.sql
        .exec("select name from sqlite_master where type = 'table' and name = 'events'")
        .toArray();
      expect(tables).toEqual([]);
    });
  });

  it("the first append prepends `created` + `woken` and returns only the caller's event", async () => {
    await runInDurableObject(freshStream(), async (stream) => {
      const committed = await stream.append({ event: { type: "test.first", payload: { n: 1 } } });
      // The caller gets back their own event at offset 3, after created + woken.
      expect(committed.type).toBe("test.first");
      expect(committed.offset).toBe(3);

      const events = await stream.getEvents();
      expect(events.map((e) => [e.offset, e.type])).toEqual([
        [1, "events.iterate.com/stream/created"],
        [2, "events.iterate.com/stream/woken"],
        [3, "test.first"],
      ]);
    });
  });

  it("appends `woken` when an already-initialized stream wakes on a new incarnation", async () => {
    counter += 1;
    const name = `stream:/review/wake${counter}`;
    const stub = STREAM.getByName(name);
    await stub.append({ event: { type: "test.init", payload: {} } });

    // The initializing incarnation logged one woken (offset 2).
    const before = (await stub.getEvents()) as StreamEvent[];
    expect(before.filter((e) => e.type === "events.iterate.com/stream/woken")).toHaveLength(1);

    // Abort the incarnation; the aborted stub is poisoned, so reach the fresh
    // incarnation through a new stub for the same DO name.
    await stub.kill().catch(() => undefined);

    // The new incarnation appended its own woken on wake.
    const after = (await STREAM.getByName(name).getEvents()) as StreamEvent[];
    const woken = after.filter((e) => e.type === "events.iterate.com/stream/woken");
    expect(woken).toHaveLength(2);
  });

  it("resolves a relative child path against the DO name even when the parent was never initialized", async () => {
    // Regression: relative resolution must use the DO's name, not reduced state
    // (which is the "uninitialized" placeholder until the parent is appended to).
    counter += 1;
    const parentName = `stream:/review/resolve${counter}`;
    const parent = STREAM.getByName(parentName);

    // Never append directly to the parent — it stays lazy. Append to a child.
    const committed = (await parent.append({
      streamPath: "child",
      event: { type: "test.resolve", payload: { k: 1 } },
    })) as StreamEvent;
    expect(committed.type).toBe("test.resolve");

    // The intended `${parentPath}/child` stream received it...
    const child = (await STREAM.getByName(`${parentName}/child`).getEvents()) as StreamEvent[];
    expect(child.some((e) => e.type === "test.resolve")).toBe(true);

    // ...and it did not leak into the parent (which would happen if resolution
    // used the placeholder path).
    const parentEvents = (await parent.getEvents()) as StreamEvent[];
    expect(parentEvents.some((e) => e.type === "test.resolve")).toBe(false);
  });
});

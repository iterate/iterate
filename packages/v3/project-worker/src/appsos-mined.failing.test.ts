// src/appsos-mined.failing.test.ts — BUG HUNT WAVE 2, pure-unit lane: apps/os-proven contracts
// mined ADJACENT to the wave-1 families in DEFECTS.md, adapted (never copied) against the
// clean-room's own surfaces (core/processor.ts base class, core/events.ts idempotency).
//
// Every test asserts the CORRECT (apps/os-proven) behavior. A `test.fails` documents a genuine
// divergence in the current code — its body opens BUG/EXPECTED/ACTUAL/WHY IT MATTERS and names
// the apps/os source. A plain `test` is a passing PARITY LOCK. Run:
//   pnpm exec vitest run --config vitest.config.ts src/appsos-mined.failing.test.ts

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { defineProcessorContract, sameIdempotentEvent, type StreamEvent } from "./core/events.ts";
import {
  StreamProcessor,
  type ProcessEventArgs,
  type ProcessorStream,
  type ReduceArgs,
} from "./core/processor.ts";

// ── shared fakes (the capability-table-processor.test.ts / core/processor.test.ts pattern) ──

const memoryStorage = () => {
  const map = new Map<string, unknown>();
  return {
    get: <T>(k: string) => map.get(k) as T | undefined,
    put: (k: string, v: unknown) => void map.set(k, structuredClone(v)),
    delete: (k: string) => void map.delete(k),
  };
};

function ev(offset: number, type = "t"): StreamEvent {
  return {
    type,
    payload: { n: offset },
    createdAt: new Date(offset).toISOString(),
    offset,
    path: "/",
  };
}

const CaughtUpContract = defineProcessorContract({
  slug: "caughtup-probe",
  version: "1.0.0",
  description: "counts delivery.caughtUp firings — the at-head-pass probe",
  stateSchema: z.object({ n: z.number().default(0) }),
  events: {},
  consumes: ["*"],
  emits: [],
});

class CaughtUpProbe extends StreamProcessor<{ n: number }> {
  readonly contract = CaughtUpContract;
  caughtUps = 0;
  protected override reduce({ state }: ReduceArgs<{ n: number }>) {
    return { n: state.n + 1 };
  }
  protected override processEvent(args: ProcessEventArgs<{ n: number }>): undefined {
    if (args.delivery.caughtUp) this.caughtUps++;
  }
}

// ─────────────────────────────── PROCESSOR BASE CLASS ───────────────────────────────

describe("StreamProcessor delivery.caughtUp is tied to the SHOWN head", () => {
  test.fails("two contiguous pushes where the first does NOT reach the shown head fire caughtUp exactly ONCE", async () => {
    // BUG: processEventBatch records the highest scannedThroughOffset it has ever been SHOWN
    //   (#pushedThroughOffset), yet the contiguous branch calls #processBatch(events, range,
    //   /*atHead*/ true) — hardcoded true — so EVERY contiguous push fires delivery.caughtUp,
    //   even a push whose range provably lags a later push already shown to the processor.
    // EXPECTED: caughtUp fires only for the batch that reaches the shown head. Two pushes
    //   enqueued back-to-back (through=1 then through=2) leave #pushedThroughOffset=2 before
    //   either runs, so the through=1 batch is NOT at head — exactly ONE caughtUp (for
    //   through=2). apps/os: StreamProcessorRunner "fires on the last consumed event of a
    //   caught-up batch; an unconsumed tail at head fires the event-less pass" — caughtUp is
    //   tied to reaching the committed head, not to being contiguous
    //   (apps/os/src/domains/streams/stream-processor-runner.test.ts:1324).
    // ACTUAL: caughtUp fires TWICE (once per push) — the through=1 batch claims at-head though
    //   the processor was already shown through=2.
    // WHY IT MATTERS: a processor's caughtUp work is the reconcile/self-pull pass (processor.ts
    //   rule 5). Firing it on a batch that is provably behind the head runs the reconcile
    //   against a non-head fold — extra work at best, and any runInBackground reconcile that
    //   assumes "I am at head" acts on stale state during a burst of rapid appends.
    const p = new CaughtUpProbe({
      stream: {
        append: () => [],
        read: () => Promise.resolve({ events: [], scannedThroughOffset: 0 }),
      },
      storage: memoryStorage(),
      path: "/",
      projectId: "prj_t",
    });
    // Two contiguous pushes, both enqueued before the chain drains: #pushedThroughOffset === 2
    // by the time the first (through=1) push runs.
    const first = p.processEventBatch([ev(1)], { scannedAfterOffset: 0, scannedThroughOffset: 1 });
    const second = p.processEventBatch([ev(2)], { scannedAfterOffset: 1, scannedThroughOffset: 2 });
    await Promise.all([first, second]);
    expect(p.caughtUps).toBe(1);
  });

  test("a single push that reaches the shown head fires caughtUp once (parity control)", async () => {
    const p = new CaughtUpProbe({
      stream: {
        append: () => [],
        read: () => Promise.resolve({ events: [], scannedThroughOffset: 0 }),
      },
      storage: memoryStorage(),
      path: "/",
      projectId: "prj_t",
    });
    await p.processEventBatch([ev(1)], { scannedAfterOffset: 0, scannedThroughOffset: 1 });
    expect(p.caughtUps).toBe(1);
  });
});

describe("StreamProcessor.waitUntilProcessed fails fast on a failed self-pull", () => {
  test.fails("a self-pull that THROWS rejects with the read failure, not the generic timeout", async () => {
    // BUG: waitUntilProcessed registers a waiter and fires `void this.wake()`; wake enqueues
    //   #catchUpBody on the serial chain, whose failure is swallowed by #enqueue's
    //   `.catch(() => {})` (a failed batch must not wedge the chain). The waiter is never told,
    //   so a self-pull that rejects (a transient stream/DO read error) leaves the caller parked
    //   for the WHOLE timeout and then rejected with a generic "did not reach offset" message.
    // EXPECTED: the failed self-pull rejects the barrier PROMPTLY, surfacing the read failure —
    //   apps/os: StreamProcessorRunner.waitUntilEvent "offset form rejects a failed self-pull
    //   promptly instead of parking until its timeout"
    //   (apps/os/src/domains/streams/stream-processor-runner.test.ts:1805).
    // ACTUAL: it parks the full timeoutMs, then rejects with the timeout message — the read
    //   error never surfaces.
    // WHY IT MATTERS: waitUntilProcessed is read-your-writes after an append. When the self-pull
    //   hits a transient error, failing fast lets the caller retry; parking the default 10s (here
    //   shortened) turns one recoverable read blip into a long, opaque stall.
    const p = new CaughtUpProbe({
      stream: {
        append: () => [],
        read: () => Promise.reject(new Error("self-pull read failed: boom")),
      },
      storage: memoryStorage(),
      path: "/",
      projectId: "prj_t",
    });
    await expect(p.waitUntilProcessed({ offset: 5, timeoutMs: 1500 })).rejects.toThrow(/boom/);
  });
});

// ─────────────────────────────── IDEMPOTENCY EQUALITY ───────────────────────────────

describe("sameIdempotentEvent (core/events.ts) — the retry-equality contract", () => {
  // apps/os: `sameIdempotentEvent` compares type + payload + metadata with a key-order-
  //   insensitive deep-equal ("Object key ORDER is insignificant", core/events.ts jsonEqual;
  //   apps/os packages/iterate/src/processors/idempotency.ts). These are passing PARITY LOCKS.
  test("payload key ORDER is insignificant — a reordered retry is the same event", () => {
    expect(
      sameIdempotentEvent(
        { type: "j", payload: { a: 1, b: { c: 2, d: 3 } } },
        { type: "j", payload: { b: { d: 3, c: 2 }, a: 1 } },
      ),
    ).toBe(true);
  });

  test("differing metadata makes it a DIFFERENT event (conflict, not dedupe)", () => {
    expect(
      sameIdempotentEvent(
        { type: "j", payload: { x: 1 }, metadata: { trace: "a" } },
        { type: "j", payload: { x: 1 }, metadata: { trace: "b" } },
      ),
    ).toBe(false);
  });

  test("metadata present on only one side is a DIFFERENT event", () => {
    expect(
      sameIdempotentEvent(
        { type: "j", payload: { x: 1 }, metadata: { trace: "a" } },
        { type: "j", payload: { x: 1 } },
      ),
    ).toBe(false);
  });
});

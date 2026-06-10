// Regression tests from the June 2026 packages/streams review.
// See tasks/streams-review-fixes.md — each test is tagged with its finding id.
//
// Tests for bugs that are not yet fixed use `it.fails`: they PASS today because
// the asserted (correct) behavior currently throws/mismatches, and they will
// START FAILING the moment the bug is fixed — at which point flip `it.fails`
// back to `it`. This keeps `pnpm test` green while pinning the bug precisely.
//
// T3/T4/T7/T8 from the plan exercise the Stream Durable Object (SQL storage) and
// need a vitest-pool-workers harness that this package does not have yet; they
// are tracked in Stage 0 of the task and land with that harness.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineProcessorContract } from "./shared/stream-processors.ts";
import type { StreamEvent } from "./shared/event.ts";
import type { StreamEventBatch } from "./types.ts";
import { StreamProcessor, type StreamProcessorSnapshot } from "./stream-processor.ts";
import { createStreamProcessorHost } from "./workers/stream-processor-host.ts";
import {
  CircuitBreakerProcessor,
  CircuitBreakerContract,
} from "./processors/circuit-breaker/implementation.ts";
import { spendCircuitBreakerToken } from "./processors/circuit-breaker/contract.ts";

const iso = (ms = 0) => new Date(ms).toISOString();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const iterateContext = () => ({ stream: { append() {}, appendBatch() {} } });

// A minimal counting processor whose batch hook can be made to throw once.
const CounterContract = defineProcessorContract({
  slug: "test.regression-counter",
  version: "0.1.0",
  description: "Counts amounts for review regression tests.",
  stateSchema: z.object({ total: z.number().default(0) }),
  initialState: {},
  events: { "test/add": { payloadSchema: z.object({ amount: z.number() }) } },
  consumes: ["test/add"],
  emits: [],
});
type CounterContract = typeof CounterContract;
type CounterDeps = { onBatch?: () => void };

class CounterProcessor extends StreamProcessor<CounterContract, CounterDeps> {
  readonly contract = CounterContract;
  protected override reduce(args: Parameters<StreamProcessor<CounterContract>["reduce"]>[0]) {
    return { total: args.state.total + args.event.payload.amount };
  }
  protected override async processEventBatch(
    args: Parameters<StreamProcessor<CounterContract>["processEventBatch"]>[0],
  ): Promise<void> {
    this.deps.onBatch?.();
    await super.processEventBatch(args);
  }
}

function add(offset: number, amount: number): StreamEvent {
  return { type: "test/add", payload: { amount }, offset, createdAt: iso() };
}

// An in-memory DurableObjectState stub: just the kv + waitUntil surface the host
// touches. waitUntil work is collected so tests can await it.
function fakeDurableObjectCtx() {
  const map = new Map<string, unknown>();
  const pending: Promise<unknown>[] = [];
  const ctx = {
    storage: {
      kv: {
        get: <T>(key: string): T | undefined => map.get(key) as T | undefined,
        put: (key: string, value: unknown) => void map.set(key, value),
      },
    },
    waitUntil: (work: Promise<unknown>) => void pending.push(work),
  };
  return { ctx: ctx as unknown as DurableObjectState, settle: () => Promise.allSettled(pending) };
}

// A fake stream stub + pump that faithfully mimics the Stream DO delivery path
// (stream.ts #openConnection): the cursor advances to the last offset BEFORE
// delivery, and the batch result is fire-and-forget — a failed batch is never
// re-delivered on a live connection.
function fakeStreamWithPump() {
  let processEventBatch: ((batch: StreamEventBatch) => unknown) | undefined;
  const delivered: Promise<unknown>[] = [];
  const stream = {
    subscribeOutbound(args: { processEventBatch: (batch: StreamEventBatch) => unknown }) {
      processEventBatch = args.processEventBatch;
      return { subscriptionKey: "k", streamMaxOffset: 0, unsubscribe() {} };
    },
    append: (input: unknown) => input,
    appendBatch: (input: unknown) => input,
  };
  function pump(events: StreamEvent[]) {
    if (processEventBatch === undefined) throw new Error("not subscribed");
    // cursor would advance here; we just hand the batch over and never await it.
    const result = processEventBatch({
      namespace: "stream",
      path: "/r",
      events,
      streamMaxOffset: 0,
    });
    if (result instanceof Promise) delivered.push(result.catch(() => undefined));
  }
  return { stream, pump, settle: () => Promise.allSettled(delivered) };
}

describe("T1 — a swallowed ingest failure permanently drops events (C1)", () => {
  // FAILS until C1 is fixed (host must resubscribe from the checkpoint on
  // ingest failure). Flip `it.fails` -> `it` once Stage 1 lands.
  it.fails("redelivers a failed batch instead of skipping past it", async () => {
    const { ctx, settle: settleCtx } = fakeDurableObjectCtx();
    const { stream, pump, settle: settlePump } = fakeStreamWithPump();
    const host = createStreamProcessorHost(ctx);

    let failNextBatch = true;
    host.add(
      "counter",
      (deps) =>
        new CounterProcessor({
          ...deps,
          onBatch: () => {
            if (failNextBatch) {
              failNextBatch = false;
              throw new Error("transient ingest failure");
            }
          },
        }),
    );

    await host.requestStreamSubscription({
      stream: stream as never,
      subscriptionKey: "k",
      streamMaxOffset: 0,
      subscriptionConfiguredEvent: { offset: 0 } as never,
      streamRuntimeState: { coreProcessorState: { namespace: "stream", path: "/r" } as never },
    });

    pump([add(1, 5)]); // fails, swallowed; cursor advances past offset 1
    await tick();
    pump([add(2, 7)]); // succeeds
    await settlePump();
    await settleCtx();

    // Both events must end up in reduced state. Today event 1 is lost forever.
    expect(host.runtimeState("counter").snapshot?.state).toEqual({ total: 12 });
  });
});

describe("T2 — writeState failure advances the in-memory checkpoint (C2)", () => {
  // FAILS until C2 is fixed (assign #state/#checkpointOffset only after
  // #saveSnapshot succeeds). Flip `it.fails` -> `it` once Stage 1 lands.
  it.fails("persists a snapshot when a writeState failure is retried", async () => {
    const writes: StreamProcessorSnapshot<{ total: number }>[] = [];
    let failNextWrite = true;
    const processor = new CounterProcessor({
      iterateContext: iterateContext(),
      writeState: (snapshot) => {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error("storage write failed");
        }
        writes.push(snapshot);
      },
    });

    await expect(processor.ingest({ events: [add(1, 5)], streamMaxOffset: 1 })).rejects.toThrow(
      "storage write failed",
    );

    // The host trusts "failed => retries"; redeliver the same batch.
    await processor.ingest({ events: [add(1, 5)], streamMaxOffset: 1 });

    // A durable snapshot must eventually exist. Today the retry no-ops because
    // the in-memory checkpoint already advanced past offset 1.
    expect(writes).toEqual([{ offset: 1, state: { total: 5 } }]);
  });
});

describe("T5 — circuit-breaker token bucket on a backwards clock (M3)", () => {
  // FAILS until M3 is fixed (clamp the refill delta with Math.max(0, ...)).
  // Flip `it.fails` -> `it` once Stage 1 lands.
  it.fails("does not drain the bucket when createdAt regresses", () => {
    const next = spendCircuitBreakerToken({
      state: {
        availableTokens: 5,
        lastRefillAtMs: 10_000,
        burstCapacity: 100_000,
        refillRatePerMinute: 6_000_000,
      },
      event: { createdAt: iso(9_000) }, // 1s earlier than lastRefillAtMs
    });

    // Spending one token from 5 should leave 4, not collapse to a huge negative.
    expect(next.availableTokens).toBe(4);
  });
});

describe("T6 — circuit-breaker misses a flood after tripping during replay (M4)", () => {
  // FAILS until M4 is fixed (fire the trip when tripped && offset > anchor &&
  // !pausedYet, not only on the not-tripped->tripped edge). Flip once fixed.
  it.fails("pauses on live events even when it tripped at/below the anchor", async () => {
    const committed: StreamEvent[] = [];
    const processor = new CircuitBreakerProcessor({
      iterateContext: {
        stream: {
          append: (args) => {
            const e = { ...args.event, offset: 100, createdAt: iso(1) } as StreamEvent;
            committed.push(e);
            return e;
          },
          appendBatch: () => [],
        },
      },
      // anchor = 4: offsets <= 4 reduce but run no side effects (replay).
      sideEffectsAfterOffset: () => 4,
    });

    await processor.ingest({
      events: [
        event("events.iterate.com/circuit-breaker/configured", 1, 1_000, {
          burstCapacity: 1,
          refillRatePerMinute: 1,
        }),
        event("test.widget", 2, 2_000),
        event("test.widget", 3, 3_000), // trips here (offset 3 <= anchor 4)
        event("test.widget", 4, 4_000),
        event("test.widget", 5, 5_000), // LIVE: should pause
        event("test.widget", 6, 6_000),
      ],
      streamMaxOffset: 6,
    });
    await tick();

    expect(committed.length).toBeGreaterThanOrEqual(1);
  });
});

void CircuitBreakerContract;

function event(
  type: string,
  offset: number,
  createdAtMs: number,
  payload: unknown = {},
): StreamEvent {
  return { type, payload, offset, createdAt: iso(createdAtMs) };
}

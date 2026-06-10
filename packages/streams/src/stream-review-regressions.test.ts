// Regression tests from the June 2026 packages/streams review.
// See tasks/streams-review-fixes.md — each test is tagged with its finding id.
//
// Tests for bugs that are still unfixed use `it.fails`: they PASS today because
// the asserted (correct) behavior currently throws/mismatches, and they START
// FAILING the moment the bug is fixed — at which point flip `it.fails` back to
// `it`. This keeps `pnpm test` green while pinning the bug precisely.
//
// Status: C1 (T1/T1b) and C2 (T2) are fixed in Stage 1 and now pass as `it`.
// M3 (T5) and M4 (T6) remain `it.fails` until Stage 3. The Stream DO tests
// (T3/T4/T7/T8) live in workers/durable-objects/stream.workers.test.ts.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineProcessorContract } from "./shared/stream-processors.ts";
import type { StreamEvent, StreamEventInput } from "./shared/event.ts";
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
type CounterDeps = { onBatch?: (args: { events: readonly StreamEvent[] }) => void };

class CounterProcessor extends StreamProcessor<CounterContract, CounterDeps> {
  readonly contract = CounterContract;
  protected override reduce(args: Parameters<StreamProcessor<CounterContract>["reduce"]>[0]) {
    return { total: args.state.total + args.event.payload.amount };
  }
  protected override async processEventBatch(
    args: Parameters<StreamProcessor<CounterContract>["processEventBatch"]>[0],
  ): Promise<void> {
    this.deps.onBatch?.({ events: args.events });
    await super.processEventBatch(args);
  }
}

function add(offset: number, amount: number): StreamEvent {
  return { type: "test/add", payload: { amount }, offset, createdAt: iso() };
}

// An in-memory DurableObjectState stub: just the kv + waitUntil surface the host
// touches. `settle()` drains the collected waitUntil work, including the chains
// spawned by recovery, until it goes quiet.
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
  async function settle() {
    let idleFlushes = 0;
    for (let i = 0; i < 500 && idleFlushes < 3; i += 1) {
      await tick(); // flush microtasks + queued pumps
      if (pending.length === 0) {
        idleFlushes += 1;
        continue;
      }
      idleFlushes = 0;
      await Promise.allSettled(pending.splice(0));
    }
  }
  return { ctx: ctx as unknown as DurableObjectState, settle };
}

// A faithful in-memory stream: an append log plus one live subscriber whose pump
// mirrors stream.ts #openConnection — it advances the cursor and fire-and-forgets
// each batch, and `subscribeOutbound({ replayAfterOffset })` replays everything
// past that offset. This is what makes the host's resubscribe-from-checkpoint
// recovery actually redeliver. `append` (used by the host for processor-registered
// / error-occurred events) is recorded so tests can assert on it.
function fakeStream() {
  const log: StreamEvent[] = [];
  const hostAppends: StreamEventInput[] = [];
  let deliver: ((batch: StreamEventBatch) => unknown) | undefined;
  let cursor = 0;

  const pump = () => {
    if (deliver === undefined) return;
    const batch = log.filter((event) => event.offset > cursor);
    if (batch.length === 0) return;
    cursor = batch.at(-1)!.offset;
    void Promise.resolve(
      deliver({
        namespace: "stream",
        path: "/r",
        events: batch,
        streamMaxOffset: log.at(-1)?.offset ?? 0,
      }),
    ).catch(() => undefined);
  };

  const push = (input: StreamEventInput): StreamEvent => {
    const event: StreamEvent = {
      ...input,
      offset: (log.at(-1)?.offset ?? 0) + 1,
      createdAt: iso(),
    };
    log.push(event);
    pump();
    return event;
  };

  const stream = {
    subscribeOutbound(args: {
      subscriptionKey?: string;
      replayAfterOffset?: number;
      processEventBatch: (batch: StreamEventBatch) => unknown;
    }) {
      deliver = args.processEventBatch;
      cursor = args.replayAfterOffset ?? 0;
      queueMicrotask(pump);
      return {
        subscriptionKey: args.subscriptionKey ?? "k",
        streamMaxOffset: log.at(-1)?.offset ?? 0,
        unsubscribe() {
          if (deliver === args.processEventBatch) deliver = undefined;
        },
      };
    },
    append(args: { event: StreamEventInput }) {
      hostAppends.push(args.event);
      return push(args.event);
    },
    appendBatch(args: { events: StreamEventInput[] }) {
      return args.events.map(push);
    },
  };

  // External producer: append a user event to the stream (drives delivery).
  const produce = (input: StreamEventInput) => push(input);
  return { stream, produce, hostAppends };
}

const subscribeArgs = (stream: ReturnType<typeof fakeStream>["stream"]) => ({
  stream: stream as never,
  subscriptionKey: "k",
  streamMaxOffset: 0,
  subscriptionConfiguredEvent: { offset: 0 } as never,
  streamRuntimeState: { coreProcessorState: { namespace: "stream", path: "/r" } as never },
});

describe("T1 — a failed batch must not drop events under continued delivery (C1)", () => {
  // Fixed in Stage 1: on ingest failure the host re-handshakes from the durable
  // checkpoint and the stream replays the batch; batches delivered on the
  // superseded connection are dropped so a later one can't advance the
  // checkpoint past the gap.
  it("recovers a transient failure even while later events keep arriving", async () => {
    const { ctx, settle } = fakeDurableObjectCtx();
    const { stream, produce } = fakeStream();
    const host = createStreamProcessorHost(ctx);

    let failOnAdd = true;
    host.add(
      "counter",
      (deps) =>
        new CounterProcessor({
          ...deps,
          onBatch: ({ events }) => {
            // Fail the first delivery that carries a user add, once.
            if (failOnAdd && events.some((event) => event.type === "test/add")) {
              failOnAdd = false;
              throw new Error("transient ingest failure");
            }
          },
        }),
    );

    await host.requestStreamSubscription(subscribeArgs(stream));
    await settle(); // process the auto-appended processor-registered event

    // Two adds arrive close together: the first fails, the second is delivered
    // on the same (now superseded) connection before recovery completes.
    produce({ type: "test/add", payload: { amount: 5 } });
    produce({ type: "test/add", payload: { amount: 7 } });
    await settle();

    // Neither add may be lost: 5 + 7.
    expect(host.runtimeState("counter").snapshot?.state).toEqual({ total: 12 });
  });
});

describe("T1b — a poison batch records an error and disconnects (C1 poison policy)", () => {
  it("appends stream/error-occurred and stops after repeated failures", async () => {
    const { ctx, settle } = fakeDurableObjectCtx();
    const { stream, produce, hostAppends } = fakeStream();
    const host = createStreamProcessorHost(ctx);

    host.add(
      "counter",
      (deps) =>
        new CounterProcessor({
          ...deps,
          onBatch: ({ events }) => {
            if (events.some((event) => event.type === "test/add")) {
              throw new Error("poison batch");
            }
          },
        }),
    );

    await host.requestStreamSubscription(subscribeArgs(stream));
    await settle();

    produce({ type: "test/add", payload: { amount: 5 } });
    await settle();

    // The processor never advanced (the add never ingested) ...
    expect(host.runtimeState("counter").snapshot?.state).toEqual({ total: 0 });
    // ... and the host recorded the failure on the stream then disconnected.
    const errorEvents = hostAppends.filter(
      (event) => event.type === "events.iterate.com/stream/error-occurred",
    );
    expect(errorEvents).toHaveLength(1);
  });
});

describe("T2 — writeState failure advances the in-memory checkpoint (C2)", () => {
  // Fixed in Stage 1: the snapshot is written before #state/#checkpointOffset
  // advance, so a failed write leaves the batch retryable.
  it("persists a snapshot when a writeState failure is retried", async () => {
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

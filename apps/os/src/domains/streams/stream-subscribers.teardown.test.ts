// Regression: idle teardown must not defeat itself (thermo review, blocker 1).
//
// The subtlety the main spine suite's harness hides: `appendFact` in REALITY
// appends into the stream's log — the subscriber-disconnected facts teardown
// produces bump `maxOffset`, and append's post-commit fan-out calls `wake()`.
// A harness that keeps facts out of the log can never catch a teardown that
// re-pokes off its own facts, which is exactly the bug the review reproduced.
// This file drives the real module with a DO-faithful harness: facts land in
// the log, every fact-append triggers wake(), parked facts fold.

import { describe, expect, it } from "vitest";
import {
  CoreProcessorContract,
  type SubscriptionConfiguredPayload,
} from "./core-processor-contract.ts";
import type { StreamEvent, StreamEventInput } from "./schemas.ts";
import { StreamSubscribers } from "./stream-subscribers.ts";
import type { RetainedProcessEventBatch } from "./subscriber-sinks.ts";
import type { SubscriptionCursorRow, SubscriptionCursorStore } from "./stream-storage.ts";

type PokeImpl = (request: { subscriptionKey: string }) => Promise<{
  checkpointOffset: number;
  sink: RetainedProcessEventBatch;
}>;

function makeFaithfulHarness(pokeImpl?: PokeImpl) {
  const log: StreamEvent[] = [];
  const rows = new Map<string, SubscriptionCursorRow>();
  const configured: Record<string, { latestConfiguredEvent: any; parkedAtOffset?: number }> = {};
  const pokes: string[] = [];
  const kept: Promise<unknown>[] = [];
  let sinkAlive = true;

  let lastEpoch = 0;
  const store: SubscriptionCursorStore = {
    get: (k) => rows.get(k),
    list: () => [...rows.values()],
    ensure: (k, acked) => {
      if (!rows.has(k)) {
        lastEpoch += 1;
        rows.set(k, {
          subscriptionKey: k,
          ackedOffset: acked,
          attempt: 0,
          nextAttemptAt: null,
          lastError: null,
          epoch: lastEpoch,
        });
      }
    },
    ack: (k, acked, epoch) => {
      const row = rows.get(k);
      if (!row) return;
      if (epoch !== undefined && row.epoch !== epoch) return;
      row.ackedOffset = Math.max(row.ackedOffset, acked);
      row.attempt = 0;
      row.nextAttemptAt = null;
      row.lastError = null;
    },
    advanceWatermark: (k, acked) => {
      const row = rows.get(k);
      if (!row) return;
      row.ackedOffset = Math.max(row.ackedOffset, acked);
      row.nextAttemptAt = null;
    },
    nack: (k, args) => {
      const row = rows.get(k);
      if (!row) return;
      Object.assign(row, {
        attempt: args.attempt,
        nextAttemptAt: args.nextAttemptAt,
        lastError: args.error,
      });
    },
    setCursor: (k, acked) => {
      const row = rows.get(k);
      if (!row) return;
      lastEpoch += 1;
      Object.assign(row, {
        ackedOffset: acked,
        attempt: 0,
        nextAttemptAt: null,
        lastError: null,
        epoch: lastEpoch,
      });
    },
    delete: (k) => void rows.delete(k),
    minNextAttemptAt: () => {
      const pending = [...rows.values()]
        .map((row) => row.nextAttemptAt)
        .filter((at): at is number => at !== null);
      return pending.length === 0 ? null : Math.min(...pending);
    },
  };

  // Faithful append: facts land in the log, fold parked/resumed like the
  // reducer, and — the load-bearing part — the post-commit fan-out wakes the
  // spine, exactly like StreamDurableObject.append does.
  const append = (input: StreamEventInput): void => {
    const event: StreamEvent = {
      ...input,
      offset: log.length + 1,
      createdAt: new Date(log.length + 1).toISOString(),
      path: "/t",
    } as StreamEvent;
    log.push(event);
    if (event.type === "events.iterate.com/stream/subscription-parked") {
      const key = (event.payload as { subscriptionKey: string }).subscriptionKey;
      const entry = configured[key];
      if (entry) entry.parkedAtOffset = (event.payload as { atOffset: number }).atOffset;
    }
    subscribers.wake();
  };

  const subscribers = new StreamSubscribers({
    idleTeardownMs: 60_000,
    hooks: {
      readEvents: ({ afterOffset, limit }) =>
        log
          .filter((event) => event.offset > afterOffset)
          .slice(0, limit)
          .map((event) => ({ event, byteLength: JSON.stringify(event).length })),
      coreState: () =>
        CoreProcessorContract.stateSchema.parse({
          projectId: "p1",
          path: "/t",
          maxOffset: log.length,
          eventCount: log.length,
          configuredSubscribersByKey: configured,
        }),
      includeEphemeral: () => false,
      store,
      dial: {
        poke: async (_expression, request) => {
          pokes.push(request.subscriptionKey);
          if (pokeImpl !== undefined) return pokeImpl(request);
          const sink = Object.assign(() => undefined, {
            [Symbol.dispose]() {
              sinkAlive = false;
            },
          }) as RetainedProcessEventBatch;
          sinkAlive = true;
          return { checkpointOffset: log.length, sink };
        },
        push: async () => undefined,
        webhook: async () => undefined,
      },
      appendFact: (event) => {
        append(event);
        return true;
      },
      recordEgress: () => undefined,
      now: () => Date.now(),
      random: () => 0.5,
      armAlarm: () => undefined,
      keepAlive: (promise) => void kept.push(promise),
    },
  });

  const settle = async () => {
    for (let round = 0; round < 10; round += 1) {
      await Promise.allSettled([...kept]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  const wakePayload: SubscriptionConfiguredPayload = {
    subscriptionKey: "k",
    delivery: {
      mode: "wake",
      expression: ["agents", ["get", "/t"], "processor", "wakeStreamSubscriber"],
    },
  };

  return {
    subscribers,
    log,
    pokes,
    configured,
    append,
    settle,
    wakePayload,
    row: (k: string) => rows.get(k),
    sinkAlive: () => sinkAlive,
  };
}

describe("StreamSubscribers with a DO-faithful (log-appending) harness", () => {
  it("idle teardown does not re-poke off its own disconnect facts", async () => {
    const h = makeFaithfulHarness();
    h.configured["k"] = {
      latestConfiguredEvent: {
        offset: 1,
        type: "events.iterate.com/stream/subscription-configured",
        payload: h.wakePayload,
        createdAt: new Date(1).toISOString(),
      },
    };
    h.append({
      type: "events.iterate.com/stream/subscription-configured",
      payload: h.wakePayload,
    });
    h.subscribers.onSubscriptionConfigured(h.wakePayload as never, 1);
    await h.settle();
    expect(h.pokes).toHaveLength(1);
    expect(h.subscribers.hasConnection("k")).toBe(true);

    // The bug this pins: teardown appends subscriber-disconnected (bumping
    // maxOffset) and that append's wake() used to see fresh lag and re-poke
    // immediately, resurrecting the connection it just severed.
    const pokesBefore = h.pokes.length;
    h.subscribers.runIdleTeardownNow();
    await h.settle();

    expect(h.pokes.length).toBe(pokesBefore);
    expect(h.subscribers.hasConnection("k")).toBe(false);
    // The retained sink was DISPOSED, not just forgotten: the whole point of
    // idle teardown is releasing the RPC stubs that pin the stream and its
    // subscriber DOs resident (the mutual-stub-pinning incident class).
    expect(h.sinkAlive()).toBe(false);
    // The watermark covers the teardown's own facts...
    expect(h.row("k")?.ackedOffset).toBe(h.log.length);

    // ...but genuinely new lag still pokes: the stream is not wedged asleep.
    h.append({ type: "test/event", payload: {} });
    await h.settle();
    expect(h.pokes.length).toBe(pokesBefore + 1);
  });

  it("idle teardown of a WEDGED sink keeps the watermark honest and re-pokes", async () => {
    // "Delivered into the sink" is not "ingested": a sink whose last batch
    // never settles belongs to a wedged subscriber. The old teardown ack'd
    // its watermark to maxOffset anyway, deferring redelivery until the next
    // append — indefinitely on a quiet stream.
    let pokes = 0;
    const h = makeFaithfulHarness(async () => {
      pokes += 1;
      const sink = Object.assign(() => undefined, {
        pendingDeliveries: () => 1, // permanently unsettled delivery
        [Symbol.dispose]() {},
      }) as RetainedProcessEventBatch;
      return { checkpointOffset: 0, sink };
    });
    h.configured["k"] = {
      latestConfiguredEvent: {
        offset: 1,
        type: "events.iterate.com/stream/subscription-configured",
        payload: h.wakePayload,
        createdAt: new Date(1).toISOString(),
      },
    };
    h.append({
      type: "events.iterate.com/stream/subscription-configured",
      payload: h.wakePayload,
    });
    h.subscribers.onSubscriptionConfigured(h.wakePayload as never, 1);
    await h.settle();
    expect(pokes).toBe(1);
    const watermarkBefore = h.row("k")?.ackedOffset ?? 0;

    h.subscribers.runIdleTeardownNow();
    await h.settle();

    // No over-ack past the wedged batch...
    expect(h.row("k")?.ackedOffset).toBe(watermarkBefore);
    // ...and the teardown itself queued the re-poke (supersede the wedged
    // connection) instead of leaving the stream asleep until the next append.
    expect(pokes).toBeGreaterThanOrEqual(2);
  });

  it("a poke fenced off by a config replacement re-reconciles immediately (liveness)", async () => {
    let releaseFirstPoke: (() => void) | undefined;
    const disposed: string[] = [];
    let pokeCount = 0;
    const h = makeFaithfulHarness(async () => {
      pokeCount += 1;
      const mine = pokeCount;
      if (mine === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstPoke = resolve;
        });
      }
      const sink = Object.assign(() => undefined, {
        [Symbol.dispose]() {
          disposed.push(`sink-${mine}`);
        },
      }) as RetainedProcessEventBatch;
      return { checkpointOffset: 0, sink };
    });

    const configure = (offset: number) => {
      h.configured["k"] = {
        latestConfiguredEvent: {
          offset,
          type: "events.iterate.com/stream/subscription-configured",
          payload: h.wakePayload,
          createdAt: new Date(offset).toISOString(),
        },
      };
    };

    configure(1);
    h.append({
      type: "events.iterate.com/stream/subscription-configured",
      payload: h.wakePayload,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pokeCount).toBe(1); // first poke in flight, blocked

    // Replace the config (same mode, new config offset) while the poke flies.
    configure(2);
    h.append({
      type: "events.iterate.com/stream/subscription-configured",
      payload: h.wakePayload,
    });
    h.subscribers.onSubscriptionConfigured(h.wakePayload as never, 2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Still blocked on the first poke; the in-flight reservation prevents a second.
    expect(pokeCount).toBe(1);

    releaseFirstPoke!();
    await h.settle();

    // The stale poke's sink was dropped by the fence, AND the new config got
    // its own poke without waiting for the next append — the liveness gap
    // thermo round 2 flagged.
    expect(disposed).toContain("sink-1");
    expect(pokeCount).toBe(2);
    expect(h.subscribers.hasConnection("k")).toBe(true);
  });

  it("recovery makes an in-flight pre-recovery poke inert", async () => {
    let releasePoke: (() => void) | undefined;
    let sinkDisposed = false;
    const h = makeFaithfulHarness(async () => {
      await new Promise<void>((resolve) => {
        releasePoke = resolve;
      });
      const sink = Object.assign(() => undefined, {
        [Symbol.dispose]() {
          sinkDisposed = true;
        },
      }) as RetainedProcessEventBatch;
      return { checkpointOffset: 999, sink };
    });
    h.configured["k"] = {
      latestConfiguredEvent: {
        offset: 1,
        type: "events.iterate.com/stream/subscription-configured",
        payload: h.wakePayload,
        createdAt: new Date(1).toISOString(),
      },
    };
    h.append({
      type: "events.iterate.com/stream/subscription-configured",
      payload: h.wakePayload,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.pokes).toHaveLength(1);

    h.subscribers.resetForRecovery();
    releasePoke!();
    await h.settle();

    expect(sinkDisposed).toBe(true);
    expect(h.subscribers.hasConnection("k")).toBe(false);
    expect(h.row("k")?.ackedOffset).not.toBe(999);
  });

  it("recovery closes live connections without appending into the replaced log", () => {
    const h = makeFaithfulHarness();
    h.subscribers.openEphemeral({ subscriptionKey: "live", sink: () => undefined });
    const eventCountBeforeReset = h.log.length;

    h.subscribers.resetForRecovery();

    expect(h.subscribers.hasConnection("live")).toBe(false);
    expect(h.log).toHaveLength(eventCountBeforeReset);
  });
});

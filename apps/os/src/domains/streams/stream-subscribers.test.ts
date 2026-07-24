// The delivery spine, driven entirely in plain node: an in-memory cursor
// store, a fake event log, a controllable clock, and a scripted dial stand in
// for SQLite, the Durable Object alarm, and RPC. Every scenario here is one
// lettered behavior of stream-subscribers.ts — push drains, selector
// skip-not-defer, backoff/park/resume, poison bisection, wake pokes with the
// observational watermark, and the ephemeral lane.

import { describe, expect, it, vi } from "vitest";
import type {
  StreamEventBatch,
  StreamPushEventBatch,
  StreamSubscriberWakeRequest,
  StreamWakeEventBatch,
  StreamWebhookDelivery,
} from "iterate/processors";
import {
  STREAM_PROCESSOR_REVIVED_EVENT_TYPE,
  StreamReceiverUnavailableError,
} from "iterate/processors";
import type { StreamEvent, StreamEventInput } from "iterate/processors";
import type { ItxExpression } from "../../itx/expression.ts";
import type {
  CoreProcessorState,
  SubscriptionConfiguredPayload,
} from "./core-processor-contract.ts";
import { CoreProcessorContract } from "./core-processor-contract.ts";
import { compileEventSelector } from "./event-selector.ts";
import type { SubscriptionCursorRow, SubscriptionCursorStore } from "./stream-storage.ts";
import { StreamSubscribers, type SubscriberDial } from "./stream-subscribers.ts";
import {
  MAX_DELIVERY_ATTEMPTS,
  SKIP_CONFIRM_ATTEMPTS,
  computeBackoffMs,
} from "./subscriber-math.ts";
import { retainProcessEventBatch, type RetainedProcessEventBatch } from "./subscriber-sinks.ts";

const PARKED = "events.iterate.com/stream/subscription-parked";
const ERROR_OCCURRED = "events.iterate.com/stream/error-occurred";
const CONNECTED = "events.iterate.com/stream/subscriber-connected";
const DISCONNECTED = "events.iterate.com/stream/subscriber-disconnected";

/** Committed-event helper: offset doubles as the (fake) creation time. */
function evt(offset: number, type: string, payload?: Record<string, unknown>): StreamEvent {
  return {
    type,
    offset,
    createdAt: new Date(offset).toISOString(),
    path: "/t",
    ...(payload === undefined ? {} : { payload }),
  };
}

/**
 * Faithful in-memory twin of the SQLite cursor store: ack is a monotonic max
 * that clears failure state, ensure never resets, setCursor overwrites and
 * clears failure state, and updates on absent rows are no-ops (SQL UPDATE
 * semantics).
 */
class FakeCursorStore implements SubscriptionCursorStore {
  readonly rows = new Map<string, SubscriptionCursorRow>();
  #lastEpoch = 0;

  get(subscriptionKey: string): SubscriptionCursorRow | undefined {
    const row = this.rows.get(subscriptionKey);
    return row === undefined ? undefined : { ...row };
  }

  list(): SubscriptionCursorRow[] {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  ensure(subscriptionKey: string, ackedOffset: number): void {
    if (this.rows.has(subscriptionKey)) return;
    this.#lastEpoch += 1;
    this.rows.set(subscriptionKey, {
      subscriptionKey,
      ackedOffset,
      attempt: 0,
      nextAttemptAt: null,
      lastError: null,
      epoch: this.#lastEpoch,
    });
  }

  ack(subscriptionKey: string, ackedOffset: number, epoch?: number): void {
    const row = this.rows.get(subscriptionKey);
    if (row === undefined) return;
    if (epoch !== undefined && row.epoch !== epoch) return;
    row.ackedOffset = Math.max(row.ackedOffset, ackedOffset);
    row.attempt = 0;
    row.nextAttemptAt = null;
    row.lastError = null;
  }

  advanceWatermark(subscriptionKey: string, ackedOffset: number): void {
    const row = this.rows.get(subscriptionKey);
    if (row === undefined) return;
    row.ackedOffset = Math.max(row.ackedOffset, ackedOffset);
    row.nextAttemptAt = null;
  }

  nack(
    subscriptionKey: string,
    args: { attempt: number; nextAttemptAt: number; error: string },
  ): void {
    const row = this.rows.get(subscriptionKey);
    if (row === undefined) return;
    row.attempt = args.attempt;
    row.nextAttemptAt = args.nextAttemptAt;
    row.lastError = args.error.slice(0, 2_000);
  }

  park(subscriptionKey: string, args: { attempt: number; error: string }): void {
    const row = this.rows.get(subscriptionKey);
    if (row === undefined) return;
    row.attempt = args.attempt;
    row.nextAttemptAt = null;
    row.lastError = args.error.slice(0, 2_000);
  }

  setCursor(subscriptionKey: string, ackedOffset: number): void {
    const row = this.rows.get(subscriptionKey);
    if (row === undefined) return;
    this.#lastEpoch += 1;
    row.ackedOffset = ackedOffset;
    row.attempt = 0;
    row.nextAttemptAt = null;
    row.lastError = null;
    row.epoch = this.#lastEpoch;
  }

  delete(subscriptionKey: string): void {
    this.rows.delete(subscriptionKey);
  }

  minNextAttemptAt(): number | null {
    let min: number | null = null;
    for (const row of this.rows.values()) {
      if (row.nextAttemptAt !== null && (min === null || row.nextAttemptAt < min)) {
        min = row.nextAttemptAt;
      }
    }
    return min;
  }
}

type PokeResult = Awaited<ReturnType<SubscriberDial["poke"]>>;

/** Folded desired state for one subscription key, as the core reducer would keep it. */
type ConfiguredEntry = {
  latestConfiguredEvent: {
    offset: number;
    type: "events.iterate.com/stream/subscription-configured";
    payload: SubscriptionConfiguredPayload;
    createdAt: string;
  };
  parkedAtOffset?: number;
};

function makeHarness(
  options: {
    runDurable?: (work: () => Promise<unknown>) => void;
  } = {},
) {
  let now = 0;
  let assignedMaxOffset = 0;
  let streamCreatedAt: string | undefined = "stream-v1";
  const log: StreamEvent[] = [];
  const store = new FakeCursorStore();
  const facts: StreamEventInput[] = [];
  const armedAlarms: number[] = [];
  const kept: Promise<unknown>[] = [];
  const egress: { count: number; bytes: number }[] = [];
  let runtimeChanges = 0;
  const pendingDeliveryStates: boolean[] = [];
  const configured: Record<string, ConfiguredEntry> = {};

  const pokes: StreamSubscriberWakeRequest[] = [];
  const pushes: StreamPushEventBatch[] = [];
  const pushOutcomes: ("resolved" | "rejected")[] = [];
  const webhooks: { url: string; delivery: StreamWebhookDelivery }[] = [];

  // Scripted behaviors, swappable per test. The dial wrapper below records
  // every invocation regardless of the scripted outcome.
  const dialImpl = {
    poke: ((): Promise<PokeResult> =>
      Promise.reject(new Error("dial.poke not scripted for this test"))) as (
      expression: ItxExpression,
      request: StreamSubscriberWakeRequest,
    ) => Promise<PokeResult>,
    push: ((): Promise<void> => Promise.resolve()) as (
      batch: StreamPushEventBatch,
    ) => Promise<void>,
    webhook: ((): Promise<void> => Promise.resolve()) as (
      delivery: StreamWebhookDelivery,
    ) => Promise<void>,
  };

  const dial: SubscriberDial = {
    poke: (expression, request) => {
      pokes.push(request);
      return dialImpl.poke(expression, request);
    },
    push: async (_expression, batch) => {
      pushes.push(batch);
      try {
        await dialImpl.push(batch);
      } catch (error) {
        pushOutcomes.push("rejected");
        throw error;
      }
      pushOutcomes.push("resolved");
    },
    webhook: async (url, delivery) => {
      webhooks.push({ url, delivery });
      await dialImpl.webhook(delivery);
    },
  };

  let storageReads = 0;
  let subscribers!: StreamSubscribers;
  subscribers = new StreamSubscribers({
    idleTeardownMs: 60_000,
    hooks: {
      readEvents: ({ afterOffset, limit }) => {
        storageReads += 1;
        return log
          .filter((event) => event.offset > afterOffset)
          .slice(0, limit)
          .map((event) => ({ event, byteLength: JSON.stringify(event).length }));
      },
      coreState: (): CoreProcessorState =>
        CoreProcessorContract.stateSchema.parse({
          projectId: "p1",
          path: "/t",
          createdAt: streamCreatedAt,
          maxOffset: assignedMaxOffset,
          configuredSubscribersByKey: configured,
        }),
      store,
      dial,
      appendFact: (event) => {
        facts.push(event);
        // Mimic the core reducer: a parked fact folds into desired state, and
        // the spine reads parked-ness from coreState().
        if (event.type === PARKED) {
          const payload = event.payload as { subscriptionKey: string; atOffset: number };
          const entry = configured[payload.subscriptionKey];
          if (entry !== undefined) entry.parkedAtOffset = payload.atOffset;
        }
      },
      recordEgress: (count, bytes) => egress.push({ count, bytes }),
      runtimeChanged: () => {
        runtimeChanges += 1;
        pendingDeliveryStates.push(
          Object.values(subscribers.connectionRuntimeState()).some(
            (connection) => connection.hasPendingDelivery,
          ),
        );
      },
      now: () => now,
      random: () => 0.5,
      armAlarm: (atMs) => armedAlarms.push(atMs),
      runDurable: options.runDurable ?? ((work) => kept.push(work())),
      keepAlive: (promise) => kept.push(promise),
    },
  });

  /** Await every kept promise (and any it spawned), then flush microtask chains. */
  const settle = async () => {
    let seen = -1;
    while (seen !== kept.length) {
      seen = kept.length;
      await Promise.allSettled([...kept]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  return {
    subscribers,
    store,
    facts,
    armedAlarms,
    egress,
    runtimeChanges: () => runtimeChanges,
    pendingDeliveryStates: () => pendingDeliveryStates,
    pokes,
    pushes,
    pushOutcomes,
    webhooks,
    dialImpl,
    configured,
    log,
    settle,
    append: (...events: StreamEvent[]) => {
      assignedMaxOffset = Math.max(assignedMaxOffset, ...events.map((event) => event.offset));
      return log.push(...events);
    },
    evict: (...offsets: number[]) => {
      const evicted = new Set(offsets);
      for (let index = log.length - 1; index >= 0; index -= 1) {
        if (evicted.has(log[index]!.offset)) log.splice(index, 1);
      }
    },
    storageReads: () => storageReads,
    now: () => now,
    advanceTo: (ms: number) => {
      now = ms;
    },
    setIncarnation: (createdAt: string | undefined) => {
      streamCreatedAt = createdAt;
    },
    configure: (payload: SubscriptionConfiguredPayload, offset = 0) => {
      configured[payload.subscriptionKey] = {
        latestConfiguredEvent: {
          offset,
          type: "events.iterate.com/stream/subscription-configured",
          payload,
          createdAt: new Date(offset).toISOString(),
        },
      };
    },
    factsOfType: (type: string) => facts.filter((fact) => fact.type === type),
    row: (subscriptionKey: string) => store.get(subscriptionKey),
  };
}

/** wake(), then fire the alarm whenever a retry is pending, until `parks` park facts exist. */
async function driveUntilParked(h: ReturnType<typeof makeHarness>, parks = 1): Promise<void> {
  h.subscribers.wake();
  await h.settle();
  for (let round = 0; round < 400 && h.factsOfType(PARKED).length < parks; round += 1) {
    const next = h.store.minNextAttemptAt();
    if (next === null) throw new Error("no pending retry while driving toward park");
    h.advanceTo(Math.max(h.now(), next) + 1);
    h.subscribers.onAlarm();
    await h.settle();
  }
  if (h.factsOfType(PARKED).length < parks) throw new Error("subscription never parked");
}

function pushPayload(
  overrides: Partial<SubscriptionConfiguredPayload> = {},
): SubscriptionConfiguredPayload {
  return {
    subscriptionKey: "k",
    delivery: { mode: "push", expression: ["worker", "processEventBatch"] },
    deliver: "all",
    ...overrides,
  };
}

function wakePayload(): SubscriptionConfiguredPayload {
  return {
    subscriptionKey: "k",
    delivery: {
      mode: "wake",
      expression: ["agents", ["get", "/t"], "processor", "wakeStreamSubscriber"],
    },
  };
}

function webhookPayload(
  overrides: Partial<SubscriptionConfiguredPayload> = {},
): SubscriptionConfiguredPayload {
  return {
    subscriptionKey: "k",
    delivery: { mode: "webhook", url: "https://example.com/hook" },
    deliver: "all",
    ...overrides,
  };
}

/** A recording sink: a plain function with a no-op dispose, as the spine expects. */
function makeSink() {
  const batches: StreamEventBatch[] = [];
  const sink = Object.assign(
    (batch: StreamEventBatch) => {
      batches.push(batch);
      if ("settleDelivery" in batch) {
        (batch as StreamWakeEventBatch).settleDelivery({ outcome: "ok" });
      }
    },
    { [Symbol.dispose]: () => {} },
  ) as RetainedProcessEventBatch<StreamEventBatch>;
  return { sink, batches };
}

describe("StreamSubscribers", () => {
  it("hands durable delivery to its scheduler without starting the receiver call", async () => {
    const scheduled: (() => Promise<unknown>)[] = [];
    const h = makeHarness({ runDurable: (work) => scheduled.push(work) });
    h.configure(pushPayload(), 0);
    h.append(evt(1, "a"));

    h.subscribers.wake();

    expect(scheduled).toHaveLength(1);
    expect(h.pushes).toHaveLength(0);

    await scheduled[0]!();
    expect(h.pushes).toHaveLength(1);
    expect(h.row("k")?.ackedOffset).toBe(1);
  });

  it("a. push happy path: drains to the tail, acks, and resumes from the cursor", async () => {
    const h = makeHarness();
    h.configure(pushPayload(), 0);
    h.append(evt(1, "a"), evt(2, "b"), evt(3, "c"));

    h.subscribers.wake();
    await h.settle();

    expect(h.pushes).toHaveLength(1);
    const batch = h.pushes[0];
    expect(batch.events.map((event) => event.offset)).toEqual([1, 2, 3]);
    expect(batch.subscriptionKey).toBe("k");
    expect(batch.deliveryId).toBe("k:1-3");
    expect(batch.attempt).toBe(1);
    expect(batch.projectId).toBe("p1");
    expect(batch.path).toBe("/t");
    expect(batch.streamMaxOffset).toBe(3);
    expect(batch.configuredEvent).toMatchObject({
      type: "events.iterate.com/stream/subscription-configured",
      offset: 0,
      path: "/t",
    });
    expect((batch.configuredEvent.payload as SubscriptionConfiguredPayload).subscriptionKey).toBe(
      "k",
    );
    expect(h.row("k")).toMatchObject({ ackedOffset: 3, attempt: 0, nextAttemptAt: null });

    h.append(evt(4, "d"), evt(5, "e"));
    h.subscribers.wake();
    await h.settle();

    expect(h.pushes).toHaveLength(2);
    expect(h.pushes[1].events.map((event) => event.offset)).toEqual([4, 5]);
    expect(h.pushes[1].deliveryId).toBe("k:4-5");
    expect(h.row("k")?.ackedOffset).toBe(5);
  });

  it("b. selector skip-not-defer: non-matching events advance the cursor without a dial call", async () => {
    const h = makeHarness();
    h.configure(pushPayload({ selector: { eventTypes: ["a"] } }), 0);
    h.append(evt(1, "a"), evt(2, "b"), evt(3, "b"));

    h.subscribers.wake();
    await h.settle();

    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0].events.map((event) => event.offset)).toEqual([1]);
    // The cursor acks the last READ offset, not the last matched one.
    expect(h.row("k")?.ackedOffset).toBe(3);

    // A batch matching NOTHING still advances the cursor, with no dial call.
    h.append(evt(4, "b"), evt(5, "b"));
    h.subscribers.wake();
    await h.settle();

    expect(h.pushes).toHaveLength(1);
    expect(h.row("k")?.ackedOffset).toBe(5);
  });

  it("c. retry/backoff/alarm: failures back off exponentially, the alarm retries, success clears", async () => {
    const h = makeHarness();
    h.configure(pushPayload(), 0);
    h.append(evt(1, "a"));
    let failuresLeft = 2;
    h.dialImpl.push = async () => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error("receiver down");
      }
    };

    h.subscribers.wake();
    await h.settle();

    // One attempt, no immediate retry: the alarm owns the future.
    expect(h.pushes).toHaveLength(1);
    const afterFirst = h.row("k");
    expect(afterFirst).toMatchObject({ attempt: 1, ackedOffset: 0, lastError: "receiver down" });
    expect(afterFirst?.nextAttemptAt).not.toBeNull();
    const firstRetryAt = afterFirst!.nextAttemptAt!;
    expect(firstRetryAt).toBeGreaterThan(h.now());
    expect(firstRetryAt).toBeGreaterThanOrEqual(h.now() + computeBackoffMs(1, 0));
    expect(firstRetryAt).toBeLessThanOrEqual(h.now() + computeBackoffMs(1, 1));
    expect(h.armedAlarms).toContain(firstRetryAt);

    // A wake before the retry is due does nothing.
    h.subscribers.wake();
    await h.settle();
    expect(h.pushes).toHaveLength(1);

    h.advanceTo(firstRetryAt + 1);
    h.subscribers.onAlarm();
    await h.settle();

    expect(h.pushes).toHaveLength(2);
    expect(h.pushes[1].attempt).toBe(2);
    const afterSecond = h.row("k");
    expect(afterSecond?.attempt).toBe(2);
    const secondRetryAt = afterSecond!.nextAttemptAt!;
    expect(secondRetryAt).toBeGreaterThanOrEqual(h.now() + computeBackoffMs(2, 0));
    expect(secondRetryAt).toBeLessThanOrEqual(h.now() + computeBackoffMs(2, 1));

    h.advanceTo(secondRetryAt + 1);
    h.subscribers.onAlarm();
    await h.settle();

    expect(h.pushes).toHaveLength(3);
    expect(h.row("k")).toMatchObject({
      ackedOffset: 1,
      attempt: 0,
      nextAttemptAt: null,
      lastError: null,
    });
  });

  it("parks a terminal wake target failure immediately with the exact error", async () => {
    const h = makeHarness();
    h.configure(wakePayload(), 0);
    h.append(evt(1, "event"));
    h.dialImpl.poke = async () => {
      throw Object.assign(
        new Error('Entry point "github-ai-linter-worker.ts" was not found in files.'),
        { retryable: false },
      );
    };

    h.subscribers.wake();
    await h.settle();

    expect(h.pokes).toHaveLength(1);
    expect(h.factsOfType(PARKED)).toMatchObject([
      {
        payload: {
          subscriptionKey: "k",
          attempts: 1,
          error: 'Entry point "github-ai-linter-worker.ts" was not found in files.',
        },
      },
    ]);
    expect(h.row("k")).toMatchObject({
      attempt: 1,
      nextAttemptAt: null,
      lastError: 'Entry point "github-ai-linter-worker.ts" was not found in files.',
    });
    expect(h.armedAlarms).toHaveLength(0);
  });

  it("d. parks at MAX_DELIVERY_ATTEMPTS with one state-guarded parked fact, then goes silent", async () => {
    const h = makeHarness();
    h.configure(pushPayload(), 0);
    h.append(evt(1, "a"));
    h.dialImpl.push = async () => {
      throw new Error("still down");
    };

    await driveUntilParked(h);

    expect(h.pushes).toHaveLength(MAX_DELIVERY_ATTEMPTS);
    const parkedFacts = h.factsOfType(PARKED);
    // State-guarded, not idempotency-keyed: the fold's parkedAtOffset is what
    // suppresses duplicates, so a park after a resume at an unmoved cursor
    // still lands as a NEW fact (the park-resume-park regression below).
    expect(parkedFacts).toHaveLength(1);
    expect(parkedFacts[0].idempotencyKey).toBeUndefined();
    expect(parkedFacts[0].payload).toMatchObject({
      subscriptionKey: "k",
      atOffset: 0,
      attempts: MAX_DELIVERY_ATTEMPTS,
      error: "still down",
    });
    expect(h.configured["k"].parkedAtOffset).toBe(0);
    // The row mirrors the park fact — retry schedule cleared (a parked row
    // must not drive the alarm) but the failure evidence kept, so runtime
    // state can say WHY it parked without digging the fact out of the log.
    expect(h.row("k")).toMatchObject({
      ackedOffset: 0,
      attempt: MAX_DELIVERY_ATTEMPTS,
      nextAttemptAt: null,
      lastError: "still down",
    });

    // Parked means parked: further wakes make no dial calls.
    h.subscribers.wake();
    await h.settle();
    expect(h.pushes).toHaveLength(MAX_DELIVERY_ATTEMPTS);
    expect(h.factsOfType(PARKED)).toHaveLength(1);

    // Park-resume-park at the SAME cursor: the second park must land as a new
    // fact — the subscription turns red again instead of retrying forever.
    delete h.configured["k"].parkedAtOffset;
    h.subscribers.onResumed("k");
    await driveUntilParked(h, 2);
    expect(h.factsOfType(PARKED)).toHaveLength(2);
    expect(h.configured["k"].parkedAtOffset).toBe(0);
  });

  it("e. resume: onResumed retries immediately; a redrive is cursor-set then resume", async () => {
    const h = makeHarness();
    h.configure(pushPayload(), 0);
    h.append(evt(1, "a"), evt(2, "b"));
    h.dialImpl.push = async () => {
      throw new Error("down");
    };
    await driveUntilParked(h);
    expect(h.pushes).toHaveLength(MAX_DELIVERY_ATTEMPTS);

    // Receiver healed; the subscription-resumed fact folds (parked cleared)...
    h.dialImpl.push = async () => {};
    delete h.configured["k"].parkedAtOffset;
    // ...and the spine side effect kicks delivery immediately — no alarm involved.
    h.subscribers.onResumed("k");
    await h.settle();

    expect(h.pushes).toHaveLength(MAX_DELIVERY_ATTEMPTS + 1);
    expect(h.pushes.at(-1)?.events.map((event) => event.offset)).toEqual([1, 2]);
    expect(h.pushes.at(-1)?.attempt).toBe(1);
    expect(h.row("k")).toMatchObject({ ackedOffset: 2, attempt: 0, nextAttemptAt: null });

    // The redrive is two facts, each honest about what it did: cursor-set is
    // THE seek, resume is a pure un-park (v13 orthogonalization).
    h.subscribers.onCursorSet("k", 0);
    h.subscribers.onResumed("k");
    await h.settle();
    expect(h.pushes).toHaveLength(MAX_DELIVERY_ATTEMPTS + 2);
    expect(h.pushes.at(-1)?.events.map((event) => event.offset)).toEqual([1, 2]);
    expect(h.row("k")?.ackedOffset).toBe(2);
  });

  it("f. cursor-set: seeking to 0 after a successful drain re-delivers everything", async () => {
    const h = makeHarness();
    h.configure(pushPayload(), 0);
    h.append(evt(1, "a"), evt(2, "b"), evt(3, "c"));

    h.subscribers.wake();
    await h.settle();
    expect(h.pushes).toHaveLength(1);
    expect(h.row("k")?.ackedOffset).toBe(3);

    h.subscribers.onCursorSet("k", 0);
    await h.settle();

    expect(h.pushes).toHaveLength(2);
    expect(h.pushes[1].events.map((event) => event.offset)).toEqual([1, 2, 3]);
    expect(h.pushes[1].deliveryId).toBe("k:1-3");
    expect(h.row("k")?.ackedOffset).toBe(3);
  });

  it("g. onPoison skip: bisects down to the poison event, confirms it, records the skip, moves on", async () => {
    const h = makeHarness();
    h.configure(pushPayload({ onPoison: "skip" }), 0);
    h.append(evt(1, "a"), evt(2, "a"), evt(3, "a"), evt(4, "a"));
    h.dialImpl.push = async (batch) => {
      if (batch.events.some((event) => event.offset === 2)) {
        throw new Error("cannot digest offset 2");
      }
    };

    h.subscribers.wake();
    await h.settle();
    for (let round = 0; round < 40 && h.row("k")?.ackedOffset !== 4; round += 1) {
      const next = h.store.minNextAttemptAt();
      if (next === null) break;
      h.advanceTo(Math.max(h.now(), next) + 1);
      h.subscribers.onAlarm();
      await h.settle();
    }

    // The full deterministic delivery transcript: batch limits halve toward 1
    // (1000, 500, 250, 125, 62, 31, 15, 7, 3, 1) until offset 2 is isolated,
    // the lone event must fail SKIP_CONFIRM_ATTEMPTS deliveries, then delivery
    // steps over it.
    expect(h.pushes.map((batch) => batch.events.map((event) => event.offset))).toEqual([
      [1, 2, 3, 4], // limit 1000
      [1, 2, 3, 4], // limit 500
      [1, 2, 3, 4], // limit 250
      [1, 2, 3, 4], // limit 125
      [1, 2, 3, 4], // limit 62
      [1, 2, 3, 4], // limit 31
      [1, 2, 3, 4], // limit 15
      [1, 2, 3, 4], // limit 7
      [1, 2, 3], // limit 3
      [1], // limit 1 — clean, delivered; bisect window resets
      [2, 3, 4], // limit 1000 again
      [2, 3, 4], // limit 500
      [2, 3, 4], // limit 250
      [2, 3, 4], // limit 125
      [2, 3, 4], // limit 62
      [2, 3, 4], // limit 31
      [2, 3, 4], // limit 15
      [2, 3, 4], // limit 7
      [2, 3, 4], // limit 3
      [2], // isolated: confirm attempt 1 -> backoff
      [2], // confirm attempt 2 (alarm) -> backoff
      [2], // confirm attempt 3 (alarm) -> poison verdict, skipped
      [3, 4], // the rest delivers
    ]);
    expect(
      h.pushes.filter((batch) => batch.events.length === 1 && batch.events[0].offset === 2),
    ).toHaveLength(SKIP_CONFIRM_ATTEMPTS);
    expect(h.pushOutcomes.filter((outcome) => outcome === "resolved")).toHaveLength(2);

    const skipFacts = h.factsOfType(ERROR_OCCURRED);
    expect(skipFacts).toHaveLength(1);
    expect(skipFacts[0].idempotencyKey).toBe("push-poison-skipped:k:2");
    expect(h.factsOfType(PARKED)).toHaveLength(0);
    expect(h.row("k")).toMatchObject({ ackedOffset: 4, attempt: 0, nextAttemptAt: null });
  });

  it("h. skip mode parks when everything fails instead of mass-skipping the backlog", async () => {
    const h = makeHarness();
    h.configure(pushPayload({ onPoison: "skip" }), 0);
    h.append(evt(1, "a"), evt(2, "a"), evt(3, "a"), evt(4, "a"));
    h.dialImpl.push = async () => {
      throw new Error("receiver is down");
    };

    await driveUntilParked(h);

    // Two consecutive poison verdicts skipped, then the third parks the
    // subscription: a receiver that fails everything is down, not poisoned.
    const skipFacts = h.factsOfType(ERROR_OCCURRED);
    expect(skipFacts.map((fact) => fact.idempotencyKey)).toEqual([
      "push-poison-skipped:k:1",
      "push-poison-skipped:k:2",
    ]);
    const parkedFacts = h.factsOfType(PARKED);
    expect(parkedFacts).toHaveLength(1);
    expect(parkedFacts[0].idempotencyKey).toBeUndefined();
    expect(parkedFacts[0].payload).toMatchObject({ subscriptionKey: "k", atOffset: 2 });
    // NOT all events were skipped: offsets 3 and 4 are still owed delivery,
    // and the row keeps the parking error for runtime state to display.
    expect(h.row("k")).toMatchObject({
      ackedOffset: 2,
      attempt: SKIP_CONFIRM_ATTEMPTS,
      nextAttemptAt: null,
      lastError: "receiver is down",
    });
    expect(h.configured["k"].parkedAtOffset).toBe(2);
  });

  it("i. wake mode: pokes on lag, streams after the checkpoint, idle teardown advances the watermark", async () => {
    const h = makeHarness();
    h.configure(wakePayload(), 0);
    h.append(evt(1, "a"), evt(2, "a"), evt(3, "a"));
    const first = makeSink();
    h.dialImpl.poke = async () => ({ checkpointOffset: 2, sink: first.sink });

    h.subscribers.wake();
    await h.settle();

    expect(h.pokes).toHaveLength(1);
    expect(h.pokes[0]).toEqual({
      stream: { projectId: "p1", path: "/t", streamMaxOffset: 3 },
      subscriptionKey: "k",
    });
    expect(h.subscribers.hasConnection("k")).toBe(true);
    const connectedFacts = h.factsOfType(CONNECTED);
    expect(connectedFacts).toHaveLength(1);
    expect(connectedFacts[0].payload).toMatchObject({
      subscriptionKey: "k",
      subscriptionType: "configured",
    });
    // Observational watermark: the checkpoint the subscriber reported.
    expect(h.row("k")?.ackedOffset).toBe(2);
    // The connection pump replays everything after the checkpoint.
    expect(first.batches).toHaveLength(1);
    expect(first.batches[0].events.map((event) => event.offset)).toEqual([3]);
    expect(first.batches[0].streamMaxOffset).toBe(3);

    // Connection live: another wake does not poke again.
    h.subscribers.wake();
    await h.settle();
    expect(h.pokes).toHaveLength(1);
    expect(first.batches).toHaveLength(1);

    h.subscribers.runIdleTeardownNow();
    await h.settle();
    const disconnectedFacts = h.factsOfType(DISCONNECTED);
    expect(disconnectedFacts).toHaveLength(1);
    expect(disconnectedFacts[0].payload).toMatchObject({ subscriptionKey: "k", reason: "idle" });
    expect(h.subscribers.hasConnection("k")).toBe(false);
    // Teardown honestly advances the watermark to the connection cursor...
    expect(h.row("k")?.ackedOffset).toBe(3);

    // ...which keeps the post-teardown reconcile a no-op (caught up, no re-poke).
    h.subscribers.wake();
    await h.settle();
    expect(h.pokes).toHaveLength(1);

    // New lag re-pokes.
    const second = makeSink();
    h.dialImpl.poke = async () => ({ checkpointOffset: 3, sink: second.sink });
    h.append(evt(4, "a"));
    h.subscribers.wake();
    await h.settle();
    expect(h.pokes).toHaveLength(2);
    expect(h.subscribers.hasConnection("k")).toBe(true);
    expect(second.batches[0].events.map((event) => event.offset)).toEqual([4]);
  });

  it("wake selectors turn unconsumed revival facts into eventless caught-up deliveries", async () => {
    const h = makeHarness();
    h.configure(wakePayload(), 0);
    const firstRevival = evt(1, STREAM_PROCESSOR_REVIVED_EVENT_TYPE);
    h.append(firstRevival);
    const { sink, batches } = makeSink();
    h.dialImpl.poke = async () => ({
      checkpointOffset: 0,
      sink,
      subscriber: {
        processor: {
          announcement: {
            slug: "recovery-test",
            version: "0.0.1",
            description: "Does not consume processor revival facts.",
            consumes: ["events.iterate.com/recovery-test/requested"],
            emits: [],
            ownedEvents: [],
          },
        },
      },
    });

    h.subscribers.wake([{ event: firstRevival, byteLength: 64 }]);
    await h.settle();

    expect(h.pokes).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      events: [],
      scannedAfterOffset: 0,
      scannedThroughOffset: 1,
      streamMaxOffset: 1,
    });

    const secondRevival = evt(2, STREAM_PROCESSOR_REVIVED_EVENT_TYPE);
    h.append(secondRevival);
    h.subscribers.wake([{ event: secondRevival, byteLength: 64 }]);
    await h.settle();

    expect(h.pokes).toHaveLength(1);
    expect(batches[1]).toMatchObject({
      events: [],
      scannedAfterOffset: 1,
      scannedThroughOffset: 2,
      streamMaxOffset: 2,
    });
  });

  it("schedules idle teardown on the DO alarm without retaining the current turn", async () => {
    const h = makeHarness();
    h.configure(wakePayload(), 0);
    h.append(evt(1, "a"));
    const connection = makeSink();
    h.dialImpl.poke = async () => ({ checkpointOffset: 1, sink: connection.sink });

    h.subscribers.wake();
    await h.settle();
    expect(h.subscribers.hasConnection("k")).toBe(true);

    h.subscribers.armOrClearIdleAlarm();
    expect(h.armedAlarms.at(-1)).toBe(60_000);

    // Activity restarts the quiet window. The already-armed earlier alarm may
    // still fire, but it must only schedule the later deadline, not tear down.
    h.advanceTo(10_000);
    h.subscribers.armOrClearIdleAlarm();
    expect(h.armedAlarms.at(-1)).toBe(70_000);
    h.advanceTo(60_000);
    h.subscribers.onAlarm();
    expect(h.subscribers.hasConnection("k")).toBe(true);
    expect(h.armedAlarms.at(-1)).toBe(70_000);

    h.advanceTo(70_000);
    h.subscribers.onAlarm();
    await h.settle();
    expect(h.subscribers.hasConnection("k")).toBe(false);
    expect(h.factsOfType(DISCONNECTED)[0]?.payload).toMatchObject({ reason: "idle" });
  });

  it("expires an orphaned wake settlement on the DO alarm and backs off before re-poking", async () => {
    const h = makeHarness();
    h.configure(wakePayload(), 0);
    h.append(evt(1, "a"));
    let batch: StreamWakeEventBatch | undefined;
    h.dialImpl.poke = async () => ({
      checkpointOffset: 0,
      sink: Object.assign(
        (delivered: StreamWakeEventBatch) => {
          batch = delivered;
        },
        { [Symbol.dispose]: () => {} },
      ),
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warningLog = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      h.subscribers.wake();
      await h.settle();
      expect(batch).toBeDefined();
      expect(h.subscribers.hasConnection("k")).toBe(true);
      expect(h.armedAlarms).toContain(20_000);

      h.advanceTo(19_999);
      h.subscribers.onAlarm();
      await h.settle();
      expect(h.subscribers.hasConnection("k")).toBe(true);

      h.advanceTo(20_000);
      h.subscribers.onAlarm();
      await h.settle();

      expect(errorLog).not.toHaveBeenCalled();
      expect(warningLog).toHaveBeenCalledWith(
        "stream durable sink unavailable; backing off before re-poke",
        expect.objectContaining({
          subscriptionKey: "k",
          reason: "delivery-failed",
          error: expect.objectContaining({
            name: StreamReceiverUnavailableError.NAME,
            message: "wake k settlement timed out after 20000ms",
          }),
        }),
      );
      expect(h.subscribers.hasConnection("k")).toBe(false);
      expect(h.row("k")).toMatchObject({
        attempt: 1,
        lastError: "wake k settlement timed out after 20000ms",
      });
      expect(h.row("k")?.nextAttemptAt).toBeGreaterThan(20_000);
      expect(h.pokes).toHaveLength(1);
      expect(h.factsOfType(DISCONNECTED).at(-1)?.payload).toMatchObject({
        subscriptionKey: "k",
        reason: "delivery-failed",
      });

      // A successor owns recovery now; an acknowledgement from the orphaned
      // predecessor cannot clear backoff or mutate the closed connection.
      batch!.settleDelivery({ outcome: "ok" });
      await h.settle();
      expect(h.row("k")?.attempt).toBe(1);
    } finally {
      errorLog.mockRestore();
      warningLog.mockRestore();
    }
  });

  it("j. a poke failure lands in the same backoff rows as push failures", async () => {
    const h = makeHarness();
    h.configure(wakePayload(), 0);
    h.append(evt(1, "a"));
    h.dialImpl.poke = async () => {
      throw new Error("subscriber unreachable");
    };

    h.subscribers.wake();
    await h.settle();

    expect(h.pokes).toHaveLength(1);
    const row = h.row("k");
    expect(row).toMatchObject({ attempt: 1, lastError: "subscriber unreachable" });
    expect(row?.nextAttemptAt).not.toBeNull();
    expect(row!.nextAttemptAt!).toBeGreaterThan(h.now());
    expect(h.armedAlarms).toContain(row!.nextAttemptAt!);
    expect(h.subscribers.hasConnection("k")).toBe(false);

    // Backing off: further wakes do not re-poke until the alarm is due.
    h.subscribers.wake();
    await h.settle();
    expect(h.pokes).toHaveLength(1);
  });

  it("k. coalescing: five wakes during one in-flight poke dial exactly once", async () => {
    const h = makeHarness();
    h.configure(wakePayload(), 0);
    h.append(evt(1, "a"), evt(2, "a"));
    const { sink } = makeSink();
    let resolvePoke: (result: PokeResult) => void = () => {};
    h.dialImpl.poke = () =>
      new Promise<PokeResult>((resolve) => {
        resolvePoke = resolve;
      });

    for (let i = 0; i < 5; i += 1) h.subscribers.wake();
    expect(h.pokes).toHaveLength(1);

    resolvePoke({ checkpointOffset: 2, sink });
    await h.settle();

    expect(h.pokes).toHaveLength(1);
    expect(h.subscribers.hasConnection("k")).toBe(true);
    expect(h.row("k")?.ackedOffset).toBe(2);
  });

  it("l. config replacement: closes the old connection, clears backoff; deliver seeks, absent deliver keeps", async () => {
    // Wake mode: a replacement closes the live connection with a "replaced" fact.
    const wakeHarness = makeHarness();
    wakeHarness.configure(wakePayload(), 0);
    wakeHarness.append(evt(1, "a"));
    const sinks = [makeSink(), makeSink()];
    let nextSink = 0;
    wakeHarness.dialImpl.poke = async () => ({
      checkpointOffset: 0,
      sink: sinks[nextSink++].sink,
    });
    wakeHarness.subscribers.wake();
    await wakeHarness.settle();
    expect(wakeHarness.subscribers.hasConnection("k")).toBe(true);

    wakeHarness.configure(wakePayload(), 2); // the reducer folds the replacement first
    wakeHarness.subscribers.onSubscriptionConfigured(wakePayload(), 2);
    await wakeHarness.settle();

    const replacedFacts = wakeHarness.factsOfType(DISCONNECTED);
    expect(replacedFacts).toHaveLength(1);
    expect(replacedFacts[0].payload).toMatchObject({ subscriptionKey: "k", reason: "replaced" });
    // The embedded wake() re-established against the new config.
    expect(wakeHarness.pokes).toHaveLength(2);
    expect(wakeHarness.subscribers.hasConnection("k")).toBe(true);
    expect(sinks[1].batches[0].events.map((event) => event.offset)).toEqual([1]);

    // Push mode, cursor semantics: absent `deliver` keeps the cursor.
    const cursorHarness = makeHarness();
    cursorHarness.configure(pushPayload(), 0);
    cursorHarness.append(evt(1, "a"), evt(2, "a"), evt(3, "a"));
    cursorHarness.subscribers.wake();
    await cursorHarness.settle();
    expect(cursorHarness.row("k")?.ackedOffset).toBe(3);
    expect(cursorHarness.pushes).toHaveLength(1);

    const keepCursor = pushPayload();
    delete keepCursor.deliver;
    cursorHarness.configure(keepCursor, 10);
    cursorHarness.subscribers.onSubscriptionConfigured(keepCursor, 10);
    await cursorHarness.settle();
    // No seek, no replay: config update is not a replay request.
    expect(cursorHarness.row("k")?.ackedOffset).toBe(3);
    expect(cursorHarness.pushes).toHaveLength(1);

    // Explicit `deliver` on the replacement is a seek.
    const seek = pushPayload({ deliver: { afterOffset: 1 } });
    cursorHarness.configure(seek, 11);
    cursorHarness.subscribers.onSubscriptionConfigured(seek, 11);
    await cursorHarness.settle();
    expect(cursorHarness.pushes).toHaveLength(2);
    expect(cursorHarness.pushes[1].events.map((event) => event.offset)).toEqual([2, 3]);
    expect(cursorHarness.row("k")?.ackedOffset).toBe(3);

    // A replacement clears backoff, so the new config gets an immediate try.
    const backoffHarness = makeHarness();
    backoffHarness.configure(pushPayload(), 0);
    backoffHarness.append(evt(1, "a"), evt(2, "a"));
    backoffHarness.dialImpl.push = async () => {
      throw new Error("old target broken");
    };
    backoffHarness.subscribers.wake();
    await backoffHarness.settle();
    expect(backoffHarness.row("k")?.attempt).toBe(1);
    expect(backoffHarness.row("k")?.nextAttemptAt).not.toBeNull();

    backoffHarness.dialImpl.push = async () => {};
    const replacement = pushPayload();
    delete replacement.deliver;
    backoffHarness.configure(replacement, 12);
    backoffHarness.subscribers.onSubscriptionConfigured(replacement, 12);
    await backoffHarness.settle();

    // Delivered immediately — no clock advance, no alarm.
    expect(backoffHarness.pushes).toHaveLength(2);
    expect(backoffHarness.row("k")).toMatchObject({
      ackedOffset: 2,
      attempt: 0,
      nextAttemptAt: null,
    });
  });

  it("a late wake settlement from a replaced connection cannot close its successor", async () => {
    const h = makeHarness();
    h.configure(wakePayload(), 0);
    h.append(evt(1, "a"));
    const batches: StreamWakeEventBatch[] = [];
    h.dialImpl.poke = async () => ({
      checkpointOffset: 0,
      sink: Object.assign(
        (batch: StreamWakeEventBatch) => {
          batches.push(batch);
        },
        { [Symbol.dispose]: () => {} },
      ),
    });

    h.subscribers.wake();
    await h.settle();
    expect(batches).toHaveLength(1);

    h.configure(wakePayload(), 2);
    h.subscribers.onSubscriptionConfigured(wakePayload(), 2);
    await h.settle();
    expect(batches).toHaveLength(2);
    expect(h.subscribers.hasConnection("k")).toBe(true);

    batches[0]!.settleDelivery({
      outcome: "error",
      error: { name: "Error", message: "obsolete connection failed late" },
    });
    await h.settle();

    expect(h.subscribers.hasConnection("k")).toBe(true);
    expect(h.row("k")?.attempt).toBe(0);
    batches[1]!.settleDelivery({ outcome: "ok" });
  });

  it("m. removal deletes the cursor row and closes the connection", async () => {
    const h = makeHarness();
    h.configure(wakePayload(), 0);
    h.append(evt(1, "a"));
    const { sink } = makeSink();
    h.dialImpl.poke = async () => ({ checkpointOffset: 0, sink });
    h.subscribers.wake();
    await h.settle();
    expect(h.subscribers.hasConnection("k")).toBe(true);
    expect(h.row("k")).toBeDefined();

    delete h.configured["k"]; // the reducer folds subscription-removed first
    h.subscribers.onSubscriptionRemoved("k");
    await h.settle();

    expect(h.row("k")).toBeUndefined();
    expect(h.subscribers.hasConnection("k")).toBe(false);
    const disconnectedFacts = h.factsOfType(DISCONNECTED);
    expect(disconnectedFacts).toHaveLength(1);
    expect(disconnectedFacts[0].payload).toMatchObject({
      subscriptionKey: "k",
      reason: "subscription-removed",
    });

    // Nothing left to reconcile.
    h.subscribers.wake();
    await h.settle();
    expect(h.pokes).toHaveLength(1);
    expect(h.row("k")).toBeUndefined();
  });

  it("n. ephemeral: immediate durable replay, presence facts, and fire-and-forget sink results", async () => {
    const h = makeHarness();
    h.append(evt(1, "a"), evt(2, "b"), evt(3, "c"));

    const batches: StreamEventBatch[] = [];
    const connection = h.subscribers.openEphemeral({
      subscriptionKey: "watcher",
      sink: (batch) => {
        batches.push(batch);
      },
      replayAfterOffset: 0,
    });

    // The first batch is synchronous with open: full history, no separate getState.
    expect(batches).toHaveLength(1);
    expect(batches[0].events.map((event) => event.offset)).toEqual([1, 2, 3]);
    expect(batches[0].streamMaxOffset).toBe(3);
    const connectedFacts = h.factsOfType(CONNECTED);
    expect(connectedFacts).toHaveLength(1);
    expect(connectedFacts[0].payload).toMatchObject({
      subscriptionKey: "watcher",
      subscriptionType: "ephemeral",
    });

    // Ephemeral sink results are never awaited: a rejected result must not
    // surface anywhere or change any state. The rejection is pre-handled on
    // our side so the assertion below can prove the spine never re-raises it.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const rejected = Promise.reject(new Error("subscriber exploded"));
      rejected.catch(() => {});
      let delivered = 0;
      const rejecting = h.subscribers.openEphemeral({
        subscriptionKey: "rejecting-watcher",
        sink: () => {
          delivered += 1;
          return rejected;
        },
        replayAfterOffset: 0,
      });
      await h.settle();
      expect(delivered).toBe(1);
      expect(rejecting.isLive()).toBe(true); // no delivery-error lane for ephemeral sinks
      expect(h.factsOfType(ERROR_OCCURRED)).toHaveLength(0);
      expect(h.store.list()).toEqual([]); // the ephemeral lane never touches the spine's rows
      rejecting.close("unsubscribed");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);

    connection.close("unsubscribed");
    expect(connection.isLive()).toBe(false);
    const disconnectedFacts = h.factsOfType(DISCONNECTED);
    expect(
      disconnectedFacts.map((fact) => fact.payload as { subscriptionKey: string; reason: string }),
    ).toEqual([
      { subscriptionKey: "rejecting-watcher", reason: "unsubscribed" },
      { subscriptionKey: "watcher", reason: "unsubscribed" },
    ]);
  });

  it("o. webhook: one POST per event in order, per-event acking, lean envelope", async () => {
    const h = makeHarness();
    h.configure(webhookPayload(), 0);
    h.append(evt(1, "a"), evt(2, "b"), evt(3, "c"));

    h.subscribers.wake();
    await h.settle();

    expect(h.webhooks.map((call) => call.url)).toEqual([
      "https://example.com/hook",
      "https://example.com/hook",
      "https://example.com/hook",
    ]);
    expect(h.webhooks.map((call) => call.delivery.event.offset)).toEqual([1, 2, 3]);
    expect(h.row("k")?.ackedOffset).toBe(3);
    expect(h.pushes).toHaveLength(0); // webhook rides its own dial lane

    const first = h.webhooks[0]!.delivery;
    expect(first.deliveryId).toBe("k:1-1");
    expect(first.attempt).toBe(1);
    expect(first.projectId).toBe("p1");
    expect(first.path).toBe("/t");
    expect(first.configuredEvent.payload).toEqual(webhookPayload());
    // The envelope is lean by design: no `state`, no sibling events.
    expect("state" in first).toBe(false);
    expect("events" in first).toBe(false);
  });

  it("p. webhook mid-batch failure: delivered events stay acked, retry resumes at the failed event", async () => {
    const h = makeHarness();
    h.configure(webhookPayload(), 0);
    h.append(evt(1, "a"), evt(2, "b"), evt(3, "c"));

    let failOffset: number | null = 2;
    h.dialImpl.webhook = async (delivery) => {
      if (delivery.event.offset === failOffset) throw new Error("500 from receiver");
    };
    h.subscribers.wake();
    await h.settle();

    // Event 1 acked; event 2 failed → backoff row at cursor 1, no event 3 attempt.
    expect(h.webhooks.map((call) => call.delivery.event.offset)).toEqual([1, 2]);
    expect(h.row("k")?.ackedOffset).toBe(1);
    expect(h.row("k")?.attempt).toBe(1);
    expect(h.row("k")?.nextAttemptAt).not.toBeNull();

    // Receiver recovers; the alarm redrive resumes at EXACTLY the failed event.
    failOffset = null;
    h.advanceTo(h.store.minNextAttemptAt()! + 1);
    h.subscribers.onAlarm();
    await h.settle();

    expect(h.webhooks.map((call) => call.delivery.event.offset)).toEqual([1, 2, 2, 3]);
    expect(h.webhooks[2]!.delivery.attempt).toBe(2); // redelivery is visibly attempt 2
    expect(h.row("k")?.ackedOffset).toBe(3);
    expect(h.row("k")?.attempt).toBe(0);
  });

  it("q. webhook onPoison skip: a single event is its own poison isolate — confirmed, recorded, stepped over", async () => {
    const h = makeHarness();
    h.configure(webhookPayload({ onPoison: "skip" }), 0);
    h.append(evt(1, "poison"), evt(2, "fine"));

    h.dialImpl.webhook = async (delivery) => {
      if (delivery.event.offset === 1) throw new Error("unprocessable");
    };
    h.subscribers.wake();
    await h.settle();
    for (let round = 0; round < SKIP_CONFIRM_ATTEMPTS; round += 1) {
      const next = h.store.minNextAttemptAt();
      if (next === null) break;
      h.advanceTo(next + 1);
      h.subscribers.onAlarm();
      await h.settle();
    }

    // The poison event was confirmed (SKIP_CONFIRM_ATTEMPTS tries), recorded,
    // stepped over — and the event behind it still got delivered.
    const skips = h.factsOfType(ERROR_OCCURRED);
    expect(skips).toHaveLength(1);
    expect(skips[0]!.idempotencyKey).toBe("push-poison-skipped:k:1");
    expect(h.webhooks.filter((call) => call.delivery.event.offset === 1)).toHaveLength(
      SKIP_CONFIRM_ATTEMPTS,
    );
    expect(h.webhooks.at(-1)!.delivery.event.offset).toBe(2);
    expect(h.row("k")?.ackedOffset).toBe(2);
    expect(h.factsOfType(PARKED)).toHaveLength(0);
  });

  it("r. a parked subscription stops driving the alarm (no post-park re-arms)", async () => {
    const h = makeHarness();
    h.configure(pushPayload(), 0);
    h.append(evt(1, "a"));
    h.dialImpl.push = async () => {
      throw new Error("receiver hard down");
    };
    await driveUntilParked(h);

    // The park cleared the row's backoff: nothing pending, nothing to re-arm.
    expect(h.row("k")?.nextAttemptAt).toBeNull();
    expect(h.store.minNextAttemptAt()).toBeNull();

    // The bug this pins: the parking attempt's own (past) next_attempt_at
    // used to survive the park, and every onAlarm re-armed it — a permanent
    // past-timestamp alarm hot loop per parked subscription.
    const armsBefore = h.armedAlarms.length;
    for (let round = 0; round < 5; round += 1) {
      h.subscribers.onAlarm();
      await h.settle();
    }
    expect(h.armedAlarms.length).toBe(armsBefore);
  });

  it("s. wake delivery failures back off, park after sustained failure, and reset on checkpoint progress", async () => {
    const h = makeHarness();
    h.configure(wakePayload(), 1);
    h.append(evt(1, "a"));

    let checkpoint = 0;
    let latestBatch: StreamWakeEventBatch | undefined;
    h.dialImpl.poke = async () => ({
      checkpointOffset: checkpoint,
      sink: Object.assign(
        (batch: StreamWakeEventBatch) => {
          latestBatch = batch;
        },
        { [Symbol.dispose]: () => {} },
      ),
    });
    h.subscribers.wake();
    await h.settle();
    expect(h.pokes).toHaveLength(1);
    expect(latestBatch).toBeDefined();

    // A processor's independent error settlement must run the failure
    // machine: nack'd row, closed connection, and NO immediate re-poke — the
    // bug this pins is the close→wake→re-poke hot loop that never backed off
    // and never parked (each poke's ack used to reset the attempt counter).
    latestBatch!.settleDelivery({
      outcome: "error",
      error: { name: "Error", message: "ingest rejects deterministically" },
    });
    await h.settle();
    expect(h.subscribers.hasConnection("k")).toBe(false);
    expect(h.row("k")?.attempt).toBe(1);
    expect(h.row("k")?.nextAttemptAt).not.toBeNull();
    expect(h.pokes).toHaveLength(1); // no hot re-poke

    // Alarm-driven retry: the poke succeeds (host reachable, checkpoint
    // unchanged) but the streak SURVIVES the handshake.
    h.advanceTo(h.row("k")!.nextAttemptAt! + 1);
    h.subscribers.onAlarm();
    await h.settle();
    expect(h.pokes).toHaveLength(2);
    expect(h.row("k")?.attempt).toBe(1); // preserved, not reset by the poke

    // Sustained deterministic failure parks at the shared threshold.
    for (let round = 0; round < 400 && h.factsOfType(PARKED).length === 0; round += 1) {
      latestBatch!.settleDelivery({
        outcome: "error",
        error: { name: "Error", message: "still failing" },
      });
      await h.settle();
      const next = h.store.minNextAttemptAt();
      if (next === null) break;
      h.advanceTo(next + 1);
      h.subscribers.onAlarm();
      await h.settle();
    }
    expect(h.factsOfType(PARKED)).toHaveLength(1);
    expect(h.subscribers.hasConnection("k")).toBe(false);

    // Recovery: resume, and a poke whose checkpoint PROGRESSED clears the streak.
    h.configured["k"]!.parkedAtOffset = undefined;
    checkpoint = 1;
    h.subscribers.onResumed("k");
    await h.settle();
    expect(h.subscribers.hasConnection("k")).toBe(true);
    expect(h.row("k")?.attempt).toBe(0);
    latestBatch!.settleDelivery({ outcome: "ok" });
  });

  it("classifies a Durable Object lifecycle reset as availability, not a delivery error", async () => {
    const h = makeHarness();
    h.configure(wakePayload(), 1);
    h.append(evt(1, "a"));
    h.dialImpl.poke = async () => ({ checkpointOffset: 0, sink: makeSink().sink });
    h.subscribers.wake();
    await h.settle();

    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warningLog = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const reset = Object.assign(new Error("kill requested"), { durableObjectReset: true });
      h.subscribers.onDurableDeliveryError("k", reset);
      await h.settle();

      expect(errorLog).not.toHaveBeenCalled();
      expect(warningLog).toHaveBeenCalledWith(
        "stream durable sink unavailable; backing off before re-poke",
        expect.objectContaining({ subscriptionKey: "k", error: reset }),
      );
      expect(h.subscribers.hasConnection("k")).toBe(false);
      expect(h.row("k")?.attempt).toBe(1);
      expect(h.row("k")?.nextAttemptAt).not.toBeNull();
    } finally {
      errorLog.mockRestore();
      warningLog.mockRestore();
    }
  });

  it("backs off an RPC-broken wake sink before reconciling instead of hot re-poking", async () => {
    const h = makeHarness();
    h.configure(wakePayload(), 1);
    h.append(evt(1, "a"));

    let reportBroken: ((error: unknown) => void) | undefined;
    const dispose = vi.fn();
    const sink = Object.assign((_batch: StreamWakeEventBatch) => undefined, {
      [Symbol.dispose]: dispose,
      onRpcBroken: (handler: (error: unknown) => void) => {
        reportBroken = handler;
      },
    }) as RetainedProcessEventBatch<StreamWakeEventBatch>;
    h.dialImpl.poke = async () => ({ checkpointOffset: 0, sink });
    h.subscribers.wake();
    await h.settle();
    expect(h.pokes).toHaveLength(1);
    expect(reportBroken).toBeDefined();

    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warningLog = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const broken = new Error("remote capability disconnected");
      reportBroken!(broken);
      await h.settle();

      expect(errorLog).not.toHaveBeenCalled();
      expect(warningLog).toHaveBeenCalledWith(
        "stream durable sink unavailable; backing off before re-poke",
        expect.objectContaining({
          subscriptionKey: "k",
          reason: "rpc-broken",
          error: broken,
        }),
      );
      expect(dispose).toHaveBeenCalledOnce();
      expect(h.subscribers.hasConnection("k")).toBe(false);
      expect(h.row("k")?.attempt).toBe(1);
      expect(h.row("k")?.nextAttemptAt).not.toBeNull();
      expect(h.pokes).toHaveLength(1);
      expect(h.factsOfType(DISCONNECTED).at(-1)?.payload).toMatchObject({
        subscriptionKey: "k",
        reason: "rpc-broken",
      });
    } finally {
      errorLog.mockRestore();
      warningLog.mockRestore();
    }
  });

  it("t. an in-flight push delivery cannot clobber a cursor seek (epoch fence)", async () => {
    const h = makeHarness();
    h.configure(pushPayload(), 0);
    for (let n = 1; n <= 5; n += 1) h.append(evt(n, "a"));

    let releaseDelivery: (() => void) | undefined;
    h.dialImpl.push = () =>
      new Promise<void>((resolve) => {
        releaseDelivery = resolve;
      });
    h.subscribers.wake();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.pushes).toHaveLength(1); // batch [1..5] in flight

    // The audited redrive lands while the delivery is awaited...
    h.subscribers.onCursorSet("k", 2);
    // The receiver comes back for the redelivery; only the FIRST batch blocks.
    h.dialImpl.push = async () => {};
    releaseDelivery!();
    await h.settle();

    // ...and the delivery's ack must NOT swallow it: the drain re-read the
    // seeked cursor and redelivered from offset 3.
    const redelivered = h.pushes.at(-1)!;
    expect(redelivered.events[0]!.offset).toBe(3);
    expect(h.row("k")?.ackedOffset).toBe(5);
    expect(h.pushes.length).toBeGreaterThanOrEqual(2);
  });

  it("u. remove+recreate mid-delivery keeps the new subscription's promised history (epoch fence)", async () => {
    const h = makeHarness();
    h.configure(pushPayload(), 0);
    for (let n = 1; n <= 3; n += 1) h.append(evt(n, "a"));

    let releaseDelivery: (() => void) | undefined;
    h.dialImpl.push = () =>
      new Promise<void>((resolve) => {
        releaseDelivery = resolve;
      });
    h.subscribers.wake();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.pushes).toHaveLength(1); // old receiver's [1..3] in flight

    // Same key removed and immediately recreated with deliver:"all" — the
    // new receiver is PROMISED the full history.
    delete h.configured["k"];
    h.subscribers.onSubscriptionRemoved("k");
    h.configure(pushPayload(), 4);
    h.subscribers.onSubscriptionConfigured(pushPayload(), 4);
    h.dialImpl.push = async () => {};
    releaseDelivery!();
    await h.settle();

    // The old delivery's ack(3) landed on a DELETED row's epoch: no-op. The
    // recreated subscription drained from 0 — history redelivered.
    const firstNewDelivery = h.pushes.find(
      (batch, index) => index > 0 && batch.events[0]?.offset === 1,
    );
    expect(firstNewDelivery).toBeDefined();
    expect(h.row("k")?.ackedOffset).toBe(3);
  });

  it("v. selector-condition failures on error facts never append more error facts", async () => {
    const h = makeHarness();
    h.configure(
      pushPayload({
        // Condition-only selector that throws on any non-numeric payload.message.
        selector: { condition: "$number(payload.message) = 42" },
      }),
      0,
    );
    h.append(evt(1, "user/event", { message: "not-a-number" }));
    // The spine's own prior error fact sits in the log, exactly as it would
    // after one bad iteration.
    h.append(evt(2, ERROR_OCCURRED, { message: "prose, definitely not numeric" }));

    h.subscribers.wake();
    await h.settle();

    // One fact for the user event; NONE for the error fact — the self-feeding
    // loop (each drain iteration appending one new fact per fact read, which
    // the pause door cannot stop) is structurally closed.
    const conditionFacts = h.factsOfType(ERROR_OCCURRED);
    expect(conditionFacts).toHaveLength(1);
    expect(conditionFacts[0]!.idempotencyKey).toBe("selector-condition-failed:k:1");
    expect(h.row("k")?.ackedOffset).toBe(2);
  });

  it("w. live-tail fast path: a caught-up drain consumes the handed-over tail without a storage read", async () => {
    const h = makeHarness();
    h.configure(pushPayload(), 0);

    // Append hands the freshly committed events to wake() — the tailing drain
    // (cursor 0, tail starts at offset 1) must deliver them without ever
    // touching hooks.readEvents... except for the one catch-up read that
    // proves it drained to the tail (the loop's final "caught up" probe reads
    // an empty window THROUGH the tail check, which self-disqualifies there).
    const fresh = [evt(1, "a"), evt(2, "b")];
    h.append(...fresh);
    h.subscribers.wake(fresh.map((event) => ({ event, byteLength: 64 })));
    await h.settle();

    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0]!.events.map((event) => event.offset)).toEqual([1, 2]);
    expect(h.row("k")?.ackedOffset).toBe(2);
    // Exactly one storage read: the empty caught-up probe after the tail was
    // consumed. The delivered batch itself came from the handed-over events.
    expect(h.storageReads()).toBe(1);

    // A STALE tail self-disqualifies by offset: the next append reaches the
    // drain without a handover (offset 3 ≠ stale tail's first offset 1), so
    // the batch falls back to a storage read. Correctness never depends on
    // tail freshness.
    h.append(evt(3, "c"));
    const readsBefore = h.storageReads();
    h.subscribers.wake();
    await h.settle();
    expect(h.pushes).toHaveLength(2);
    expect(h.pushes[1]!.events.map((event) => event.offset)).toEqual([3]);
    expect(h.row("k")?.ackedOffset).toBe(3);
    expect(h.storageReads()).toBeGreaterThan(readsBefore);
  });

  it("x. a receiver-unavailable rejection backs off whole under onPoison skip — no bisect, no skips (the bootstrap window)", async () => {
    const h = makeHarness();
    h.configure(pushPayload({ onPoison: "skip" }), 0);
    h.append(evt(1, "a"), evt(2, "a"), evt(3, "a"));

    // The prd bootstrap incarnation: the project-worker feed dials before the
    // config repo has seeded, so EVERY delivery rejects with the receiver's
    // unavailability declaration — a statement about the receiver, never a
    // verdict about any one event. (Thrown name-only, the way it actually
    // arrives after crossing Workers RPC hops.)
    let ready = false;
    h.dialImpl.push = async () => {
      if (!ready) {
        throw Object.assign(new Error("project worker is not ready yet"), {
          name: "StreamReceiverUnavailableError",
        });
      }
    };

    h.subscribers.wake();
    await h.settle();

    // First failure: the batch stays WHOLE (no bisect), nothing is skipped,
    // the cursor holds — just a backoff row and an armed alarm.
    expect(h.pushes.map((batch) => batch.events.map((event) => event.offset))).toEqual([[1, 2, 3]]);
    expect(h.factsOfType(ERROR_OCCURRED)).toHaveLength(0);
    expect(h.row("k")).toMatchObject({ ackedOffset: 0, attempt: 1 });
    expect(h.armedAlarms.length).toBeGreaterThan(0);

    // Stay unavailable well past SKIP_CONFIRM_ATTEMPTS: before this routing,
    // three fast retries were enough to "confirm" a healthy event as poison
    // and step over it forever (offset 1 of every fresh project's root
    // stream lost to the config-repo seed race).
    for (let round = 0; round < SKIP_CONFIRM_ATTEMPTS + 1; round += 1) {
      const next = h.store.minNextAttemptAt();
      if (next === null) break;
      h.advanceTo(Math.max(h.now(), next) + 1);
      h.subscribers.onAlarm();
      await h.settle();
    }
    expect(h.factsOfType(ERROR_OCCURRED)).toHaveLength(0);
    expect(h.factsOfType(PARKED)).toHaveLength(0);
    expect(h.row("k")?.ackedOffset).toBe(0);
    expect(h.pushes.every((batch) => batch.events.length === 3)).toBe(true);

    // The receiver comes up (seed landed, worker built): the next retry
    // delivers the ORIGINAL batch intact and the failure state clears.
    ready = true;
    const next = h.store.minNextAttemptAt();
    expect(next).not.toBeNull();
    h.advanceTo(Math.max(h.now(), next!) + 1);
    h.subscribers.onAlarm();
    await h.settle();
    expect(h.pushes.at(-1)!.events.map((event) => event.offset)).toEqual([1, 2, 3]);
    expect(h.row("k")).toMatchObject({ ackedOffset: 3, attempt: 0, nextAttemptAt: null });
    expect(h.factsOfType(ERROR_OCCURRED)).toHaveLength(0);
  });

  it("a delivery timeout is receiver unavailability, never poison", async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      h.configure(pushPayload({ onPoison: "skip" }), 0);
      h.append(evt(1, "a"), evt(2, "a"), evt(3, "a"));
      h.dialImpl.push = () => new Promise<void>(() => {});

      h.subscribers.wake();
      const settling = h.settle();
      await vi.advanceTimersByTimeAsync(20_000);
      await vi.runAllTimersAsync();
      await settling;

      // A transport stall says nothing about any individual event. The same
      // whole batch remains owed, with a normal availability backoff; poison
      // bisection, skip facts, and cursor movement are all forbidden.
      expect(h.pushes.map((batch) => batch.events.map((event) => event.offset))).toEqual([
        [1, 2, 3],
      ]);
      expect(h.row("k")).toMatchObject({
        ackedOffset: 0,
        attempt: 1,
        lastError: "push k timed out after 20000ms",
      });
      expect(h.factsOfType(ERROR_OCCURRED)).toHaveLength(0);
      expect(h.factsOfType(PARKED)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("y. sustained receiver unavailability parks loudly instead of mass-skipping the backlog", async () => {
    const h = makeHarness();
    h.configure(pushPayload({ onPoison: "skip" }), 0);
    h.append(evt(1, "a"), evt(2, "a"), evt(3, "a"));
    h.dialImpl.push = async () => {
      throw new StreamReceiverUnavailableError("still not ready");
    };

    await driveUntilParked(h);

    // The whole outage produced ZERO poison verdicts: no event was stepped
    // over, the cursor never moved, and the park is the loud, resumable end
    // state MAX_DELIVERY_ATTEMPTS exists for.
    expect(h.factsOfType(ERROR_OCCURRED)).toHaveLength(0);
    const parkedFacts = h.factsOfType(PARKED);
    expect(parkedFacts).toHaveLength(1);
    expect(parkedFacts[0].payload).toMatchObject({ subscriptionKey: "k", atOffset: 0 });
    expect(h.row("k")?.ackedOffset).toBe(0);
    expect(
      h.pushes.every((batch) => batch.events.map((event) => event.offset).join(",") === "1,2,3"),
    ).toBe(true);
    expect(h.pushes).toHaveLength(MAX_DELIVERY_ATTEMPTS);
  });

  it("z. ephemeral events: never replayed, delivered only after an ephemeral subscription opens", async () => {
    const h = makeHarness();
    h.configure(pushPayload(), 0);
    h.append(evt(1, "a"), { ...evt(2, "chunk"), ephemeral: true as const }, evt(3, "b"));

    // Historical durable rows replay, but the pre-existing chunk at offset 2
    // is behind the connection's atomic live boundary and never appears.
    const batches: StreamEventBatch[] = [];
    h.subscribers.openEphemeral({
      subscriptionKey: "watcher",
      sink: (batch) => {
        batches.push(batch);
      },
      replayAfterOffset: 0,
    });
    await h.settle();
    const seen = batches.flatMap((batch) => batch.events);
    expect(seen.map((event) => [event.offset, event.ephemeral === true])).toEqual([
      [1, false],
      [3, false],
    ]);
    expect(batches[0]).toMatchObject({ scannedAfterOffset: 0, scannedThroughOffset: 3 });

    // The push drain delivered only the durable events and acked THROUGH the
    // ephemeral offset (skip-not-defer, same shape as selector skips).
    h.subscribers.wake();
    await h.settle();
    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0]!.events.map((event) => event.offset)).toEqual([1, 3]);
    expect(h.row("k")?.ackedOffset).toBe(3);

    // A trailing ephemeral-only append delivers nothing but advances the
    // cursor — no phantom lag, no redelivery on later wakes.
    h.append({ ...evt(4, "chunk"), ephemeral: true as const });
    h.subscribers.wake();
    await h.settle();
    expect(batches.flatMap((batch) => batch.events).map((event) => event.offset)).toEqual([
      1, 3, 4,
    ]);
    expect(batches.at(-1)).toMatchObject({
      scannedAfterOffset: 3,
      scannedThroughOffset: 4,
    });
    expect(h.pushes).toHaveLength(1);
    expect(h.row("k")?.ackedOffset).toBe(4);
    h.subscribers.wake();
    await h.settle();
    expect(h.pushes).toHaveLength(1);
  });

  it("z1. atomically rejects an unbounded replay before replacing a live connection", async () => {
    const h = makeHarness();
    h.append(evt(1, "a"), evt(2, "b"), evt(3, "c"));
    const first = makeSink();
    h.subscribers.openEphemeral({ subscriptionKey: "watcher", sink: first.sink });
    await h.settle();

    expect(() =>
      h.subscribers.openEphemeral({
        subscriptionKey: "watcher",
        sink: makeSink().sink,
        replayAfterOffset: 0,
        maxReplayOffsetGap: 2,
      }),
    ).toThrow(/replay gap 3 exceeds maxReplayOffsetGap 2/);
    expect(h.subscribers.hasConnection("watcher")).toBe(true);
  });

  it("z1a. atomically rejects a changed stream incarnation before replacing a live connection", async () => {
    const h = makeHarness();
    const first = makeSink();
    h.subscribers.openEphemeral({
      subscriptionKey: "watcher",
      sink: first.sink,
      expectedIncarnation: "stream-v1",
    });
    await h.settle();

    h.setIncarnation("stream-v2");
    expect(() =>
      h.subscribers.openEphemeral({
        subscriptionKey: "watcher",
        sink: makeSink().sink,
        replayAfterOffset: 0,
        expectedIncarnation: "stream-v1",
      }),
    ).toThrow(/stream incarnation changed \(stream-v1 -> stream-v2\)/);
    expect(h.subscribers.hasConnection("watcher")).toBe(true);

    h.subscribers.openEphemeral({
      subscriptionKey: "new-stream-watcher",
      sink: makeSink().sink,
      expectedIncarnation: "stream-v2",
    });
    expect(h.subscribers.hasConnection("new-stream-watcher")).toBe(true);
  });

  it("z1b. distinguishes an uncreated stream from a newly-created incarnation", () => {
    const h = makeHarness();
    h.setIncarnation(undefined);
    h.subscribers.openEphemeral({
      subscriptionKey: "uncreated-watcher",
      sink: makeSink().sink,
      expectedIncarnation: null,
    });

    h.setIncarnation("stream-v1");
    expect(() =>
      h.subscribers.openEphemeral({
        subscriptionKey: "replacement",
        sink: makeSink().sink,
        expectedIncarnation: null,
      }),
    ).toThrow(/stream incarnation changed \(null -> stream-v1\)/);
  });

  it("z1c. rejects invalid replay coordinates before opening a connection", () => {
    const h = makeHarness();

    expect(() =>
      h.subscribers.openEphemeral({
        subscriptionKey: "negative-cursor",
        sink: makeSink().sink,
        replayAfterOffset: -1,
      }),
    ).toThrow(/replayAfterOffset must be a non-negative safe integer/);
    expect(() =>
      h.subscribers.openEphemeral({
        subscriptionKey: "invalid-gap",
        sink: makeSink().sink,
        maxReplayOffsetGap: Number.NaN,
      }),
    ).toThrow(/maxReplayOffsetGap must be a non-negative safe integer/);
    expect(() =>
      h.subscribers.openEphemeral({
        subscriptionKey: "invalid-incarnation",
        sink: makeSink().sink,
        expectedIncarnation: "   ",
      }),
    ).toThrow(/expectedIncarnation must be null or a non-empty string/);
    expect(h.subscribers.hasConnection("negative-cursor")).toBe(false);
    expect(h.subscribers.hasConnection("invalid-gap")).toBe(false);
    expect(h.subscribers.hasConnection("invalid-incarnation")).toBe(false);
  });

  it("z2. configured wake connections never receive ephemeral events; the pump advances over them", async () => {
    const h = makeHarness();
    h.configure(wakePayload(), 0);
    h.append(evt(1, "a"), { ...evt(2, "chunk"), ephemeral: true as const }, evt(3, "b"));
    const { sink, batches } = makeSink();
    h.dialImpl.poke = async () => ({ checkpointOffset: 0, sink });

    h.subscribers.wake();
    await h.settle();
    expect(batches.flatMap((batch) => batch.events).map((event) => event.offset)).toEqual([1, 3]);

    // Ephemeral-only append while connected, delivered through the FRESH TAIL
    // fast path (what the DO's commit hands over — raw, flags included): the
    // pump advances its cursor and delivers nothing.
    const fresh: StreamEvent = { ...evt(4, "chunk"), ephemeral: true };
    h.append(fresh);
    h.subscribers.wake([{ event: fresh, byteLength: 64 }]);
    await h.settle();
    expect(batches.flatMap((batch) => batch.events).map((event) => event.offset)).toEqual([1, 3]);
    expect(batches.at(-1)).toMatchObject({
      events: [],
      scannedAfterOffset: 3,
      scannedThroughOffset: 4,
      streamMaxOffset: 4,
    });
  });

  it("z2a. a push subscription can receive ephemeral and durable rows in exact offset order", async () => {
    const h = makeHarness();
    h.configure({ ...pushPayload(), includeEphemeral: true }, 0);
    h.append(
      evt(1, "durable"),
      { ...evt(2, "chunk"), ephemeral: true as const },
      evt(3, "durable-again"),
    );

    h.subscribers.wake();
    await h.settle();

    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0]!.events.map(({ offset, ephemeral }) => ({ offset, ephemeral }))).toEqual([
      { offset: 1, ephemeral: undefined },
      { offset: 2, ephemeral: true },
      { offset: 3, ephemeral: undefined },
    ]);
    expect(h.row("k")?.ackedOffset).toBe(3);
  });

  it("z2b. a session selector receives an empty scan envelope across non-matches", async () => {
    const h = makeHarness();
    h.append(evt(1, "a"), evt(2, "b"));
    const { sink, batches } = makeSink();

    h.subscribers.openEphemeral({
      subscriptionKey: "filtered-session",
      sink,
      replayAfterOffset: 0,
      selector: compileEventSelector({ eventTypes: ["never"] }),
    });
    await h.settle();

    expect(batches).toEqual([
      expect.objectContaining({
        events: [],
        scannedAfterOffset: 0,
        scannedThroughOffset: 2,
        streamMaxOffset: 2,
      }),
    ]);
  });

  it("z3. advances session and push cursors through an evicted ephemeral suffix", async () => {
    const h = makeHarness();
    h.configure(pushPayload(), 0);
    h.append(evt(1, "a"), { ...evt(2, "chunk"), ephemeral: true as const });
    h.evict(2);

    const { sink, batches } = makeSink();
    h.subscribers.openEphemeral({
      subscriptionKey: "watcher",
      sink,
      replayAfterOffset: 0,
    });
    await h.settle();

    expect(batches).toHaveLength(2);
    expect(batches[0]).toMatchObject({
      events: [expect.objectContaining({ offset: 1 })],
      scannedAfterOffset: 0,
      scannedThroughOffset: 1,
      streamMaxOffset: 2,
    });
    expect(batches[1]).toMatchObject({
      events: [],
      scannedAfterOffset: 1,
      scannedThroughOffset: 2,
      streamMaxOffset: 2,
    });

    h.subscribers.wake();
    await h.settle();
    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0]!.events.map((event) => event.offset)).toEqual([1]);
    expect(h.row("k")?.ackedOffset).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Runtime metrics: real lag/bytes/latency accounting and the mutual ping.
// ---------------------------------------------------------------------------

describe("StreamSubscribers runtime metrics", () => {
  it("connections report real lag, delivered events, and delivered bytes", async () => {
    const h = makeHarness();
    h.append(evt(1, "a"), evt(2, "b"), evt(3, "c"));

    const { sink } = makeSink();
    h.subscribers.openEphemeral({ subscriptionKey: "watcher", sink, replayAfterOffset: 0 });
    await h.settle();

    const connection = h.subscribers.connectionRuntimeState()["watcher"]!;
    expect(connection.cursor).toBe(3);
    expect(connection.lag).toBe(0); // cursor caught the head
    expect(connection.eventsSent).toBe(3);
    expect(connection.bytesSent).toBeGreaterThan(0);
    // No pings answered, results disposed unpulled: both stats stay ABSENT
    // (the UI renders a dash) instead of carrying a synthesized zero.
    expect(connection.pingRttMs).toBeUndefined();
    expect(connection.settleLatencyMs).toBeUndefined();
    // Delivery throughput landed in the stream-level egress hook.
    expect(h.egress).toEqual([{ count: 3, bytes: connection.bytesSent }]);
    expect(h.runtimeChanges()).toBeGreaterThan(0);
  });

  it("push lane records delivery duration, commit→acked settle latency, and bytes", async () => {
    const h = makeHarness();
    h.configure(pushPayload(), 0);
    h.append(evt(1, "a"), evt(2, "b"), evt(3, "c")); // createdAt = epoch 1..3ms
    h.advanceTo(1_000);
    h.dialImpl.push = async () => {
      h.advanceTo(h.now() + 50); // the receiver took 50ms to ack
    };

    h.subscribers.wake();
    await h.settle();

    const subscription = h.subscribers.subscriptionRuntimeState()["k"]!;
    expect(subscription.deliveryDurationMs).toMatchObject({ last: 50, samples: 1 });
    // Stream clock only: dispatched at 1000 + 50ms ack − newest createdAt (3).
    expect(subscription.settleLatencyMs).toMatchObject({ last: 1_047, samples: 1 });
    expect(subscription.bytesSent).toBeGreaterThan(0);
    expect(h.egress).toEqual([{ count: 3, bytes: subscription.bytesSent }]);
  });

  it("wake-lane settle latency: the independent settlement records commit→consumed", async () => {
    const h = makeHarness();
    h.append(evt(1, "a"), evt(2, "b")); // createdAt = epoch 1..2ms
    h.advanceTo(500);
    h.configure(wakePayload(), 0);

    let settleBatch: (() => void) | undefined;
    h.dialImpl.poke = async () => ({
      checkpointOffset: 0,
      // Retained exactly like the real dial does: the sink result stays
      // unpulled and the processor reports completion out of band.
      sink: retainProcessEventBatch((batch: StreamWakeEventBatch) => {
        settleBatch = () => batch.settleDelivery({ outcome: "ok" });
      }),
    });

    h.subscribers.wake();
    await h.settle();
    expect(settleBatch).toBeDefined();
    expect(h.subscribers.connectionRuntimeState()["k"]!.settleLatencyMs).toBeUndefined();
    expect(h.pendingDeliveryStates().slice(-2)).toEqual([false, true]);
    const runtimeChangesBeforeSettle = h.runtimeChanges();

    h.advanceTo(600);
    settleBatch!();
    await h.settle();
    // Settled at 600 − newest event createdAt (2) — both on the stream clock.
    expect(h.subscribers.connectionRuntimeState()["k"]!.settleLatencyMs).toMatchObject({
      last: 598,
      samples: 1,
    });
    expect(h.pendingDeliveryStates().slice(-3)).toEqual([false, true, false]);
    expect(h.runtimeChanges()).toBeGreaterThan(runtimeChangesBeforeSettle);
  });

  it("mutual ping: NTP math cancels responder clock skew; rounds are throttled", async () => {
    const h = makeHarness();
    const SKEW = 100_000; // responder clock runs far ahead
    let pings = 0;
    const ping = (input: { t0: number }) => {
      pings += 1;
      const t1 = h.now() + SKEW + 0; // received "now" on the skewed clock
      h.advanceTo(h.now() + 40); // 40ms of round-trip elapses on OUR clock
      return { t0: input.t0, t1, t2: t1 + 5 }; // 5ms of responder processing
    };
    h.subscribers.openEphemeral({ subscriptionKey: "watcher", sink: makeSink().sink, ping });
    await h.settle();

    h.subscribers.samplePingsSoon();
    h.subscribers.samplePingsSoon(); // throttled: same round
    const runtimeChangesBeforePing = h.runtimeChanges();
    await h.settle();
    expect(pings).toBe(1);
    // rtt = (t3−t0) − (t2−t1) = 40 − 5, regardless of the 100s skew.
    expect(h.subscribers.connectionRuntimeState()["watcher"]!.pingRttMs).toMatchObject({
      last: 35,
      samples: 1,
    });
    expect(h.runtimeChanges()).toBeGreaterThan(runtimeChangesBeforePing);

    h.advanceTo(h.now() + 5_001);
    h.subscribers.samplePingsSoon();
    await h.settle();
    expect(pings).toBe(2);
  });

  it("a garbage or rejecting ping drops the sample and touches nothing else", async () => {
    const h = makeHarness();
    h.subscribers.openEphemeral({
      subscriptionKey: "garbage",
      sink: makeSink().sink,
      ping: () => ({}) as never,
    });
    const rejecting = h.subscribers.openEphemeral({
      subscriptionKey: "rejecting",
      sink: makeSink().sink,
      ping: () => Promise.reject(new Error("no pings today")),
    });
    await h.settle();

    h.subscribers.samplePingsSoon();
    await h.settle();

    const connections = h.subscribers.connectionRuntimeState();
    expect(connections["garbage"]!.pingRttMs).toBeUndefined();
    expect(connections["rejecting"]!.pingRttMs).toBeUndefined();
    expect(rejecting.isLive()).toBe(true); // pings are observational, never liveness
    expect(h.factsOfType(ERROR_OCCURRED)).toHaveLength(0);
  });

  it("the retained ping capability is disposed with its connection", async () => {
    const h = makeHarness();
    let disposed = false;
    const ping = Object.assign((input: { t0: number }) => ({ t0: input.t0, t1: 0, t2: 0 }), {
      [Symbol.dispose]: () => {
        disposed = true;
      },
    });
    const connection = h.subscribers.openEphemeral({
      subscriptionKey: "watcher",
      sink: makeSink().sink,
      ping,
    });
    await h.settle();
    expect(disposed).toBe(false);
    connection.close("unsubscribed");
    expect(disposed).toBe(true);
  });
});

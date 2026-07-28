import { DatabaseSync } from "node:sqlite";
import {
  StreamReceiverUnavailableError,
  type StreamEvent,
  type StreamEventBatch,
  type StreamEventInput,
  type StreamWakeEventBatch,
  type StreamWebhookDelivery,
} from "iterate/processors";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerBuildFailedError } from "../workers/artifact-store.ts";
import {
  CoreProcessorContract,
  type CoreProcessorState,
  type SubscriptionConfiguredPayload,
} from "./core-processor-contract.ts";
import { compileEventFilter } from "./event-filter.ts";
import type { RetainedProcessEventBatch } from "./retained-event-callbacks.ts";
import { DEFAULT_DELIVERY_TIMEOUT_MS, internalStreamId } from "./stream-delivery-utils.ts";
import {
  StreamConnections,
  StreamEventSender,
  type SubscriptionReceiverCalls,
} from "./stream-event-sender.ts";
import { SqliteSubscriptionCursorStore } from "./stream-storage.ts";

function wrapSqlStorage(db: DatabaseSync): SqlStorage {
  return {
    exec<T = unknown>(sql: string, ...bindings: (ArrayBuffer | null | number | string)[]) {
      const rows = db
        .prepare(sql)
        .all(
          ...bindings.map((binding) =>
            binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding,
          ),
        )
        .map((row) => Object.fromEntries(Object.entries(row).map(fromNodeSqlValue)));
      return { toArray: () => rows as T[] };
    },
  } as SqlStorage;
}

function fromNodeSqlValue([key, value]: [string, unknown]) {
  if (value instanceof Uint8Array) {
    return [key, value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)];
  }
  return [key, value];
}

function event(offset: number, type: string, payload: Record<string, unknown>): StreamEvent {
  return {
    type,
    payload,
    createdAt: new Date(offset).toISOString(),
    offset,
    path: "/source",
  };
}

function retainedProcessEventBatch(
  deliver: (batch: StreamWakeEventBatch) => void,
  dispose: () => void = vi.fn(),
): RetainedProcessEventBatch<StreamWakeEventBatch> {
  return Object.assign(deliver, {
    [Symbol.dispose]: dispose,
  });
}

const PROCESSOR_KEY = "hosted-test-processor";
const SOURCE_STREAM_ID = "11111111-1111-4111-8111-111111111111";
const RECREATED_STREAM_ID = "22222222-2222-4222-8222-222222222222";

afterEach(() => vi.restoreAllMocks());

function hostedConfig(
  filter?: SubscriptionConfiguredPayload["filter"],
): SubscriptionConfiguredPayload {
  return {
    subscriptionKey: PROCESSOR_KEY,
    description: "Focused hosted processor test",
    ...(filter === undefined ? {} : { filter }),
    receiver: {
      action: "processor-wake",
      expression: ["agents", ["get", "/source"], "processor", "wakeStreamProcessor"],
      processorSlug: "test-processor",
    },
  };
}

function harness(args: {
  events: StreamEvent[];
  filter?: SubscriptionConfiguredPayload["filter"];
  configuration?: SubscriptionConfiguredPayload;
  wakeProcessor: SubscriptionReceiverCalls["wakeStreamProcessor"];
  deliverToItx?: SubscriptionReceiverCalls["deliverToItx"];
  copyToStream?: SubscriptionReceiverCalls["copyToStream"];
  deliverToWebhook?: SubscriptionReceiverCalls["deliverToWebhook"];
  appendDeliveryEvent?: ConstructorParameters<
    typeof StreamEventSender
  >[0]["hooks"]["appendDeliveryEvent"];
  /** Share durable cursor rows with an earlier sender: the post-eviction rebuild. */
  store?: SqliteSubscriptionCursorStore;
}) {
  let now = 10_000;
  const configuration = args.configuration ?? hostedConfig(args.filter);
  const state = CoreProcessorContract.stateSchema.parse({
    projectId: "project",
    path: "/source",
    streamId: SOURCE_STREAM_ID,
    createdAt: "2026-07-21T10:00:00.000Z",
    maxOffset: Math.max(1, ...args.events.map((entry) => entry.offset)),
    subscriptions: {
      outbound: {
        byKey: {
          [PROCESSOR_KEY]: {
            configuration: { ...configuration, subscriptionKey: PROCESSOR_KEY },
            configuredAtOffset: 1,
            configuredAt: new Date(1).toISOString(),
          },
        },
      },
    },
  }) satisfies CoreProcessorState;
  const store =
    args.store ?? new SqliteSubscriptionCursorStore(wrapSqlStorage(new DatabaseSync(":memory:")));
  store.ensure(PROCESSOR_KEY, 0, 1);
  const alarms: number[] = [];
  const kept: Promise<unknown>[] = [];
  const wakeCalls: Parameters<SubscriptionReceiverCalls["wakeStreamProcessor"]>[] = [];
  const receiverCalls: SubscriptionReceiverCalls = {
    wakeStreamProcessor: (...wakeArgs) => {
      wakeCalls.push(wakeArgs);
      return args.wakeProcessor(...wakeArgs);
    },
    deliverToItx: args.deliverToItx ?? (async () => undefined),
    copyToStream: args.copyToStream ?? (async () => ({ acknowledged: 0 })),
    deliverToWebhook: args.deliverToWebhook ?? (async () => undefined),
  };
  const eventSender = new StreamEventSender({
    idleTeardownMs: 60_000,
    hooks: {
      readEvents: ({ afterOffset, beforeOffset, limit }) =>
        args.events
          .filter((entry) => entry.offset > afterOffset && entry.offset < beforeOffset)
          .slice(0, limit)
          .map((entry) => ({ event: entry, byteLength: JSON.stringify(entry).length })),
      coreState: () => state,
      store,
      receiverCalls,
      appendDeliveryEvent: args.appendDeliveryEvent ?? (() => true),
      recordEgress: () => undefined,
      runtimeChanged: () => undefined,
      now: () => now,
      random: () => 0.5,
      armAlarm: (atMs) => alarms.push(atMs),
      runDurable: (work) => kept.push(work()),
      keepAlive: (promise) => kept.push(promise),
    },
  });

  async function settle() {
    let seen = -1;
    while (seen !== kept.length) {
      seen = kept.length;
      await Promise.allSettled([...kept]);
      await Promise.resolve();
    }
    await Promise.resolve();
  }

  return {
    wakeCalls,
    alarms,
    state,
    store,
    eventSender,
    settle,
    setNow(value: number) {
      now = value;
    },
  };
}

describe("StreamEventSender hosted processor delivery", () => {
  it("backs off without publishing when recording the hosted open is interrupted", async () => {
    const disposed = vi.fn();
    const h = harness({
      events: [event(2, "a", { keep: true })],
      appendDeliveryEvent: (entry) =>
        entry.type === "events.iterate.com/stream/connection-opened" ? false : true,
      wakeProcessor: async () => ({
        streamId: SOURCE_STREAM_ID,
        checkpointOffset: 0,
        processEventBatch: retainedProcessEventBatch(() => undefined, disposed),
      }),
    });

    h.eventSender.sendDue();
    await h.settle();

    expect(disposed).toHaveBeenCalledOnce();
    expect(h.eventSender.connections.has(PROCESSOR_KEY)).toBe(false);
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      attempt: 1,
      nextAttemptAt: 11_000,
      inFlightDeadlineAt: null,
      inFlightConnectionGeneration: null,
    });
    expect(h.alarms).toContain(11_000);
  });

  it("repairs a cursor-set event after its first post-commit reconciliation fails", () => {
    const h = harness({
      events: [event(2, "b", { keep: true }), event(3, "b", { keep: true })],
      wakeProcessor: async () => {
        throw new Error("a copy must not wake a hosted processor");
      },
    });
    h.state.subscriptions.outbound.byKey[PROCESSOR_KEY] = {
      configuration: {
        subscriptionKey: PROCESSOR_KEY,
        receiver: {
          action: "copy-to-stream",
          receivingStreamPath: "/receiver",
          delivery: {
            start: "beginning",
            onFailingEvent: "halt",
          },
        },
      },
      configuredAtOffset: 1,
      configuredAt: new Date(1).toISOString(),
      cursorSet: { afterOffset: 2, setAtSourceOffset: 4 },
    };
    h.store.nack(PROCESSOR_KEY, {
      attempt: 3,
      nextAttemptAt: 99_000,
      error: "old receiver failure",
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(h.store, "setCursor").mockImplementationOnce(() => {
      throw new Error("simulated interruption after the cursor event committed");
    });

    expect(h.eventSender.sendDue()).toBe(false);
    expect(h.alarms).toContain(11_000);
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      acknowledgedOffset: 0,
      cursorChangedAtOffset: 1,
      attempt: 3,
    });

    expect(h.eventSender.sendDue()).toBe(true);

    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      acknowledgedOffset: 2,
      cursorChangedAtOffset: 4,
      attempt: 0,
      nextAttemptAt: null,
      lastError: null,
    });
    expect(h.wakeCalls).toHaveLength(0);
  });

  it("applies both the configured filter and the processor's announced event types", async () => {
    const delivered: StreamEventBatch[] = [];
    const h = harness({
      events: [
        event(2, "a", { keep: true }),
        event(3, "b", { keep: false }),
        event(4, "b", { keep: true }),
        event(5, "c", { keep: true }),
      ],
      filter: { eventTypes: ["a", "b"], jsonataCondition: "payload.keep = true" },
      wakeProcessor: async () => ({
        streamId: SOURCE_STREAM_ID,
        checkpointOffset: 1,
        openedBy: {
          processor: {
            announcement: {
              slug: "test-processor",
              version: "1.0.0",
              description: "Test processor",
              consumes: ["b", "c"],
              emits: [],
              ownedEvents: [],
            },
          },
        },
        processEventBatch: retainedProcessEventBatch((batch) => {
          delivered.push(batch);
          batch.reportDeliveryResult({ outcome: "ok" });
        }),
      }),
    });

    h.eventSender.sendDue();
    await h.settle();

    expect(h.wakeCalls).toHaveLength(1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.events.map(({ offset, type }) => ({ offset, type }))).toEqual([
      { offset: 4, type: "b" },
    ]);
    expect(delivered[0]).toMatchObject({ scannedAfterOffset: 1, scannedThroughOffset: 5 });
  });

  it("reopens from a lower processor checkpoint and retries from an alarm on a quiet stream", async () => {
    const attemptedOffsets: number[][] = [];
    let wakeNumber = 0;
    const h = harness({
      events: [event(2, "b", { keep: true }), event(3, "b", { keep: true })],
      filter: { eventTypes: ["b"] },
      wakeProcessor: async () => {
        wakeNumber += 1;
        return {
          streamId: SOURCE_STREAM_ID,
          checkpointOffset: wakeNumber === 1 ? 1 : 3,
          processEventBatch: retainedProcessEventBatch((batch) => {
            attemptedOffsets.push(batch.events.map((entry) => entry.offset));
            if (wakeNumber === 1) throw new Error("processor callback failed");
            batch.reportDeliveryResult({ outcome: "ok" });
          }),
        };
      },
    });
    h.store.ack(PROCESSOR_KEY, h.state.maxOffset);

    h.eventSender.sendDue();
    await h.settle();

    expect(h.wakeCalls).toHaveLength(1);
    expect(attemptedOffsets).toEqual([[2, 3]]);
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      acknowledgedOffset: 3,
      attempt: 1,
      nextAttemptAt: 11_000,
      lastError: "processor callback failed",
    });

    h.setNow(11_000);
    h.eventSender.onAlarm();
    await h.settle();

    expect(h.wakeCalls).toHaveLength(2);
    expect(h.eventSender.connections.has(PROCESSOR_KEY)).toBe(true);
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({ nextAttemptAt: null });
  });

  it("rejects a hosted processor checkpoint beyond the current source head", async () => {
    const processEventBatch = retainedProcessEventBatch(() => undefined);
    const h = harness({
      events: [event(2, "b", { keep: true })],
      wakeProcessor: async () => ({
        streamId: SOURCE_STREAM_ID,
        checkpointOffset: 3,
        processEventBatch,
      }),
    });

    h.eventSender.sendDue();
    await h.settle();

    expect(h.eventSender.connections.has(PROCESSOR_KEY)).toBe(false);
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      acknowledgedOffset: 0,
      attempt: 1,
      lastError: "hosted processor checkpoint 3 is beyond this stream's current maximum offset 2",
    });
    expect(processEventBatch[Symbol.dispose]).toHaveBeenCalledOnce();
  });

  it("rejects a hosted checkpoint and callback bound to a different stream lifetime", async () => {
    const processEventBatch = retainedProcessEventBatch(() => undefined);
    const h = harness({
      events: [event(2, "b", { keep: true })],
      wakeProcessor: async () => ({
        streamId: RECREATED_STREAM_ID,
        checkpointOffset: 0,
        processEventBatch,
      }),
    });

    h.eventSender.sendDue();
    await h.settle();

    expect(h.wakeCalls[0]?.[1].stream.streamId).toBe(SOURCE_STREAM_ID);
    expect(h.eventSender.connections.has(PROCESSOR_KEY)).toBe(false);
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      acknowledgedOffset: 0,
      attempt: 1,
      lastError: `hosted processor checkpoint belongs to stream ID ${RECREATED_STREAM_ID}, expected ${SOURCE_STREAM_ID}`,
    });
    expect(processEventBatch[Symbol.dispose]).toHaveBeenCalledOnce();
  });

  it("keeps an idle hosted callback closed until the source appends another event", async () => {
    const events = [event(2, "b", { keep: true })];
    const h = harness({
      events,
      wakeProcessor: async () => ({
        streamId: SOURCE_STREAM_ID,
        checkpointOffset: 2,
        processEventBatch: retainedProcessEventBatch((batch) => {
          batch.reportDeliveryResult({ outcome: "ok" });
        }),
      }),
    });

    h.eventSender.sendDue();
    await h.settle();
    expect(h.wakeCalls).toHaveLength(1);
    expect(h.eventSender.connections.has(PROCESSOR_KEY)).toBe(true);

    h.eventSender.runIdleTeardownNow();
    h.eventSender.sendDue();
    await h.settle();
    expect(h.eventSender.connections.has(PROCESSOR_KEY)).toBe(false);
    expect(h.wakeCalls).toHaveLength(1);

    events.push(event(3, "b", { keep: true }));
    h.state.maxOffset = 3;
    h.eventSender.sendDue();
    await h.settle();
    expect(h.wakeCalls).toHaveLength(2);
    expect(h.eventSender.connections.has(PROCESSOR_KEY)).toBe(true);
  });

  it("re-arms a persisted in-flight watchdog after eviction and expires it into the retry ladder", async () => {
    const events = [event(2, "b", { keep: true })];
    const evicted = harness({
      events,
      wakeProcessor: async () => ({
        streamId: SOURCE_STREAM_ID,
        checkpointOffset: 0,
        // Receives its batch but never reports a result; this sender is then
        // simply abandoned, the way an evicted isolate abandons its memory.
        processEventBatch: retainedProcessEventBatch(() => undefined),
      }),
    });
    evicted.eventSender.sendDue();
    await evicted.settle();
    expect(evicted.store.get(PROCESSOR_KEY)).toMatchObject({
      inFlightDeadlineAt: 10_000 + DEFAULT_DELIVERY_TIMEOUT_MS,
      inFlightConnectionGeneration: 1,
    });

    // A fresh sender over the SAME durable rows: the post-eviction rebuild.
    const rebuilt = harness({
      events,
      store: evicted.store,
      wakeProcessor: async () => ({
        streamId: SOURCE_STREAM_ID,
        checkpointOffset: 2,
        processEventBatch: retainedProcessEventBatch((batch) => {
          batch.reportDeliveryResult({ outcome: "ok" });
        }),
      }),
    });

    // Boot re-arm: the inherited deadline drives the alarm, and no second
    // wake starts while the persisted batch could still acknowledge.
    rebuilt.eventSender.sendDue();
    await rebuilt.settle();
    expect(rebuilt.wakeCalls).toHaveLength(0);
    expect(rebuilt.alarms).toContain(10_000 + DEFAULT_DELIVERY_TIMEOUT_MS);

    // Past the deadline the orphaned attempt fails into the bounded ladder
    // and the in-flight row clears.
    rebuilt.setNow(10_000 + DEFAULT_DELIVERY_TIMEOUT_MS);
    rebuilt.eventSender.onAlarm();
    await rebuilt.settle();
    expect(rebuilt.wakeCalls).toHaveLength(0);
    expect(rebuilt.store.get(PROCESSOR_KEY)).toMatchObject({
      attempt: 1,
      inFlightDeadlineAt: null,
      inFlightConnectionGeneration: null,
      nextAttemptAt: 10_000 + DEFAULT_DELIVERY_TIMEOUT_MS + 1_000,
      lastError: expect.stringContaining("timed out"),
    });

    // The scheduled retry wakes the processor again and recovery clears the ladder.
    rebuilt.setNow(10_000 + DEFAULT_DELIVERY_TIMEOUT_MS + 1_000);
    rebuilt.eventSender.onAlarm();
    await rebuilt.settle();
    expect(rebuilt.wakeCalls).toHaveLength(1);
    expect(rebuilt.store.get(PROCESSOR_KEY)).toMatchObject({
      acknowledgedOffset: 2,
      attempt: 0,
      nextAttemptAt: null,
      inFlightDeadlineAt: null,
    });
  });

  it("closes a hosted callback whose durable configuration was replaced", async () => {
    const disposed: ReturnType<typeof vi.fn>[] = [];
    const h = harness({
      events: [event(2, "b", { keep: true })],
      wakeProcessor: async () => {
        const dispose = vi.fn();
        disposed.push(dispose);
        return {
          streamId: SOURCE_STREAM_ID,
          checkpointOffset: 2,
          processEventBatch: retainedProcessEventBatch((batch) => {
            batch.reportDeliveryResult({ outcome: "ok" });
          }, dispose),
        };
      },
    });

    h.eventSender.sendDue();
    await h.settle();
    expect(h.eventSender.connections.has(PROCESSOR_KEY)).toBe(true);

    h.state.maxOffset = 4;
    h.state.subscriptions.outbound.byKey[PROCESSOR_KEY] = {
      configuration: { ...hostedConfig(), subscriptionKey: PROCESSOR_KEY },
      configuredAtOffset: 4,
      configuredAt: new Date(4).toISOString(),
    };
    h.eventSender.sendDue();
    await h.settle();

    expect(disposed[0]).toHaveBeenCalledOnce();
    expect(h.wakeCalls).toHaveLength(2);
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({ configuredAtOffset: 4 });
    expect(h.eventSender.connections.has(PROCESSOR_KEY)).toBe(true);
  });
});

describe("StreamEventSender stream delivery", () => {
  it("pins the next read to one event after a batch failure so a poison event cannot strand its healthy prefix", async () => {
    const attemptedOffsets: number[][] = [];
    const copyToStream = vi.fn<SubscriptionReceiverCalls["copyToStream"]>(async (_path, batch) => {
      attemptedOffsets.push(batch.events.map(({ offset }) => offset));
      if (batch.events.some(({ offset }) => offset === 3)) {
        throw new Error("receiver rejected offset 3");
      }
      return { acknowledged: batch.events.length };
    });
    const h = harness({
      events: [
        event(2, "example.com/issue-created", { issue: 1 }),
        event(3, "example.com/issue-created", { issue: 2 }),
        event(4, "example.com/issue-created", { issue: 3 }),
      ],
      configuration: {
        subscriptionKey: PROCESSOR_KEY,
        receiver: {
          action: "copy-to-stream",
          receivingStreamPath: "/agents/b",
          delivery: {
            start: "beginning",
            onFailingEvent: "halt",
          },
        },
      },
      copyToStream,
      wakeProcessor: async () => {
        throw new Error("a copy must not wake a hosted processor");
      },
    });

    h.eventSender.sendDue();
    await h.settle();
    expect(attemptedOffsets).toEqual([[2, 3, 4]]);
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      acknowledgedOffset: 0,
      attempt: 1,
      nextAttemptAt: 11_000,
    });

    // The retry reads one event at a time: the healthy prefix commits, then
    // the poison event fails alone and owns the retry ladder.
    h.setNow(11_000);
    h.eventSender.onAlarm();
    await h.settle();
    expect(attemptedOffsets).toEqual([[2, 3, 4], [2], [3, 4]]);
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      acknowledgedOffset: 2,
      attempt: 1,
      nextAttemptAt: 12_000,
    });

    h.setNow(13_000);
    h.eventSender.onAlarm();
    await h.settle();
    expect(attemptedOffsets).toEqual([[2, 3, 4], [2], [3, 4], [3]]);
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      acknowledgedOffset: 2,
      attempt: 2,
      failingEventOffset: null,
    });
  });

  it("backs off a retryable Durable Object overload instead of skipping healthy events", async () => {
    const overload = Object.assign(new Error("receiver overloaded"), { overloaded: true });
    const deliverToItx = vi.fn<SubscriptionReceiverCalls["deliverToItx"]>(async () => {
      throw overload;
    });
    const h = harness({
      events: [
        event(2, "example.com/issue-created", { issue: 1 }),
        event(3, "example.com/issue-created", { issue: 2 }),
      ],
      configuration: {
        subscriptionKey: PROCESSOR_KEY,
        receiver: {
          action: "itx-call",
          expression: ["worker", "processEventBatch"],
          delivery: {
            start: "beginning",
            onFailingEvent: "skip",
          },
        },
      },
      deliverToItx,
      wakeProcessor: async () => {
        throw new Error("an ITX receiver must not wake a hosted processor");
      },
    });

    h.eventSender.sendDue();
    await h.settle();

    expect(deliverToItx).toHaveBeenCalledOnce();
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      acknowledgedOffset: 0,
      attempt: 1,
      nextAttemptAt: 11_000,
      failingEventOffset: null,
      failingEventAttempt: 0,
    });
  });

  it("halts a terminal wake target failure immediately with the exact error", async () => {
    const appended: StreamEvent[] = [];
    const h = harness({
      events: [event(2, "example.com/issue-created", { issue: 1 })],
      wakeProcessor: async () => {
        throw new WorkerBuildFailedError({
          kind: "source",
          message: 'Entry point "github-ai-linter-worker.ts" was not found in files.',
        });
      },
      appendDeliveryEvent: (input) => {
        const parsed = CoreProcessorContract.parseEventInput(input);
        appended.push({
          ...parsed,
          path: "/source",
          offset: 3,
          createdAt: new Date(3).toISOString(),
        } as StreamEvent);
        return true;
      },
    });

    h.eventSender.sendDue();
    await h.settle();

    expect(h.wakeCalls).toHaveLength(1);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      type: "events.iterate.com/stream/subscription-delivery-halted",
      payload: {
        subscriptionKey: PROCESSOR_KEY,
        reason: "delivery-failed",
        attempts: 1,
        error: 'Entry point "github-ai-linter-worker.ts" was not found in files.',
      },
    });
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      attempt: 0,
      nextAttemptAt: null,
    });
  });

  it.each([
    ["oversized", `terminal ${"x".repeat(5_000)}`, 4_096],
    ["blank", "   ", undefined],
  ])(
    "sanitizes an %s terminal delivery error before appending the halt",
    async (_case, message, expectedLength) => {
      const appended: StreamEvent[] = [];
      const h = harness({
        events: [event(2, "example.com/issue-created", { issue: 42 })],
        configuration: {
          subscriptionKey: PROCESSOR_KEY,
          receiver: {
            action: "itx-call",
            expression: ["worker", "processEventBatch"],
            delivery: {
              start: "beginning",
              onFailingEvent: "halt",
            },
          },
        },
        deliverToItx: async () => {
          throw new Error(message);
        },
        appendDeliveryEvent: (input) => {
          const parsed = CoreProcessorContract.parseEventInput(input);
          appended.push({
            ...parsed,
            path: "/source",
            offset: 3,
            createdAt: new Date(3).toISOString(),
          } as StreamEvent);
          return true;
        },
        wakeProcessor: async () => {
          throw new Error("an ITX receiver must not wake a hosted processor");
        },
      });
      h.store.nack(PROCESSOR_KEY, {
        attempt: 14,
        nextAttemptAt: 10_000,
        error: "previous failure",
      });

      h.eventSender.sendDue();
      await h.settle();

      expect(appended).toHaveLength(1);
      expect(appended[0]).toMatchObject({
        type: "events.iterate.com/stream/subscription-delivery-halted",
        payload: {
          subscriptionKey: PROCESSOR_KEY,
          attempts: 15,
        },
      });
      const error = appended[0]?.payload?.error;
      if (expectedLength === undefined) expect(error).toBeUndefined();
      else expect(error).toHaveLength(expectedLength);
      expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
        attempt: 0,
        nextAttemptAt: null,
      });
    },
  );

  it("respects a stored backoff and rearms its retry time", async () => {
    const copyToStream = vi.fn<SubscriptionReceiverCalls["copyToStream"]>(async (_path, batch) => ({
      acknowledged: batch.events.length,
    }));
    const h = harness({
      events: [event(2, "example.com/issue-created", { issue: 42 })],
      configuration: {
        subscriptionKey: PROCESSOR_KEY,
        receiver: {
          action: "copy-to-stream",
          receivingStreamPath: "/agents/b",
          delivery: {
            start: "beginning",
            onFailingEvent: "halt",
          },
        },
      },
      copyToStream,
      wakeProcessor: async () => {
        throw new Error("a copy must not wake a hosted processor");
      },
    });
    h.store.nack(PROCESSOR_KEY, {
      attempt: 1,
      nextAttemptAt: 11_000,
      error: "receiver temporarily unavailable",
    });

    h.eventSender.sendDue();
    await h.settle();

    expect(copyToStream).not.toHaveBeenCalled();
    expect(h.alarms).toContain(11_000);
  });

  it("redelivers after the receiver accepts but committing the source cursor fails", async () => {
    const copyToStream = vi.fn<SubscriptionReceiverCalls["copyToStream"]>(async (_path, batch) => ({
      acknowledged: batch.events.length,
    }));
    const h = harness({
      events: [event(2, "example.com/issue-created", { issue: 42 })],
      configuration: {
        subscriptionKey: PROCESSOR_KEY,
        receiver: {
          action: "copy-to-stream",
          receivingStreamPath: "/agents/b",
          delivery: {
            start: "beginning",
            onFailingEvent: "halt",
          },
        },
      },
      copyToStream,
      wakeProcessor: async () => {
        throw new Error("a copy must not wake a hosted processor");
      },
    });
    const commitAcknowledgement = h.store.ack.bind(h.store);
    vi.spyOn(h.store, "ack")
      .mockImplementationOnce(() => {
        throw new Error("simulated source cursor commit failure");
      })
      .mockImplementation(commitAcknowledgement);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    h.eventSender.sendDue();
    await h.settle();

    expect(copyToStream).toHaveBeenCalledOnce();
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      acknowledgedOffset: 0,
      attempt: 1,
      nextAttemptAt: 11_000,
      lastError: "simulated source cursor commit failure",
    });
    expect(h.alarms).toContain(11_000);

    h.setNow(11_000);
    h.eventSender.onAlarm();
    await h.settle();

    expect(copyToStream).toHaveBeenCalledTimes(2);
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      acknowledgedOffset: 2,
      attempt: 0,
      nextAttemptAt: null,
      lastError: null,
    });
  });

  it("withholds the receiver's own drop audits from stream copies and acknowledges a drop verdict", async () => {
    const delivered: StreamEvent[][] = [];
    const copyToStream = vi.fn<SubscriptionReceiverCalls["copyToStream"]>(async (_path, batch) => {
      delivered.push(batch.events);
      // The receiver drops every delivered event (cycle/hop limit) but the
      // acknowledgement is terminal either way.
      return { acknowledged: batch.events.length };
    });
    const h = harness({
      events: [
        {
          ...event(2, "events.iterate.com/stream/error-occurred", {
            message: "dropped 1 copied event(s)",
          }),
          idempotencyKey: internalStreamId("copy-drop", "project", "/upstream", 1, 2),
        },
        event(3, "example.com/issue-created", { issue: 42 }),
      ],
      configuration: {
        subscriptionKey: PROCESSOR_KEY,
        receiver: {
          action: "copy-to-stream",
          receivingStreamPath: "/agents/b",
          delivery: {
            start: "beginning",
            onFailingEvent: "halt",
          },
        },
      },
      copyToStream,
      wakeProcessor: async () => {
        throw new Error("a copy must not wake a hosted processor");
      },
    });

    h.eventSender.sendDue();
    await h.settle();

    expect(delivered.map((batch) => batch.map(({ offset }) => offset))).toEqual([[3]]);
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      acknowledgedOffset: 3,
      attempt: 0,
      nextAttemptAt: null,
      lastError: null,
    });
  });

  it("halts after bounded retries when the receiving stream reports itself paused", async () => {
    const appendDeliveryEvent = vi.fn(() => true);
    const copyToStream = vi.fn<SubscriptionReceiverCalls["copyToStream"]>(async () => {
      throw new StreamReceiverUnavailableError("receiving stream is paused");
    });
    const h = harness({
      events: [event(2, "example.com/issue-created", { issue: 42 })],
      configuration: {
        subscriptionKey: PROCESSOR_KEY,
        receiver: {
          action: "copy-to-stream",
          receivingStreamPath: "/agents/b",
          delivery: {
            start: "beginning",
            onFailingEvent: "halt",
          },
        },
      },
      appendDeliveryEvent,
      copyToStream,
      wakeProcessor: async () => {
        throw new Error("a copy must not wake a hosted processor");
      },
    });
    h.store.nack(PROCESSOR_KEY, {
      attempt: 14,
      nextAttemptAt: 10_000,
      error: "receiving stream is paused",
    });

    h.eventSender.sendDue();
    await h.settle();

    expect(copyToStream).toHaveBeenCalledOnce();
    expect(appendDeliveryEvent).toHaveBeenCalledWith({
      type: "events.iterate.com/stream/subscription-delivery-halted",
      payload: {
        subscriptionKey: PROCESSOR_KEY,
        reason: "delivery-failed",
        afterOffset: 0,
        attempts: 15,
        error: "receiving stream is paused",
      },
    });
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      acknowledgedOffset: 0,
      attempt: 0,
      nextAttemptAt: null,
      failingEventOffset: null,
      failingEventAttempt: 0,
    });
  });

  it("discards a late acknowledgement after the same key was replaced", async () => {
    const receipt = Promise.withResolvers<{ acknowledged: number }>();
    // Only the first (pre-replacement) call resolves; the replacement run's
    // own delivery stays open so the stale acknowledgement is the only ack.
    const copyToStream = vi.fn<SubscriptionReceiverCalls["copyToStream"]>((_path, batch) =>
      batch.cursorChangedAtSourceOffset === 1 ? receipt.promise : new Promise(() => {}),
    );
    const configuration: SubscriptionConfiguredPayload = {
      subscriptionKey: PROCESSOR_KEY,
      receiver: {
        action: "copy-to-stream",
        receivingStreamPath: "/agents/b",
        delivery: {
          start: "beginning",
          onFailingEvent: "halt",
        },
      },
    };
    const h = harness({
      events: [event(2, "example.com/issue-created", { issue: 42 })],
      configuration,
      copyToStream,
      wakeProcessor: async () => {
        throw new Error("a copy must not wake a hosted processor");
      },
    });

    h.eventSender.sendDue();
    expect(copyToStream).toHaveBeenCalledOnce();

    h.state.maxOffset = 3;
    h.state.subscriptions.outbound.byKey[PROCESSOR_KEY] = {
      configuration: {
        ...configuration,
        subscriptionKey: PROCESSOR_KEY,
        receiver: {
          action: "copy-to-stream",
          receivingStreamPath: "/agents/c",
          delivery: {
            start: "beginning",
            onFailingEvent: "halt",
          },
        },
      },
      configuredAtOffset: 3,
      configuredAt: new Date(3).toISOString(),
    };
    h.eventSender.sendDue();
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      configuredAtOffset: 3,
      acknowledgedOffset: 0,
    });

    receipt.resolve({ acknowledged: 1 });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The stale acknowledgement was discarded; the replacement run re-sends
    // from its own cursor and its still-open delivery owns future progress.
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      configuredAtOffset: 3,
      acknowledgedOffset: 0,
    });
    expect(copyToStream).toHaveBeenCalledTimes(2);
    expect(copyToStream.mock.calls[1]![1].cursorChangedAtSourceOffset).toBe(3);
  });

  it("discards a superseded delivery's failure so it cannot touch the replacement's ladder", async () => {
    const appended: StreamEventInput[] = [];
    const rejection = Promise.withResolvers<{ acknowledged: number }>();
    // Only the first (pre-replacement) call settles — by rejecting after the
    // replacement landed; the replacement's own delivery stays open.
    const copyToStream = vi.fn<SubscriptionReceiverCalls["copyToStream"]>((_path, batch) =>
      batch.cursorChangedAtSourceOffset === 1 ? rejection.promise : new Promise(() => {}),
    );
    const configuration: SubscriptionConfiguredPayload = {
      subscriptionKey: PROCESSOR_KEY,
      receiver: {
        action: "copy-to-stream",
        receivingStreamPath: "/agents/b",
        delivery: {
          start: "beginning",
          onFailingEvent: "halt",
        },
      },
    };
    const h = harness({
      events: [
        event(2, "example.com/issue-created", { issue: 1 }),
        event(3, "example.com/issue-created", { issue: 2 }),
      ],
      configuration,
      copyToStream,
      appendDeliveryEvent: (input) => {
        appended.push(input);
        return true;
      },
      wakeProcessor: async () => {
        throw new Error("a copy must not wake a hosted processor");
      },
    });

    h.eventSender.sendDue();
    expect(copyToStream).toHaveBeenCalledOnce();

    h.state.maxOffset = 4;
    h.state.subscriptions.outbound.byKey[PROCESSOR_KEY] = {
      configuration: {
        ...configuration,
        subscriptionKey: PROCESSOR_KEY,
        receiver: {
          action: "copy-to-stream",
          receivingStreamPath: "/agents/c",
          delivery: {
            start: "beginning",
            onFailingEvent: "halt",
          },
        },
      },
      configuredAtOffset: 4,
      configuredAt: new Date(4).toISOString(),
    };
    h.eventSender.sendDue();
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      configuredAtOffset: 4,
      acknowledgedOffset: 0,
      attempt: 0,
    });

    rejection.reject(new Error("receiver of the superseded configuration failed"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The stale failure was discarded: no backoff, no halt, no failing-event
    // isolation on the replacement's fresh cursor row.
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      configuredAtOffset: 4,
      attempt: 0,
      nextAttemptAt: null,
      lastError: null,
      failingEventOffset: null,
      failingEventAttempt: 0,
    });
    expect(
      appended.filter(
        (input) => input.type === "events.iterate.com/stream/subscription-delivery-halted",
      ),
    ).toEqual([]);
    // The replacement re-sent in its own cursor epoch with a full first
    // attempt — no batch-size-1 poison pinning inherited from the old failure.
    expect(copyToStream).toHaveBeenCalledTimes(2);
    expect(copyToStream.mock.calls[1]![1]).toMatchObject({
      cursorChangedAtSourceOffset: 4,
      attempt: 1,
    });
    expect(copyToStream.mock.calls[1]![1].events.map(({ offset }) => offset)).toEqual([2, 3]);
  });

  it("halts when consecutive confirmed failing-event skips trip the mass-skip fuse", async () => {
    const appended: StreamEventInput[] = [];
    const deliverToItx = vi.fn<SubscriptionReceiverCalls["deliverToItx"]>(async () => {
      throw new Error("receiver rejects every event");
    });
    const h = harness({
      events: [
        event(2, "example.com/issue-created", { issue: 1 }),
        event(3, "example.com/issue-created", { issue: 2 }),
        event(4, "example.com/issue-created", { issue: 3 }),
      ],
      configuration: {
        subscriptionKey: PROCESSOR_KEY,
        receiver: {
          action: "itx-call",
          expression: ["worker", "processEventBatch"],
          delivery: {
            start: "beginning",
            onFailingEvent: "skip",
          },
        },
      },
      deliverToItx,
      appendDeliveryEvent: (input) => {
        appended.push(input);
        return true;
      },
      wakeProcessor: async () => {
        throw new Error("an ITX receiver must not wake a hosted processor");
      },
    });

    h.eventSender.sendDue();
    await h.settle();
    // Each isolated event needs three confirming failures before its skip;
    // the third confirmed failure in a row (offset 4) must trip the fuse
    // instead of skipping.
    let nowMs = 10_000;
    for (let alarmRound = 0; alarmRound < 6; alarmRound += 1) {
      nowMs += 2_000_000; // beyond the 30-minute backoff cap
      h.setNow(nowMs);
      h.eventSender.onAlarm();
      await h.settle();
    }

    const skipAudits = appended.filter(
      (input) => input.type === "events.iterate.com/stream/error-occurred",
    );
    expect(skipAudits.map((input) => input.payload)).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("skipped failing event at offset 2"),
      }),
      expect.objectContaining({
        message: expect.stringContaining("skipped failing event at offset 3"),
      }),
    ]);
    expect(
      appended.filter(
        (input) => input.type === "events.iterate.com/stream/subscription-delivery-halted",
      ),
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          subscriptionKey: PROCESSOR_KEY,
          reason: "delivery-failed",
          afterOffset: 3,
          attempts: 3,
        }),
      }),
    ]);
    // Durably halted: the failed row keeps its cursor but stops arming alarms.
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      acknowledgedOffset: 3,
      attempt: 0,
      nextAttemptAt: null,
    });
  });
});

describe("StreamEventSender webhook delivery", () => {
  function webhookConfig(
    receiverOverrides: Partial<
      Extract<SubscriptionConfiguredPayload["receiver"], { action: "webhook-post" }>
    > = {},
  ): SubscriptionConfiguredPayload {
    return {
      subscriptionKey: PROCESSOR_KEY,
      receiver: {
        action: "webhook-post",
        url: "https://receiver.example/events",
        delivery: { start: "beginning", onFailingEvent: "halt" },
        ...receiverOverrides,
      },
    };
  }

  it("POSTs one event at a time and each 2xx acknowledgement advances the cursor", async () => {
    const deliveries: StreamWebhookDelivery[] = [];
    const deliverToWebhook = vi.fn<SubscriptionReceiverCalls["deliverToWebhook"]>(
      async (_url, delivery) => {
        deliveries.push(delivery);
      },
    );
    const h = harness({
      events: [
        event(2, "example.com/issue-created", { issue: 1 }),
        event(3, "example.com/issue-created", { issue: 2 }),
        event(4, "example.com/issue-created", { issue: 3 }),
      ],
      configuration: webhookConfig(),
      deliverToWebhook,
      wakeProcessor: async () => {
        throw new Error("a webhook receiver must not wake a hosted processor");
      },
    });

    h.eventSender.sendDue();
    await h.settle();

    // The read limit is pinned to 1: three events become three single-event
    // POSTs, never one batch.
    expect(deliverToWebhook).toHaveBeenCalledTimes(3);
    expect(deliverToWebhook.mock.calls.map(([url]) => url)).toEqual([
      "https://receiver.example/events",
      "https://receiver.example/events",
      "https://receiver.example/events",
    ]);
    expect(deliveries.map((delivery) => delivery.event.offset)).toEqual([2, 3, 4]);
    expect(deliveries[0]).toMatchObject({
      projectId: "project",
      path: "/source",
      streamId: SOURCE_STREAM_ID,
      streamCreatedAt: "2026-07-21T10:00:00.000Z",
      subscriptionKey: PROCESSOR_KEY,
      cursorChangedAtSourceOffset: 1,
      attempt: 1,
      configuredEvent: { type: "events.iterate.com/stream/subscription-configured" },
    });
    // The lean per-event envelope: no batch array and no reduced core state.
    expect(deliveries[0]).not.toHaveProperty("events");
    expect(deliveries[0]).not.toHaveProperty("state");
    expect(new Set(deliveries.map((delivery) => delivery.deliveryId)).size).toBe(3);
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      acknowledgedOffset: 4,
      attempt: 0,
      nextAttemptAt: null,
      lastError: null,
    });
  });

  it("a rejected POST enters the bounded retry ladder and the retry resumes the backlog", async () => {
    let failOffsetThree = true;
    const delivered: number[] = [];
    const deliverToWebhook = vi.fn<SubscriptionReceiverCalls["deliverToWebhook"]>(
      async (_url, delivery) => {
        if (failOffsetThree && delivery.event.offset === 3) {
          throw new Error("webhook responded 503 Service Unavailable");
        }
        delivered.push(delivery.event.offset);
      },
    );
    const h = harness({
      events: [
        event(2, "example.com/issue-created", { issue: 1 }),
        event(3, "example.com/issue-created", { issue: 2 }),
      ],
      configuration: webhookConfig(),
      deliverToWebhook,
      wakeProcessor: async () => {
        throw new Error("a webhook receiver must not wake a hosted processor");
      },
    });

    h.eventSender.sendDue();
    await h.settle();

    // The healthy prefix committed per event; the failing event owns the ladder.
    expect(delivered).toEqual([2]);
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      acknowledgedOffset: 2,
      attempt: 1,
      nextAttemptAt: 11_000,
      lastError: "webhook responded 503 Service Unavailable",
    });
    expect(h.alarms).toContain(11_000);

    failOffsetThree = false;
    h.setNow(11_000);
    h.eventSender.onAlarm();
    await h.settle();

    expect(delivered).toEqual([2, 3]);
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      acknowledgedOffset: 3,
      attempt: 0,
      nextAttemptAt: null,
      lastError: null,
    });
  });

  it("halts loudly when the webhook stays down through the whole ladder", async () => {
    const appended: StreamEventInput[] = [];
    const deliverToWebhook = vi.fn<SubscriptionReceiverCalls["deliverToWebhook"]>(async () => {
      throw new Error("webhook responded 503 Service Unavailable");
    });
    const h = harness({
      events: [event(2, "example.com/issue-created", { issue: 42 })],
      configuration: webhookConfig(),
      deliverToWebhook,
      appendDeliveryEvent: (input) => {
        appended.push(input);
        return true;
      },
      wakeProcessor: async () => {
        throw new Error("a webhook receiver must not wake a hosted processor");
      },
    });
    h.store.nack(PROCESSOR_KEY, {
      attempt: 14,
      nextAttemptAt: 10_000,
      error: "previous failure",
    });

    h.eventSender.sendDue();
    await h.settle();

    expect(deliverToWebhook).toHaveBeenCalledOnce();
    expect(appended).toEqual([
      {
        type: "events.iterate.com/stream/subscription-delivery-halted",
        payload: {
          subscriptionKey: PROCESSOR_KEY,
          reason: "delivery-failed",
          afterOffset: 0,
          attempts: 15,
          error: "webhook responded 503 Service Unavailable",
        },
      },
    ]);
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      attempt: 0,
      nextAttemptAt: null,
    });
  });

  it("skip policy confirms a repeatedly failing event, audits the skip, and continues", async () => {
    const appended: StreamEventInput[] = [];
    const delivered: number[] = [];
    const poisonAttempts: number[] = [];
    const deliverToWebhook = vi.fn<SubscriptionReceiverCalls["deliverToWebhook"]>(
      async (_url, delivery) => {
        if (delivery.event.payload?.poison === true) {
          poisonAttempts.push(delivery.attempt);
          throw new Error("webhook responded 422 Unprocessable Entity");
        }
        delivered.push(delivery.event.offset);
      },
    );
    const h = harness({
      events: [
        event(2, "example.com/issue-created", { issue: 1 }),
        event(3, "example.com/issue-created", { poison: true }),
        event(4, "example.com/issue-created", { issue: 3 }),
      ],
      configuration: webhookConfig({
        delivery: { start: "beginning", onFailingEvent: "skip" },
      }),
      deliverToWebhook,
      appendDeliveryEvent: (input) => {
        appended.push(input);
        return true;
      },
      wakeProcessor: async () => {
        throw new Error("a webhook receiver must not wake a hosted processor");
      },
    });

    h.eventSender.sendDue();
    await h.settle();
    let nowMs = 10_000;
    for (let alarmRound = 0; alarmRound < 3; alarmRound += 1) {
      nowMs += 2_000_000; // beyond the 30-minute backoff cap
      h.setNow(nowMs);
      h.eventSender.onAlarm();
      await h.settle();
    }

    // FAILING_EVENT_CONFIRM_ATTEMPTS single-event confirmations, then the skip.
    expect(poisonAttempts).toHaveLength(3);
    expect(delivered).toEqual([2, 4]);
    expect(
      appended.filter((input) => input.type === "events.iterate.com/stream/error-occurred"),
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          message: expect.stringContaining("skipped failing event at offset 3"),
        }),
      }),
    ]);
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      acknowledgedOffset: 4,
      attempt: 0,
      nextAttemptAt: null,
    });
  });

  it("a replaced webhook cannot acknowledge its stale POST or keep the old URL in the loop", async () => {
    const staleAck = Promise.withResolvers<void>();
    // Only the pre-replacement POST settles; the replacement's own delivery
    // stays open so the stale acknowledgement is the only ack.
    const deliverToWebhook = vi.fn<SubscriptionReceiverCalls["deliverToWebhook"]>((url) =>
      url === "https://receiver.example/events" ? staleAck.promise : new Promise(() => {}),
    );
    const h = harness({
      events: [event(2, "example.com/issue-created", { issue: 42 })],
      configuration: webhookConfig(),
      deliverToWebhook,
      wakeProcessor: async () => {
        throw new Error("a webhook receiver must not wake a hosted processor");
      },
    });

    h.eventSender.sendDue();
    expect(deliverToWebhook).toHaveBeenCalledOnce();

    h.state.maxOffset = 3;
    h.state.subscriptions.outbound.byKey[PROCESSOR_KEY] = {
      configuration: {
        ...webhookConfig({ url: "https://replacement.example/events" }),
        subscriptionKey: PROCESSOR_KEY,
      },
      configuredAtOffset: 3,
      configuredAt: new Date(3).toISOString(),
    };
    h.eventSender.sendDue();
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      configuredAtOffset: 3,
      acknowledgedOffset: 0,
    });

    staleAck.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The stale 2xx was discarded; the same loop re-read the replacement and
    // POSTs to the new URL in the new cursor epoch — the old URL never sees
    // another event.
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      configuredAtOffset: 3,
      acknowledgedOffset: 0,
    });
    expect(deliverToWebhook).toHaveBeenCalledTimes(2);
    expect(deliverToWebhook.mock.calls.map(([url]) => url)).toEqual([
      "https://receiver.example/events",
      "https://replacement.example/events",
    ]);
    expect(deliverToWebhook.mock.calls[1]![1]).toMatchObject({
      cursorChangedAtSourceOffset: 3,
      attempt: 1,
      event: { offset: 2 },
    });
  });

  it("stops POSTing the moment its subscription is removed", async () => {
    const firstPostStarted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const deliverToWebhook = vi.fn<SubscriptionReceiverCalls["deliverToWebhook"]>(() => {
      firstPostStarted.resolve();
      return release.promise;
    });
    const h = harness({
      events: [
        event(2, "example.com/issue-created", { issue: 1 }),
        event(3, "example.com/issue-created", { issue: 2 }),
      ],
      configuration: webhookConfig(),
      deliverToWebhook,
      wakeProcessor: async () => {
        throw new Error("a webhook receiver must not wake a hosted processor");
      },
    });

    h.eventSender.sendDue();
    await firstPostStarted.promise;
    delete h.state.subscriptions.outbound.byKey[PROCESSOR_KEY];
    release.resolve();
    await h.settle();

    // The per-event staleness re-read sees the removal before offset 3 could
    // POST, and the orphaned acknowledgement moves no cursor.
    expect(deliverToWebhook).toHaveBeenCalledOnce();
  });

  it("a webhook transform shapes the POSTed event body and keeps the source coordinates", async () => {
    const deliveries: StreamWebhookDelivery[] = [];
    const deliverToWebhook = vi.fn<SubscriptionReceiverCalls["deliverToWebhook"]>(
      async (_url, delivery) => {
        deliveries.push(delivery);
      },
    );
    const h = harness({
      events: [event(2, "example.com/issue-created", { issue: 21, internal: "drop-me" })],
      configuration: webhookConfig({
        jsonataTransform:
          '{ "type": "example.com/issue-summary", "payload": { "issue": payload.issue, "doubled": payload.issue * 2 } }',
      }),
      deliverToWebhook,
      wakeProcessor: async () => {
        throw new Error("a webhook receiver must not wake a hosted processor");
      },
    });

    h.eventSender.sendDue();
    await h.settle();

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.event).toMatchObject({
      type: "example.com/issue-summary",
      payload: { issue: 21, doubled: 42 },
      // The coordinates keep naming the source row: the remote processor
      // deduplicates by (streamId, offset) even under a reshaped body.
      offset: 2,
      path: "/source",
    });
    expect(deliveries[0]!.event.payload).not.toHaveProperty("internal");
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      acknowledgedOffset: 2,
      attempt: 0,
    });
  });

  it("a transform evaluation failure is a delivery failure that skip policy isolates and steps over", async () => {
    const appended: StreamEventInput[] = [];
    const delivered: number[] = [];
    const deliverToWebhook = vi.fn<SubscriptionReceiverCalls["deliverToWebhook"]>(
      async (_url, delivery) => {
        delivered.push(delivery.event.offset);
      },
    );
    const h = harness({
      events: [
        event(2, "example.com/issue-created", { issue: 1 }),
        event(3, "example.com/issue-created", { poison: true }),
        event(4, "example.com/issue-created", { issue: 3 }),
      ],
      configuration: webhookConfig({
        jsonataTransform: 'payload.poison ? $error("poison event") : { "payload": payload }',
        delivery: { start: "beginning", onFailingEvent: "skip" },
      }),
      deliverToWebhook,
      appendDeliveryEvent: (input) => {
        appended.push(input);
        return true;
      },
      wakeProcessor: async () => {
        throw new Error("a webhook receiver must not wake a hosted processor");
      },
    });

    h.eventSender.sendDue();
    await h.settle();
    let nowMs = 10_000;
    for (let alarmRound = 0; alarmRound < 3; alarmRound += 1) {
      nowMs += 2_000_000; // beyond the 30-minute backoff cap
      h.setNow(nowMs);
      h.eventSender.onAlarm();
      await h.settle();
    }

    // The poison event never reached the wire — its transform failed before
    // the POST — and the ladder still confirmed and stepped over it.
    expect(delivered).toEqual([2, 4]);
    const skipAudits = appended.filter(
      (input) => input.type === "events.iterate.com/stream/error-occurred",
    );
    expect(skipAudits).toHaveLength(1);
    expect(skipAudits[0]!.payload).toMatchObject({
      message: expect.stringContaining("skipped failing event at offset 3"),
    });
    expect(String(skipAudits[0]!.payload!.message)).toContain(
      `webhook transform for subscription "${PROCESSOR_KEY}" failed on /source@3`,
    );
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      acknowledgedOffset: 4,
      attempt: 0,
      nextAttemptAt: null,
    });
  });
});

function streamEvent(offset: number, type = "events.example.com/item-created"): StreamEvent {
  return {
    type,
    payload: { offset },
    createdAt: new Date(offset).toISOString(),
    offset,
    path: "/source",
  };
}

type DeliveryCall = {
  batch: StreamEventBatch;
  report(outcome: "ok" | "error"): void;
};

function recordingProcessEventBatch(
  calls: DeliveryCall[],
  disposed: () => void,
): RetainedProcessEventBatch {
  return Object.assign(
    (batch: StreamEventBatch) => {
      calls.push({
        batch,
        report: (outcome) => {
          if (!("reportDeliveryResult" in batch)) {
            throw new Error("test tried to report a result for a session delivery");
          }
          (batch as StreamWakeEventBatch).reportDeliveryResult(
            outcome === "ok"
              ? { outcome: "ok" }
              : {
                  outcome: "error",
                  error: { name: "Error", message: "test delivery failed" },
                },
          );
        },
      });
    },
    {
      [Symbol.dispose]: () => disposed(),
    },
  );
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function connectionsHarness(
  options: {
    events?: StreamEvent[];
    onAppend?: (args: {
      connections: StreamConnections;
      state: CoreProcessorState;
      event: Parameters<
        ConstructorParameters<typeof StreamConnections>[0]["hooks"]["appendDeliveryEvent"]
      >[0];
    }) => boolean | void;
  } = {},
) {
  let now = 1_000;
  const events = options.events ?? [streamEvent(1), streamEvent(2), streamEvent(3)];
  const store = new SqliteSubscriptionCursorStore(wrapSqlStorage(new DatabaseSync(":memory:")));
  store.ensure("processor", 0, 12);
  const row = store.get("processor")!;
  const expectedDelivery = {
    configuredAtOffset: 12,
    cursorChangedAtOffset: row.cursorChangedAtOffset,
    connectionGeneration: 7,
  };
  const state = CoreProcessorContract.stateSchema.parse({
    projectId: "project",
    path: "/source",
    streamId: "11111111-1111-4111-8111-111111111111",
    createdAt: "2026-07-22T12:00:00.000Z",
    maxOffset: events.length,
  }) satisfies CoreProcessorState;
  const alarmTimes: number[] = [];
  const durableDeliveryWakes = vi.fn();
  const deliveryFailures = vi.fn((connectionKey: string, error: unknown) => {
    const current = store.get(connectionKey)!;
    store.nack(connectionKey, {
      attempt: current.attempt + 1,
      nextAttemptAt: now + 100,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  let connections!: StreamConnections;
  connections = new StreamConnections({
    idleTeardownMs: 60_000,
    hooks: {
      // Force several batches so the test can observe the one-at-a-time gate.
      readBatch: (afterOffset) =>
        events
          .filter((event) => event.offset > afterOffset)
          .slice(0, 1)
          .map((event) => ({ event, byteLength: JSON.stringify(event).length })),
      coreState: () => state,
      store,
      appendDeliveryEvent: (event) => {
        return options.onAppend?.({ connections, state, event }) ?? true;
      },
      recordEgress: () => undefined,
      runtimeChanged: () => undefined,
      now: () => now,
      armAlarm: (atMs) => alarmTimes.push(atMs),
      keepAlive: () => undefined,
      hostedDeliveryStillMatches: (_subscriptionKey, candidate) =>
        candidate.configuredAtOffset === expectedDelivery.configuredAtOffset &&
        candidate.cursorChangedAtOffset === expectedDelivery.cursorChangedAtOffset &&
        candidate.connectionGeneration === expectedDelivery.connectionGeneration,
      onHostedDeliveryFailure: deliveryFailures,
      sendDueSubscriptions: durableDeliveryWakes,
    },
  });
  return {
    connections,
    state,
    store,
    expectedDelivery,
    alarmTimes,
    deliveryFailures,
    durableDeliveryWakes,
    setNow(value: number) {
      now = value;
    },
  };
}

describe("StreamConnections hosted delivery watchdog", () => {
  it("does not publish a hosted callback until its opened event finishes appending", () => {
    const calls: DeliveryCall[] = [];
    const h = connectionsHarness({
      onAppend: ({ connections, event }) => {
        if (event.type === "events.iterate.com/stream/connection-opened") {
          // Mirrors StreamDurableObject.#append's synchronous post-commit
          // send check while openHosted is still recording this event.
          connections.sendQueued();
        }
      },
    });
    const connection = h.connections.openHosted({
      connectionKey: "processor",
      expectedHostedDelivery: h.expectedDelivery,
      processEventBatch: recordingProcessEventBatch(calls, () => undefined),
      replayAfterOffset: 0,
    });

    expect(calls).toHaveLength(0);
    expect(h.connections.runtimeState().processor).toMatchObject({
      kind: "hosted",
      subscriptionKey: "processor",
    });

    // The wake path records the reported checkpoint after openHosted returns,
    // then explicitly starts delivery. Its ack can no longer clear a marker
    // that the first batch has already written.
    h.store.ack("processor", 0);
    connection.sendQueued();
    expect(calls).toHaveLength(1);
    expect(h.store.get("processor")).toMatchObject({
      inFlightDeadlineAt: 1_000 + DEFAULT_DELIVERY_TIMEOUT_MS,
      inFlightConnectionGeneration: 7,
    });
  });

  it("disposes and rejects a hosted callback when its opened fact is interrupted", () => {
    const calls: DeliveryCall[] = [];
    const disposed = vi.fn();
    const h = connectionsHarness({
      onAppend: ({ event }) =>
        event.type === "events.iterate.com/stream/connection-opened" ? false : undefined,
    });

    expect(() =>
      h.connections.openHosted({
        connectionKey: "processor",
        expectedHostedDelivery: h.expectedDelivery,
        processEventBatch: recordingProcessEventBatch(calls, disposed),
        replayAfterOffset: 0,
      }),
    ).toThrow(/opened-event append was interrupted/);

    expect(disposed).toHaveBeenCalledOnce();
    expect(h.connections.has("processor")).toBe(false);
    expect(calls).toHaveLength(0);
    expect(h.store.get("processor")).toMatchObject({
      inFlightDeadlineAt: null,
      inFlightConnectionGeneration: null,
    });
  });

  it("disposes and rejects a session callback when its opened fact is interrupted", () => {
    const calls: DeliveryCall[] = [];
    const disposed = vi.fn();
    const h = connectionsHarness({
      onAppend: ({ event }) =>
        event.type === "events.iterate.com/stream/connection-opened" ? false : undefined,
    });

    expect(() =>
      h.connections.openSession({
        connectionKey: "session",
        processEventBatch: recordingProcessEventBatch(calls, disposed),
      }),
    ).toThrow(/opened-event append was interrupted/);

    expect(disposed).toHaveBeenCalledOnce();
    expect(h.connections.has("session")).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("treats a lifecycle-interrupted closed fact as a best-effort observation", () => {
    const calls: DeliveryCall[] = [];
    const disposed = vi.fn();
    const h = connectionsHarness({
      onAppend: ({ event }) =>
        event.type === "events.iterate.com/stream/connection-closed" ? false : undefined,
    });
    const connection = h.connections.openHosted({
      connectionKey: "processor",
      expectedHostedDelivery: h.expectedDelivery,
      processEventBatch: recordingProcessEventBatch(calls, disposed),
      replayAfterOffset: 0,
    });

    expect(() => connection.close("closed-by-owner")).not.toThrow();
    expect(disposed).toHaveBeenCalledOnce();
    expect(h.connections.has("processor")).toBe(false);
  });

  it("records rpc-broken when a session callback transport reports that it broke", () => {
    const appended: unknown[] = [];
    const h = connectionsHarness({
      onAppend: ({ event }) => {
        appended.push(event);
      },
    });
    let reportBroken: ((error: unknown) => void) | undefined;
    const processEventBatch = recordingProcessEventBatch([], () => undefined);
    processEventBatch.onRpcBroken = (handler) => {
      reportBroken = handler;
    };
    h.connections.openSession({
      connectionKey: "session",
      processEventBatch,
    });

    reportBroken!(new Error("transport closed"));

    expect(h.connections.has("session")).toBe(false);
    expect(appended).toContainEqual({
      type: "events.iterate.com/stream/connection-closed",
      payload: { connectionKey: "session", reason: "rpc-broken", error: "transport closed" },
    });
    expect(h.durableDeliveryWakes).toHaveBeenCalledOnce();
  });

  it("closes and records a session connection whose event condition throws", async () => {
    const appended: unknown[] = [];
    const h = connectionsHarness({
      onAppend: ({ event }) => {
        appended.push(event);
      },
    });
    const infoLog = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const calls: DeliveryCall[] = [];
    const disposed = vi.fn();
    const connection = h.connections.openSession({
      connectionKey: "session",
      processEventBatch: recordingProcessEventBatch(calls, disposed),
      replayAfterOffset: 0,
      filter: compileEventFilter({ jsonataCondition: '$error("session filter exploded")' }),
    });

    await flushMicrotasks();

    expect(calls).toHaveLength(0);
    expect(connection.isLive()).toBe(false);
    expect(disposed).toHaveBeenCalledOnce();
    expect(appended).toContainEqual({
      type: "events.iterate.com/stream/connection-closed",
      payload: {
        connectionKey: "session",
        reason: "delivery-failed",
        error: "session filter exploded",
      },
    });
    expect(infoLog).toHaveBeenCalledWith(
      "stream session filter condition failed; closing connection",
      expect.objectContaining({ connectionKey: "session", error: expect.any(Error) }),
    );
    infoLog.mockRestore();
  });

  it("backs off a hosted processor when its configured event condition throws", async () => {
    const h = connectionsHarness();
    const calls: DeliveryCall[] = [];
    const disposed = vi.fn();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const connection = h.connections.openHosted({
      connectionKey: "processor",
      expectedHostedDelivery: h.expectedDelivery,
      processEventBatch: recordingProcessEventBatch(calls, disposed),
      replayAfterOffset: 0,
      filter: {
        matches: () => {
          throw new Error("filter exploded");
        },
      },
    });

    connection.sendQueued();
    await flushMicrotasks();

    expect(calls).toHaveLength(0);
    expect(h.deliveryFailures).toHaveBeenCalledOnce();
    expect(h.deliveryFailures).toHaveBeenCalledWith("processor", expect.any(Error));
    expect(h.store.get("processor")).toMatchObject({ attempt: 1, nextAttemptAt: 1_100 });
    expect(connection.isLive()).toBe(false);
    expect(disposed).toHaveBeenCalledOnce();
    expect(h.durableDeliveryWakes).toHaveBeenCalledOnce();
    errorLog.mockRestore();
  });

  it("dispatches one hosted batch at a time and clears the durable marker before the next", async () => {
    const h = connectionsHarness();
    h.store.nack("processor", {
      attempt: 14,
      nextAttemptAt: 1_100,
      error: "earlier callback failure",
    });
    const calls: DeliveryCall[] = [];
    const disposed = vi.fn();
    const connection = h.connections.openHosted({
      connectionKey: "processor",
      expectedHostedDelivery: h.expectedDelivery,
      processEventBatch: recordingProcessEventBatch(calls, disposed),
      replayAfterOffset: 0,
    });

    connection.sendQueued();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.batch.events.map((event) => event.offset)).toEqual([1]);
    expect(h.store.get("processor")).toMatchObject({
      attempt: 14,
      nextAttemptAt: 1_100,
      lastError: "earlier callback failure",
      inFlightDeadlineAt: 1_000 + DEFAULT_DELIVERY_TIMEOUT_MS,
      inFlightConnectionGeneration: 7,
    });

    connection.sendQueued();
    expect(calls).toHaveLength(1);

    calls[0]!.report("ok");
    await flushMicrotasks();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.batch.events.map((event) => event.offset)).toEqual([2]);
    expect(h.store.get("processor")).toMatchObject({
      attempt: 0,
      nextAttemptAt: null,
      lastError: null,
      inFlightDeadlineAt: 1_000 + DEFAULT_DELIVERY_TIMEOUT_MS,
      inFlightConnectionGeneration: 7,
    });
    expect(disposed).not.toHaveBeenCalled();
  });

  it("turns a live callback timeout into a counted failure and ignores its late result", async () => {
    const h = connectionsHarness();
    const calls: DeliveryCall[] = [];
    const disposed = vi.fn();
    const connection = h.connections.openHosted({
      connectionKey: "processor",
      expectedHostedDelivery: h.expectedDelivery,
      processEventBatch: recordingProcessEventBatch(calls, disposed),
      replayAfterOffset: 0,
    });
    connection.sendQueued();
    expect(calls).toHaveLength(1);

    h.setNow(1_000 + DEFAULT_DELIVERY_TIMEOUT_MS);
    h.connections.onAlarm();

    expect(h.deliveryFailures).toHaveBeenCalledTimes(1);
    expect(h.store.get("processor")).toMatchObject({
      attempt: 1,
      inFlightDeadlineAt: null,
      inFlightConnectionGeneration: null,
    });
    expect(connection.isLive()).toBe(false);
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(h.durableDeliveryWakes).toHaveBeenCalledTimes(1);

    calls[0]!.report("ok");
    await flushMicrotasks();
    expect(calls).toHaveLength(1);
    expect(h.deliveryFailures).toHaveBeenCalledTimes(1);
  });

  it("idle teardown never acknowledges a batch that has not completed", () => {
    const h = connectionsHarness();
    const calls: DeliveryCall[] = [];
    const disposed = vi.fn();
    const connection = h.connections.openHosted({
      connectionKey: "processor",
      expectedHostedDelivery: h.expectedDelivery,
      processEventBatch: recordingProcessEventBatch(calls, disposed),
      replayAfterOffset: 0,
    });
    connection.sendQueued();
    const before = h.store.get("processor")!;

    h.connections.runIdleTeardownNow();

    expect(connection.isLive()).toBe(false);
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(h.store.get("processor")).toMatchObject({
      acknowledgedOffset: before.acknowledgedOffset,
      inFlightDeadlineAt: before.inFlightDeadlineAt,
      inFlightConnectionGeneration: before.inFlightConnectionGeneration,
    });
  });

  it("advances a completed hosted cursor through the close fact to avoid a self-wake loop", () => {
    const h = connectionsHarness({
      onAppend: ({ event, state }) => {
        // Model StreamDurableObject.#append's synchronous core-state fold.
        if (event.type === "events.iterate.com/stream/connection-opened") state.maxOffset = 4;
        if (event.type === "events.iterate.com/stream/connection-closed") state.maxOffset = 5;
      },
    });
    const disposed = vi.fn();
    h.store.ack("processor", 3);
    h.connections.openHosted({
      connectionKey: "processor",
      expectedHostedDelivery: h.expectedDelivery,
      processEventBatch: recordingProcessEventBatch([], disposed),
      replayAfterOffset: 3,
    });

    expect(h.connections.runIdleTeardownNow()).toEqual(["processor"]);

    expect(disposed).toHaveBeenCalledOnce();
    expect(h.state.maxOffset).toBe(5);
    expect(h.store.get("processor")).toMatchObject({ acknowledgedOffset: 5 });
  });
});

import { DatabaseSync } from "node:sqlite";
import {
  StreamReceiverUnavailableError,
  type StreamEvent,
  type StreamEventBatch,
  type StreamWakeEventBatch,
} from "iterate/processors";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerBuildFailedError } from "../workers/artifact-store.ts";
import {
  CoreProcessorContract,
  type CoreProcessorState,
  type SubscriptionConfiguredPayload,
} from "./core-processor-contract.ts";
import type { RetainedProcessEventBatch } from "./retained-event-callbacks.ts";
import { internalStreamId } from "./stream-delivery-utils.ts";
import { StreamEventSender, type SubscriptionReceiverCalls } from "./stream-event-sender.ts";
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
  appendDeliveryEvent?: ConstructorParameters<
    typeof StreamEventSender
  >[0]["hooks"]["appendDeliveryEvent"];
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
  const store = new SqliteSubscriptionCursorStore(wrapSqlStorage(new DatabaseSync(":memory:")));
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
    expect(h.eventSender.hasConnection(PROCESSOR_KEY)).toBe(false);
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
      filter: { eventTypes: ["a", "b"], condition: "payload.keep = true" },
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
    expect(h.eventSender.hasConnection(PROCESSOR_KEY)).toBe(true);
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

    expect(h.eventSender.hasConnection(PROCESSOR_KEY)).toBe(false);
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
    expect(h.eventSender.hasConnection(PROCESSOR_KEY)).toBe(false);
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
    expect(h.eventSender.hasConnection(PROCESSOR_KEY)).toBe(true);

    h.eventSender.runIdleTeardownNow();
    h.eventSender.sendDue();
    await h.settle();
    expect(h.eventSender.hasConnection(PROCESSOR_KEY)).toBe(false);
    expect(h.wakeCalls).toHaveLength(1);

    events.push(event(3, "b", { keep: true }));
    h.state.maxOffset = 3;
    h.eventSender.sendDue();
    await h.settle();
    expect(h.wakeCalls).toHaveLength(2);
    expect(h.eventSender.hasConnection(PROCESSOR_KEY)).toBe(true);
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
    expect(h.eventSender.hasConnection(PROCESSOR_KEY)).toBe(true);

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
    expect(h.eventSender.hasConnection(PROCESSOR_KEY)).toBe(true);
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
});

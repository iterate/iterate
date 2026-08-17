import { DatabaseSync } from "node:sqlite";
import {
  StreamReceiverUnavailableError,
  type StreamDeliveryBatch,
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
  hostedDeliveryLimit,
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
    name: PROCESSOR_KEY,
    description: "Focused hosted processor test",
    ...(filter === undefined ? {} : { filter }),
    receiver: {
      action: "wake-processor",
      expression: ["agents", ["get", "/source"], "processor", "wakeStreamProcessor"],
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
        byName: {
          [PROCESSOR_KEY]: {
            configuration: { ...configuration, name: PROCESSOR_KEY },
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
  const alarmClears: number[] = [];
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
      clearAlarm: () => alarmClears.push(now),
      runDurable: (work) => kept.push(work()),
      keepAlive: (promise) => kept.push(promise),
      subscriberPagerConnectionKeys: () => new Set<string>(),
      onSessionsIdleClosed: () => undefined,
      pageDormantSubscribers: () => undefined,
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
    alarmClears,
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
    h.state.subscriptions.outbound.byName[PROCESSOR_KEY] = {
      configuration: {
        name: PROCESSOR_KEY,
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
      confirmedOffset: 0,
      cursorChangedAtOffset: 1,
      attempt: 3,
    });

    expect(h.eventSender.sendDue()).toBe(true);

    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      confirmedOffset: 2,
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

  it("reopens from a lower processor checkpoint on new work and retries on a quiet alarm", async () => {
    const attemptedOffsets: number[][] = [];
    let wakeNumber = 0;
    const h = harness({
      events: [
        event(2, "b", { keep: true }),
        event(3, "b", { keep: true }),
        event(4, "b", { keep: true }),
      ],
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
    // The stored cursor was caught up before offset 4 arrived. Waking for that
    // real append still trusts the processor's lower checkpoint and replays
    // from it; only lifecycle-only suffixes are suppressed.
    h.store.ack(PROCESSOR_KEY, 3);

    h.eventSender.sendDue();
    await h.settle();

    expect(h.wakeCalls).toHaveLength(1);
    expect(attemptedOffsets).toEqual([[2]]);
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      confirmedOffset: 3,
      attempt: 1,
      nextAttemptAt: 11_000,
      lastError: "processor callback failed",
    });

    h.setNow(11_000);
    h.eventSender.onAlarm();
    await h.settle();

    expect(h.wakeCalls).toHaveLength(2);
    expect(attemptedOffsets).toEqual([[2], [4]]);
    expect(h.eventSender.connections.has(PROCESSOR_KEY)).toBe(true);
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      confirmedOffset: 3,
      nextAttemptAt: null,
    });
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
      confirmedOffset: 0,
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
      confirmedOffset: 0,
      attempt: 1,
      lastError: `hosted processor checkpoint belongs to stream ID ${RECREATED_STREAM_ID}, expected ${SOURCE_STREAM_ID}`,
    });
    expect(processEventBatch[Symbol.dispose]).toHaveBeenCalledOnce();
  });

  it("keeps an idle-closed hosted processor dormant across Stream incarnations", async () => {
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

    h.setNow(15_000);
    h.eventSender.onAlarm();
    await h.settle();
    expect(h.eventSender.connections.has(PROCESSOR_KEY)).toBe(false);
    expect(h.wakeCalls).toHaveLength(1);
    expect(h.alarmClears.length).toBeGreaterThan(0);

    // A cold Stream boot appends `woken`. The new sender has none of the old
    // sender's memory, so the durable cursor must be sufficient to classify
    // that lifecycle-only suffix as non-waking and advance through it.
    events.push(event(3, "events.iterate.com/stream/woken", { incarnationId: "fresh" }));
    const rebuilt = harness({
      events,
      store: h.store,
      wakeProcessor: async () => ({
        streamId: SOURCE_STREAM_ID,
        checkpointOffset: 4,
        processEventBatch: retainedProcessEventBatch((batch) => {
          batch.reportDeliveryResult({ outcome: "ok" });
        }),
      }),
    });
    rebuilt.eventSender.sendDue();
    await rebuilt.settle();
    expect(rebuilt.wakeCalls).toHaveLength(0);
    expect(rebuilt.store.get(PROCESSOR_KEY)).toMatchObject({ confirmedOffset: 3 });
    expect(rebuilt.alarmClears.length).toBeGreaterThan(0);

    events.push(event(4, "b", { keep: true }));
    rebuilt.state.maxOffset = 4;
    rebuilt.eventSender.sendDue();
    await rebuilt.settle();
    expect(rebuilt.wakeCalls).toHaveLength(1);
    expect(rebuilt.eventSender.connections.has(PROCESSOR_KEY)).toBe(true);
  });

  it("wakes a hosted processor whose filter explicitly names a lifecycle event", async () => {
    const h = harness({
      events: [event(2, "events.iterate.com/stream/woken", { incarnationId: "fresh" })],
      filter: { eventTypes: ["events.iterate.com/stream/woken"] },
      wakeProcessor: async () => ({
        streamId: SOURCE_STREAM_ID,
        checkpointOffset: 2,
        processEventBatch: retainedProcessEventBatch(() => undefined),
      }),
    });
    h.store.ack(PROCESSOR_KEY, 1);

    h.eventSender.sendDue();
    await h.settle();

    expect(h.wakeCalls).toHaveLength(1);
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
      confirmedOffset: 2,
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
    h.state.subscriptions.outbound.byName[PROCESSOR_KEY] = {
      configuration: { ...hostedConfig(), name: PROCESSOR_KEY },
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
        name: PROCESSOR_KEY,
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
      confirmedOffset: 0,
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
      confirmedOffset: 2,
      attempt: 1,
      nextAttemptAt: 12_000,
    });

    h.setNow(13_000);
    h.eventSender.onAlarm();
    await h.settle();
    expect(attemptedOffsets).toEqual([[2, 3, 4], [2], [3, 4], [3]]);
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      confirmedOffset: 2,
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
        name: PROCESSOR_KEY,
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
      confirmedOffset: 0,
      attempt: 1,
      nextAttemptAt: 11_000,
      failingEventOffset: null,
      failingEventAttempt: 0,
    });
  });

  it("deletes the alarm once the last send settles with nothing due, and never while a retry is pending", async () => {
    const itxConfig = {
      name: PROCESSOR_KEY,
      receiver: {
        action: "itx-call",
        expression: ["worker", "processEventBatch"],
        delivery: { start: "beginning", onFailingEvent: "halt" },
      },
    } satisfies SubscriptionConfiguredPayload;

    // Success: the send's pre-armed in-flight watchdog would otherwise
    // outlive this delivery and boot the hibernated stream forever (each
    // boot appends `woken`, whose delivery arms the next watchdog).
    const ok = harness({
      events: [event(2, "example.com/issue-created", { issue: 1 })],
      configuration: itxConfig,
      deliverToItx: async () => undefined,
      wakeProcessor: async () => {
        throw new Error("an ITX receiver must not wake a hosted processor");
      },
    });
    ok.eventSender.sendDue();
    await ok.settle();
    expect(ok.store.get(PROCESSOR_KEY)?.confirmedOffset).toBe(2);
    expect(ok.alarmClears.length).toBeGreaterThan(0);

    // Failure: a pending retry row must keep the alarm armed — the quiet
    // check may never delete a wake a durable obligation depends on.
    const failing = harness({
      events: [event(2, "example.com/issue-created", { issue: 1 })],
      configuration: itxConfig,
      deliverToItx: async () => {
        throw new Error("receiver down");
      },
      wakeProcessor: async () => {
        throw new Error("an ITX receiver must not wake a hosted processor");
      },
    });
    failing.eventSender.sendDue();
    await failing.settle();
    expect(failing.store.get(PROCESSOR_KEY)?.nextAttemptAt).not.toBeNull();
    expect(failing.alarmClears).toEqual([]);
  });

  it("never clears the alarm while un-acked lag has no scheduled retry (lifecycle-retry state)", async () => {
    // Model the lifecycle-retry state directly: a non-halted row lagging the
    // head with nothing scheduled (an interrupted audit append leaves the
    // cursor untouched and arms only a bare short-delay alarm). The quiet
    // deletion must see that lag as pending work.
    const h = harness({
      events: [event(2, "example.com/issue-created", { issue: 1 })],
      configuration: {
        name: PROCESSOR_KEY,
        filter: { jsonataCondition: "$notAFunction(payload)" },
        receiver: {
          action: "itx-call",
          expression: ["worker", "processEventBatch"],
          delivery: { start: "beginning", onFailingEvent: "halt" },
        },
      },
      // The audit append for the filter failure is interrupted (false): the
      // loop arms the lifecycle retry, leaves the row un-acked, and returns.
      appendDeliveryEvent: (entry) =>
        entry.type === "events.iterate.com/stream/error-occurred" ? false : true,
      deliverToItx: async () => undefined,
      wakeProcessor: async () => {
        throw new Error("an ITX receiver must not wake a hosted processor");
      },
    });
    h.eventSender.sendDue();
    await h.settle();

    const row = h.store.get(PROCESSOR_KEY)!;
    expect(row.confirmedOffset).toBeLessThan(h.state.maxOffset);
    expect(row.nextAttemptAt).toBeNull();
    // The bare lifecycle retry was armed and, critically, never cleared.
    expect(h.alarmClears).toEqual([]);
  });

  it("an ITX transform shapes each delivered event while the batch keeps the source coordinates", async () => {
    const batches: StreamDeliveryBatch[] = [];
    const deliverToItx = vi.fn<SubscriptionReceiverCalls["deliverToItx"]>(
      async (_expression, batch) => {
        batches.push(batch);
      },
    );
    const h = harness({
      events: [
        event(2, "example.com/issue-created", { issue: 21, internal: "drop-me" }),
        event(3, "example.com/issue-created", { issue: 40 }),
      ],
      configuration: {
        name: PROCESSOR_KEY,
        receiver: {
          action: "itx-call",
          expression: ["worker", "processEventBatch"],
          jsonataTransform:
            '{ "type": "example.com/issue-summary", "payload": { "issue": payload.issue, "doubled": payload.issue * 2 } }',
          delivery: { start: "beginning", onFailingEvent: "halt" },
        },
      },
      deliverToItx,
      wakeProcessor: async () => {
        throw new Error("an ITX receiver must not wake a hosted processor");
      },
    });

    h.eventSender.sendDue();
    await h.settle();

    expect(batches).toHaveLength(1);
    expect(batches[0]!.events).toMatchObject([
      {
        type: "example.com/issue-summary",
        payload: { issue: 21, doubled: 42 },
        // The coordinates keep naming the source rows under a reshaped body.
        offset: 2,
        path: "/source",
      },
      {
        type: "example.com/issue-summary",
        payload: { issue: 40, doubled: 80 },
        offset: 3,
        path: "/source",
      },
    ]);
    expect(batches[0]!.events[0]!.payload).not.toHaveProperty("internal");
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      confirmedOffset: 3,
      attempt: 0,
      nextAttemptAt: null,
    });
  });

  it("an ITX transform evaluation failure is a delivery failure that skip policy isolates and steps over", async () => {
    const appended: StreamEventInput[] = [];
    const deliveredOffsets: number[][] = [];
    const deliverToItx = vi.fn<SubscriptionReceiverCalls["deliverToItx"]>(
      async (_expression, batch) => {
        deliveredOffsets.push(batch.events.map(({ offset }) => offset));
      },
    );
    const h = harness({
      events: [
        event(2, "example.com/issue-created", { issue: 1 }),
        event(3, "example.com/issue-created", { poison: true }),
        event(4, "example.com/issue-created", { issue: 3 }),
      ],
      configuration: {
        name: PROCESSOR_KEY,
        receiver: {
          action: "itx-call",
          expression: ["worker", "processEventBatch"],
          jsonataTransform: 'payload.poison ? $error("poison event") : { "payload": payload }',
          delivery: { start: "beginning", onFailingEvent: "skip" },
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
    let nowMs = 10_000;
    for (let alarmRound = 0; alarmRound < 3; alarmRound += 1) {
      nowMs += 2_000_000; // beyond the 30-minute backoff cap
      h.setNow(nowMs);
      h.eventSender.onAlarm();
      await h.settle();
    }

    // The poison event never reached the wire — its transform failed while
    // the batch was built — and the ladder still isolated the healthy prefix,
    // confirmed the failing event, and stepped over it.
    expect(deliveredOffsets).toEqual([[2], [4]]);
    const skipAudits = appended.filter(
      (input) => input.type === "events.iterate.com/stream/error-occurred",
    );
    expect(skipAudits).toHaveLength(1);
    expect(skipAudits[0]!.payload).toMatchObject({
      message: expect.stringContaining("skipped failing event at offset 3"),
    });
    expect(String(skipAudits[0]!.payload!.message)).toContain(
      `itx transform for subscription "${PROCESSOR_KEY}" failed on /source@3`,
    );
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      confirmedOffset: 4,
      attempt: 0,
      nextAttemptAt: null,
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
        name: PROCESSOR_KEY,
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
          name: PROCESSOR_KEY,
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
          name: PROCESSOR_KEY,
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
        name: PROCESSOR_KEY,
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
        name: PROCESSOR_KEY,
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
      confirmedOffset: 0,
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
      confirmedOffset: 2,
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
        name: PROCESSOR_KEY,
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
      confirmedOffset: 3,
      attempt: 0,
      nextAttemptAt: null,
      lastError: null,
    });
  });

  it("withholds incarnation/connection lifecycle facts from stream copies", async () => {
    const delivered: StreamEvent[][] = [];
    const copyToStream = vi.fn<SubscriptionReceiverCalls["copyToStream"]>(async (_path, batch) => {
      delivered.push(batch.events);
      return { acknowledged: batch.events.length };
    });
    const h = harness({
      events: [
        event(2, "events.iterate.com/stream/woken", { incarnationId: "incarnation-a" }),
        event(3, "events.iterate.com/stream/connection-opened", { connectionKey: "session" }),
        event(4, "example.com/issue-created", { issue: 42 }),
        event(5, "events.iterate.com/stream/connection-closed", {
          connectionKey: "session",
          reason: "idle",
        }),
      ],
      configuration: {
        name: PROCESSOR_KEY,
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

    // Only the product event crosses. The cursor still advances over the
    // withheld lifecycle rows, so a reciprocal copy pair runs out of fuel
    // instead of manufacturing wake events forever (every boot appends a
    // fresh unkeyed `woken`, and the circuit breaker ignores control events).
    expect(delivered.map((batch) => batch.map(({ offset }) => offset))).toEqual([[4]]);
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      confirmedOffset: 5,
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
        name: PROCESSOR_KEY,
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
        name: PROCESSOR_KEY,
        reason: "delivery-failed",
        afterOffset: 0,
        attempts: 15,
        error: "receiving stream is paused",
      },
    });
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      confirmedOffset: 0,
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
      name: PROCESSOR_KEY,
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
    h.state.subscriptions.outbound.byName[PROCESSOR_KEY] = {
      configuration: {
        ...configuration,
        name: PROCESSOR_KEY,
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
      confirmedOffset: 0,
    });

    receipt.resolve({ acknowledged: 1 });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The stale acknowledgement was discarded; the replacement run re-sends
    // from its own cursor and its still-open delivery owns future progress.
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      configuredAtOffset: 3,
      confirmedOffset: 0,
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
      name: PROCESSOR_KEY,
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
    h.state.subscriptions.outbound.byName[PROCESSOR_KEY] = {
      configuration: {
        ...configuration,
        name: PROCESSOR_KEY,
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
      confirmedOffset: 0,
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
        name: PROCESSOR_KEY,
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
          name: PROCESSOR_KEY,
          reason: "delivery-failed",
          afterOffset: 3,
          attempts: 3,
        }),
      }),
    ]);
    // Durably halted: the failed row keeps its cursor but stops arming alarms.
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      confirmedOffset: 3,
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
      name: PROCESSOR_KEY,
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
      name: PROCESSOR_KEY,
      cursorChangedAtSourceOffset: 1,
      attempt: 1,
      configuredEvent: { type: "events.iterate.com/stream/subscription-configured" },
    });
    // The lean per-event envelope: no batch array and no reduced core state.
    expect(deliveries[0]).not.toHaveProperty("events");
    expect(deliveries[0]).not.toHaveProperty("state");
    expect(new Set(deliveries.map((delivery) => delivery.deliveryId)).size).toBe(3);
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      confirmedOffset: 4,
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
      confirmedOffset: 2,
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
      confirmedOffset: 3,
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
          name: PROCESSOR_KEY,
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
      confirmedOffset: 4,
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
    h.state.subscriptions.outbound.byName[PROCESSOR_KEY] = {
      configuration: {
        ...webhookConfig({ url: "https://replacement.example/events" }),
        name: PROCESSOR_KEY,
      },
      configuredAtOffset: 3,
      configuredAt: new Date(3).toISOString(),
    };
    h.eventSender.sendDue();
    expect(h.store.get(PROCESSOR_KEY)).toMatchObject({
      configuredAtOffset: 3,
      confirmedOffset: 0,
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
      confirmedOffset: 0,
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
    delete h.state.subscriptions.outbound.byName[PROCESSOR_KEY];
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
      confirmedOffset: 2,
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
      confirmedOffset: 4,
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
    subscriberPagerConnectionKeys?: () => ReadonlySet<string>;
    onSessionsIdleClosed?: (connectionKeys: readonly string[]) => void;
    readBatch?: ConstructorParameters<typeof StreamConnections>[0]["hooks"]["readBatch"];
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
  const sessionsIdleClosed: string[][] = [];
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
    hooks: {
      // Force several batches so the test can observe the one-at-a-time gate.
      readBatch:
        options.readBatch ??
        ((afterOffset) =>
          events
            .filter((event) => event.offset > afterOffset)
            .slice(0, 1)
            .map((event) => ({ event, byteLength: JSON.stringify(event).length }))),
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
      subscriberPagerConnectionKeys:
        options.subscriberPagerConnectionKeys ?? (() => new Set<string>()),
      onSessionsIdleClosed: (keys) => {
        sessionsIdleClosed.push([...keys]);
        options.onSessionsIdleClosed?.(keys);
      },
      reconcileAlarm: () => undefined,
      hostedDeliveryStillMatches: (_name, candidate) =>
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
    sessionsIdleClosed,
    deliveryFailures,
    durableDeliveryWakes,
    setNow(value: number) {
      now = value;
    },
  };
}

describe("hosted delivery coalesces ephemeral events", () => {
  /*
   * The one-at-a-time boundary exists so a slow event cannot make its
   * already-processed siblings time out and REPLAY. An ephemeral event cannot
   * be replayed at all, so the boundary costs a round trip and buys nothing —
   * and at 50 frames a second that cost was measured as ~700ms of push-to-talk
   * latency, because the lane delivered slower than audio arrived.
   */
  const frame = (offset: number, ephemeral: boolean) => ({
    event: { ...streamEvent(offset, "events.example.com/f"), ...(ephemeral ? { ephemeral } : {}) },
  });

  it("takes a whole run of ephemeral events", () => {
    expect(hostedDeliveryLimit([0, 1, 2, 3, 4].map((o) => frame(o + 1, true)))).toBe(5);
  });

  it("does not cap the run by COUNT, because bytes are what cost a turn", () => {
    /*
     * This asserted a cap of ten, described as "a fifth of a second of audio"
     * — a number about a lane that sent one event per 20 ms frame and no
     * longer exists. A count was always the wrong unit: ten tiny events and
     * ten megabyte events cost a callback turn wildly different amounts.
     * `DELIVERY_BATCH_BYTE_LIMIT` bounds a batch in bytes, for every
     * connection kind, and keeps an escape hatch so a lone oversized event
     * cannot wedge delivery. That is the cap that was ever doing the work.
     */
    expect(hostedDeliveryLimit(Array.from({ length: 40 }, (_u, o) => frame(o + 1, true)))).toBe(40);
  });

  it("stops at the first durable event, which keeps its own boundary", () => {
    /* A durable event must never ride in a coalesced batch: replay protection
     * is exactly what the one-at-a-time rule buys, and it still needs it. */
    expect(hostedDeliveryLimit([frame(1, true), frame(2, true), frame(3, false)])).toBe(2);
  });

  it("leaves a durable-led batch at one, exactly as before", () => {
    expect(hostedDeliveryLimit([frame(1, false), frame(2, true)])).toBe(1);
  });
});

describe("ephemeral delivery to hosted processors", () => {
  /*
   * ONE RULE: a hosted processor receives an ephemeral event when its contract
   * names that exact type in `consumes`. Not through `"*"`, which exists for
   * durable facts and must never hand anyone a microphone firehose they did
   * not ask for; and not through a second declaration list, because naming the
   * type IS the permission.
   */
  const announcing = (consumes: string[]) => ({
    processor: {
      announcement: {
        slug: "voice-agent",
        version: "1.0.0",
        description: "d",
        consumes,
        emits: [],
        ownedEvents: [],
      },
    },
  });

  const wakeReturning = (calls: DeliveryCall[], consumes: string[] | undefined) => async () => ({
    streamId: SOURCE_STREAM_ID,
    checkpointOffset: 0,
    processEventBatch: recordingProcessEventBatch(calls, () => undefined),
    ...(consumes === undefined ? {} : { openedBy: announcing(consumes) }),
  });

  const ephemeralFirst = (): StreamEvent[] => [
    { ...streamEvent(1, "events.example.com/mic-frame"), ephemeral: true },
    streamEvent(2, "events.example.com/conversation-requested"),
  ];

  const typesDelivered = (calls: DeliveryCall[]) =>
    calls.flatMap((call) => (call.batch.events ?? []).map((event) => event.type));

  const drive = async (consumes: string[] | undefined) => {
    const calls: DeliveryCall[] = [];
    const h = harness({
      events: ephemeralFirst(),
      configuration: {
        name: PROCESSOR_KEY,
        description: "hosted",
        receiver: {
          action: "wake-processor",
          expression: ["agents", ["get", "/source"], "processor", "wakeStreamProcessor"],
        },
      },
      wakeProcessor: wakeReturning(calls, consumes),
    });
    h.eventSender.sendDue();
    await h.settle();
    return typesDelivered(calls);
  };

  it("delivers an ephemeral event whose type the processor named", async () => {
    expect(await drive(["events.example.com/mic-frame"])).toContain("events.example.com/mic-frame");
  });

  /*
   * THE RULE THAT MAKES ONE LIST SAFE. A wildcard is written for durable
   * facts; sweeping live audio into it would be a firehose nobody asked for,
   * and a processor cannot fold an ephemeral event into reduced state anyway.
   */
  it("never delivers one through the star wildcard", async () => {
    expect(await drive(["*"])).not.toContain("events.example.com/mic-frame");
  });

  it("withholds one the processor did not name", async () => {
    expect(await drive(["events.example.com/conversation-requested"])).not.toContain(
      "events.example.com/mic-frame",
    );
  });

  /* A processor that announces nothing keeps exactly today's delivery. */
  it("withholds one from a processor that announces nothing", async () => {
    expect(await drive(undefined)).not.toContain("events.example.com/mic-frame");
  });

  /*
   * Session connections are unchanged and must stay that way: they own no
   * durable cursor, so an evicted body costs them nothing, and they have
   * always received both kinds. A regression here would be silent — the
   * stream viewer would simply stop showing live audio.
   */
  it("leaves session connections receiving both kinds", () => {
    const calls: DeliveryCall[] = [];
    const h = connectionsHarness({ events: ephemeralFirst() });
    const connection = h.connections.openSession({
      connectionKey: "viewer",
      processEventBatch: recordingProcessEventBatch(calls, () => undefined),
      replayAfterOffset: 0,
    });
    connection.sendQueued();
    expect(typesDelivered(calls)).toContain("events.example.com/mic-frame");
  });
});

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
      name: "processor",
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

  it("caps session batches without skipping events and can omit reduced state", async () => {
    const events = Array.from({ length: 5 }, (_, index) => streamEvent(index + 1));
    const calls: DeliveryCall[] = [];
    const h = connectionsHarness({
      events,
      readBatch: (afterOffset, _beforeOffset, limit) =>
        events
          .filter((candidate) => candidate.offset > afterOffset)
          .slice(0, limit)
          .map((event) => ({ event, byteLength: JSON.stringify(event).length })),
    });

    h.connections.openSession({
      connectionKey: "capped-session",
      processEventBatch: recordingProcessEventBatch(calls, () => undefined),
      replayAfterOffset: 0,
      maxDeliveryEvents: 2,
      includeState: false,
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(calls.map(({ batch }) => batch.events.map(({ offset }) => offset))).toEqual([
      [1, 2],
      [3, 4],
      [5],
    ]);
    expect(calls.every(({ batch }) => batch.state === null)).toBe(true);
    expect(h.connections.runtimeState()["capped-session"]).toMatchObject({
      deliveredThroughOffset: 5,
      batchesSent: 3,
      eventsSent: 5,
    });
  });

  it("advances event-only sessions past filter-rejected appends without empty pushes", async () => {
    const events = [streamEvent(1, "events.example.com/ignored")];
    const calls: DeliveryCall[] = [];
    let readCalls = 0;
    const h = connectionsHarness({
      events,
      readBatch: (afterOffset, _beforeOffset, limit) => {
        readCalls += 1;
        return events
          .filter((candidate) => candidate.offset > afterOffset)
          .slice(0, limit)
          .map((event) => ({ event, byteLength: JSON.stringify(event).length }));
      },
    });
    const connection = h.connections.openSession({
      connectionKey: "filtered-session",
      processEventBatch: recordingProcessEventBatch(calls, () => undefined),
      replayAfterOffset: 0,
      filter: compileEventFilter({ eventTypes: ["events.example.com/matching"] }),
      includeState: false,
    });
    await flushMicrotasks();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.batch.events).toEqual([]);
    expect(calls[0]!.batch.scannedThroughOffset).toBe(1);
    expect(calls[0]!.batch.state).toBeNull();

    events.push(
      ...Array.from({ length: 2_001 }, (_, index) =>
        streamEvent(index + 2, "events.example.com/ignored"),
      ),
    );
    h.state.maxOffset = 2_002;
    const readsBeforeCatchUp = readCalls;
    connection.sendQueued();

    // One scan runs synchronously, then the skipped delivery yields. Without
    // that yield this call drains every 1,000-event page before returning.
    expect(readCalls).toBe(readsBeforeCatchUp + 1);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(calls).toHaveLength(1);
    expect(h.connections.runtimeState()["filtered-session"]).toMatchObject({
      deliveredThroughOffset: 2_002,
      batchesSent: 1,
      eventsSent: 0,
    });
  });

  it("delivers filter-rejected state changes to stateful sessions", async () => {
    const events = [streamEvent(1, "events.example.com/ignored")];
    const calls: DeliveryCall[] = [];
    const h = connectionsHarness({
      events,
      readBatch: (afterOffset, _beforeOffset, limit) =>
        events
          .filter((candidate) => candidate.offset > afterOffset)
          .slice(0, limit)
          .map((event) => ({ event, byteLength: JSON.stringify(event).length })),
    });
    const connection = h.connections.openSession({
      connectionKey: "stateful-filtered-session",
      processEventBatch: recordingProcessEventBatch(calls, () => undefined),
      replayAfterOffset: 0,
      filter: compileEventFilter({ eventTypes: ["events.example.com/matching"] }),
    });
    await flushMicrotasks();

    events.push(streamEvent(2, "events.example.com/ignored"));
    h.state.maxOffset = 2;
    connection.sendQueued();
    await flushMicrotasks();

    expect(calls).toHaveLength(2);
    expect(calls[1]!.batch).toMatchObject({
      events: [],
      scannedAfterOffset: 1,
      scannedThroughOffset: 2,
      streamMaxOffset: 2,
      state: { maxOffset: 2 },
    });
  });

  /*
   * THE HOSTED MIRROR OF THE SESSION SKIP ABOVE, AND IT MUST STAY THE
   * OPPOSITE. A state-free session whose filter rejected a window can be
   * skipped: it owns no cursor, so the skipped window costs it nothing. A
   * hosted processor cannot, and the empty frame is not a wasted round trip —
   * it is the entire catch-up channel:
   *
   *  - Its runner is opened with `sourceScansAllEvents: true`
   *    (stream-processor-registry.ts), which switches OFF the runner's own
   *    journal pull. These frames are then the ONLY thing that carries
   *    `scannedThroughOffset` across a filtered gap.
   *  - A frame that reaches the head is what fires the runner's eventless
   *    `processEvent({ event: null, delivery: { caughtUp: true } })` pass.
   *    Withhold it and every obligation the processor opened strands on a
   *    stream whose tail it does not consume — the late-agent regression.
   *  - `scannedAfterOffset` must stay contiguous with what the processor has
   *    acknowledged: the runner THROWS on
   *    `scannedAfterOffset > committedThroughOffset`, so "skip the window and
   *    resume after it" is not merely lossy, it fails the next delivery.
   */
  it("still hands a hosted processor the scan frame for a window its filter rejected", async () => {
    const events = [
      streamEvent(1, "events.example.com/ignored"),
      streamEvent(2, "events.example.com/ignored"),
      streamEvent(3, "events.example.com/ignored"),
    ];
    const calls: DeliveryCall[] = [];
    const h = connectionsHarness({
      events,
      readBatch: (afterOffset, _beforeOffset, limit) =>
        events
          .filter((candidate) => candidate.offset > afterOffset)
          .slice(0, limit)
          .map((event) => ({ event, byteLength: JSON.stringify(event).length })),
    });
    const connection = h.connections.openHosted({
      connectionKey: "processor",
      expectedHostedDelivery: h.expectedDelivery,
      processEventBatch: recordingProcessEventBatch(calls, () => undefined),
      replayAfterOffset: 0,
      filter: compileEventFilter({ eventTypes: ["events.example.com/matching"] }),
    });

    connection.sendQueued();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.batch).toMatchObject({
      events: [],
      scannedAfterOffset: 0,
      scannedThroughOffset: 3,
      streamMaxOffset: 3,
    });
    // The watchdog rides an empty frame exactly as it rides a full one: the
    // frame advances a durable cursor on the far side, so a vanished isolate
    // must still recover as an expired attempt.
    expect(h.store.get("processor")).toMatchObject({
      inFlightDeadlineAt: 1_000 + DEFAULT_DELIVERY_TIMEOUT_MS,
      inFlightConnectionGeneration: 7,
    });

    calls[0]!.report("ok");
    await flushMicrotasks();
    expect(h.store.get("processor")).toMatchObject({ inFlightDeadlineAt: null });

    // And the frame AFTER an all-rejected one resumes exactly where that one
    // scanned through — never after a gap the processor was never told about.
    events.push(streamEvent(4, "events.example.com/ignored"));
    h.state.maxOffset = 4;
    connection.sendQueued();
    await flushMicrotasks();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.batch).toMatchObject({
      events: [],
      scannedAfterOffset: 3,
      scannedThroughOffset: 4,
    });
  });

  it("classifies a broken hosted callback capability as lifecycle unavailability", () => {
    const h = connectionsHarness();
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let reportBroken: ((error: unknown) => void) | undefined;
    const processEventBatch = recordingProcessEventBatch([], () => undefined);
    processEventBatch.onRpcBroken = (handler) => {
      reportBroken = handler;
    };
    h.connections.openHosted({
      connectionKey: "processor",
      expectedHostedDelivery: h.expectedDelivery,
      processEventBatch,
      replayAfterOffset: 0,
    });

    reportBroken!(new Error("transport closed"));

    expect(h.connections.has("processor")).toBe(false);
    expect(h.deliveryFailures).toHaveBeenCalledOnce();
    expect(warnLog).toHaveBeenCalledWith(
      "stream durable callback unavailable; backing off before waking it again",
      {
        connectionKey: "processor",
        source: "rpc-broken",
        errorName: "Error",
        errorMessage: "transport closed",
        projectId: "project",
        streamPath: "/source",
        streamId: "11111111-1111-4111-8111-111111111111",
        configuredAtOffset: 12,
        cursorChangedAtOffset: 12,
        connectionGeneration: 7,
        deliveredThroughOffset: 0,
        streamMaxOffset: 3,
      },
    );
    expect(errorLog).not.toHaveBeenCalled();
    warnLog.mockRestore();
    errorLog.mockRestore();
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
    // The batch ack cleared the failure state but not the cursor: confirmed
    // advances only on reported checkpoints, never on batch acknowledgements.
    expect(h.store.get("processor")).toMatchObject({
      confirmedOffset: 0,
      attempt: 0,
      nextAttemptAt: null,
      lastError: null,
      inFlightDeadlineAt: 1_000 + DEFAULT_DELIVERY_TIMEOUT_MS,
      inFlightConnectionGeneration: 7,
    });
    expect(disposed).not.toHaveBeenCalled();
  });

  it("gives each matching hosted event an acknowledgement boundary without rescanning non-matches", async () => {
    const events = [
      streamEvent(1, "events.example.com/ignored"),
      streamEvent(2, "events.example.com/matched"),
      streamEvent(3, "events.example.com/matched"),
      streamEvent(4, "events.example.com/ignored"),
    ];
    const readLimits: number[] = [];
    const h = connectionsHarness({
      events,
      readBatch: (afterOffset, beforeOffset, limit) => {
        readLimits.push(limit);
        return events
          .filter((event) => event.offset > afterOffset && event.offset < beforeOffset)
          .slice(0, limit)
          .map((event) => ({ event, byteLength: JSON.stringify(event).length }));
      },
    });
    const calls: DeliveryCall[] = [];
    const connection = h.connections.openHosted({
      connectionKey: "processor",
      expectedHostedDelivery: h.expectedDelivery,
      processEventBatch: recordingProcessEventBatch(calls, () => undefined),
      replayAfterOffset: 0,
      filter: compileEventFilter({ eventTypes: ["events.example.com/matched"] }),
    });

    connection.sendQueued();
    expect(calls[0]!.batch).toMatchObject({
      scannedAfterOffset: 0,
      scannedThroughOffset: 2,
    });
    expect(calls[0]!.batch.events.map((event) => event.offset)).toEqual([2]);

    calls[0]!.report("ok");
    await flushMicrotasks();
    expect(calls[1]!.batch).toMatchObject({
      scannedAfterOffset: 2,
      scannedThroughOffset: 4,
    });
    expect(calls[1]!.batch.events.map((event) => event.offset)).toEqual([3]);
    expect(readLimits).toEqual([100, 100]);
  });

  it("turns a live callback timeout into a counted failure and ignores its late result", async () => {
    const h = connectionsHarness();
    const calls: DeliveryCall[] = [];
    const disposed = vi.fn();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const connection = h.connections.openHosted({
      connectionKey: "processor",
      expectedHostedDelivery: h.expectedDelivery,
      processEventBatch: recordingProcessEventBatch(calls, disposed),
      replayAfterOffset: 0,
      openedBy: {
        processor: {
          announcement: {
            slug: "test-processor",
            version: "1.0.0",
            description: "Test processor",
            consumes: [],
            emits: [],
            ownedEvents: [],
          },
        },
      },
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
    expect(errorLog).toHaveBeenCalledWith(
      "stream durable callback failed; backing off before waking it again",
      {
        connectionKey: "processor",
        source: "delivery",
        errorName: "Error",
        errorMessage: `hosted processor batch acknowledgement timed out after ${DEFAULT_DELIVERY_TIMEOUT_MS}ms`,
        projectId: "project",
        streamPath: "/source",
        streamId: "11111111-1111-4111-8111-111111111111",
        configuredAtOffset: 12,
        cursorChangedAtOffset: 12,
        connectionGeneration: 7,
        deliveredThroughOffset: 1,
        streamMaxOffset: 3,
        pendingDeliveryStartedAt: "1970-01-01T00:00:01.000Z",
        pendingDeliveryDeadlineAt: "1970-01-01T00:00:21.000Z",
        processorSlug: "test-processor",
        processorContractVersion: "1.0.0",
      },
    );

    calls[0]!.report("ok");
    await flushMicrotasks();
    expect(calls).toHaveLength(1);
    expect(h.deliveryFailures).toHaveBeenCalledTimes(1);
  });

  it("keeps ITX and Cloudflare references when a hosted processor reports an opaque failure", async () => {
    const h = connectionsHarness();
    const calls: DeliveryCall[] = [];
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const connection = h.connections.openHosted({
      connectionKey: "processor",
      expectedHostedDelivery: h.expectedDelivery,
      processEventBatch: recordingProcessEventBatch(calls, () => undefined),
      replayAfterOffset: 0,
    });
    connection.sendQueued();

    (calls[0]!.batch as StreamWakeEventBatch).reportDeliveryResult({
      outcome: "error",
      error: {
        name: "Error",
        message:
          "Internal error in Durable Object storage caused object to be reset; reference = h9ikm3iuo9v4aofff54akrbo",
        itxCallId: "log_0123456789abcdef0123456789abcdef",
        retryable: true,
      },
    });

    expect(warnLog).toHaveBeenCalledWith(
      "stream durable callback unavailable; backing off before waking it again",
      expect.objectContaining({
        connectionKey: "processor",
        source: "delivery",
        errorName: "Error",
        itxCallId: "log_0123456789abcdef0123456789abcdef",
        cloudflareErrorReference: "h9ikm3iuo9v4aofff54akrbo",
      }),
    );
    expect(h.deliveryFailures).toHaveBeenCalledOnce();
    expect(h.store.get("processor")).toMatchObject({
      attempt: 1,
      inFlightDeadlineAt: null,
      inFlightConnectionGeneration: null,
    });
    expect(connection.isLive()).toBe(false);
  });

  it("idle teardown closes a quiet sibling without interrupting a pending hosted batch", async () => {
    const h = connectionsHarness();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.store.ensure("settled", 0, 12);
    const pending = h.connections.openHosted({
      connectionKey: "processor",
      expectedHostedDelivery: h.expectedDelivery,
      processEventBatch: recordingProcessEventBatch([], () => undefined),
      replayAfterOffset: 0,
    });
    const settledCalls: DeliveryCall[] = [];
    h.connections.openHosted({
      connectionKey: "settled",
      expectedHostedDelivery: h.expectedDelivery,
      processEventBatch: recordingProcessEventBatch(settledCalls, () => undefined),
      replayAfterOffset: 2,
    });

    h.connections.sendQueued();
    settledCalls[0]!.report("ok");
    await flushMicrotasks();
    const pendingDeadline = h.store.get("processor")!.inFlightDeadlineAt!;

    h.setNow(6_000);
    h.connections.armOrClearIdleAlarm();
    expect(h.connections.onAlarm()).toEqual(["settled"]);
    expect(h.connections.has("settled")).toBe(false);
    expect(pending.isLive()).toBe(true);
    expect(h.store.get("processor")?.inFlightDeadlineAt).toBe(pendingDeadline);

    // Exemption from idle teardown is bounded by the existing delivery
    // watchdog, so a genuinely wedged callback still cannot pin forever.
    h.setNow(pendingDeadline);
    expect(h.connections.onAlarm()).toEqual([]);
    expect(pending.isLive()).toBe(false);
    expect(h.deliveryFailures).toHaveBeenCalledOnce();
    errorLog.mockRestore();
  });

  it("idle-tears a session connection only when it has a Pager, stamping after the close fact", () => {
    // One shared journal so append-vs-stamp ORDERING is actually assertable.
    const journal: string[] = [];
    const h = connectionsHarness({
      subscriberPagerConnectionKeys: () => new Set(["with-channel"]),
      onAppend: ({ event }) => {
        journal.push(event.type);
      },
      onSessionsIdleClosed: (keys) => journal.push(`stamp:${keys.join(",")}`),
    });
    h.connections.openSession({
      connectionKey: "with-channel",
      processEventBatch: () => undefined,
    });
    h.connections.openSession({
      connectionKey: "without-channel",
      processEventBatch: () => undefined,
    });

    expect(h.connections.runIdleTeardownNow()).toEqual(["with-channel"]);

    // The wake-channel-backed session closed with "idle"; the socketless one
    // keeps today's pinned semantics and stays live.
    expect(h.connections.has("with-channel")).toBe(false);
    expect(h.connections.has("without-channel")).toBe(true);
    // The dormancy stamp is ordered AFTER the close fact so this teardown's
    // own append can never wake the subscriber it closed.
    const closeIndex = journal.lastIndexOf("events.iterate.com/stream/connection-closed");
    const stampIndex = journal.indexOf("stamp:with-channel");
    expect(closeIndex).toBeGreaterThanOrEqual(0);
    expect(stampIndex).toBeGreaterThan(closeIndex);
    expect(h.sessionsIdleClosed).toEqual([["with-channel"]]);
    // Session connections never grow cursor rows.
    expect(h.store.get("with-channel")).toBeUndefined();
  });

  it("derives the idle deadline from delivery activity instead of sliding it per reconcile", () => {
    const h = connectionsHarness({
      subscriberPagerConnectionKeys: () => new Set(["session"]),
      events: [],
    });
    h.connections.openSession({
      connectionKey: "session",
      processEventBatch: () => undefined,
    });
    // Publication itself arms the deadline: the opened-fact reconcile runs
    // before the connection is in the map, and with quiet-alarm deletion no
    // stray later fire exists to paper over a missed arming (Bugbot 3705177939).
    const armedAtPublication = h.alarmTimes.at(-1);
    expect(armedAtPublication).toBeDefined();
    h.connections.armOrClearIdleAlarm();
    const firstDeadline = h.alarmTimes.at(-1);
    expect(firstDeadline).toBe(armedAtPublication);

    // Re-running the check with no new delivery activity must keep the SAME
    // deadline: the old now+window reset slid it forward on the idle alarm's
    // own turn, so a fire landing just before the pushed deadline missed it
    // and real-clock teardown took up to two windows.
    h.setNow(4_000);
    h.connections.armOrClearIdleAlarm();
    expect(h.alarmTimes.at(-1)).toBe(firstDeadline);

    // A fire that lands moments before the (unchanged) deadline re-arms the
    // deadline itself, never a fresh whole window.
    h.setNow(firstDeadline! - 1);
    h.connections.armOrClearIdleAlarm();
    expect(h.alarmTimes.at(-1)).toBe(firstDeadline);
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
    // The cursor advances through the close facts on purpose: the row is only
    // the source stream's wake/delivery position, and the runner's OWN durable
    // checkpoint — which never advanced over the close facts — is what its
    // next real wake replays from.
    expect(h.store.get("processor")).toMatchObject({ confirmedOffset: 5 });
  });
});

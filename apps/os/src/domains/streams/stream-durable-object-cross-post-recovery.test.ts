import { DatabaseSync } from "node:sqlite";
import type {
  StreamDeliveryBatch,
  StreamEvent,
  StreamEventInput,
  CrossPostReceipt,
} from "iterate/processors";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import {
  CORE_STATE_VERSION,
  recordedSubscriptionForCrossPost,
  subscriptionConfigurationForDelivery,
  type SubscriptionConfiguredPayload,
} from "./core-processor-contract.ts";
import { MAX_CORE_PROCESSOR_STATE_BYTES } from "./core-processor.ts";
import { computeBackoffMs } from "./delivery-math.ts";
import { MAX_CROSS_POST_LIST_ATTEMPTS } from "./cross-post-list-retry-store.ts";
import { internalStreamId } from "./stream-delivery-utils.ts";
import { StreamDurableObject } from "./stream-durable-object.ts";

const PROJECT_ID = "prj_cross_post_recovery";
const SOURCE_PATH = "/";
const RECEIVING_STREAM_PATH = "/reviewer";
const SUBSCRIPTION_KEY = "review-issues";
const MATCHING_EVENT_TYPE = "example.com/issue-created";
const SOURCE_STREAM_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_STREAM_CREATED_AT = "2026-07-21T12:00:00.000Z";

type StreamStub = {
  appendCoreEvent(event: StreamEventInput): Promise<StreamEvent>;
  recordCrossPostListFromSource(event: StreamEventInput): Promise<StreamEvent>;
  receiveCrossPostedEvents(batch: StreamDeliveryBatch): Promise<CrossPostReceipt>;
};

function streamName(path: string): string {
  return DurableObjectNameCodec.stringify(
    { projectId: PROJECT_ID, path },
    { allowNullProjectId: true },
  );
}

function wrapSqlStorage(db: DatabaseSync): SqlStorage {
  return {
    databaseSize: 0,
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
  } as unknown as SqlStorage;
}

function fromNodeSqlValue([key, value]: [string, unknown]) {
  if (value instanceof Uint8Array) {
    return [key, value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)];
  }
  return [key, value];
}

function durableObjectContext(name: string) {
  const db = new DatabaseSync(":memory:");
  const values = new Map<string, unknown>();
  const backgroundWork: Promise<unknown>[] = [];
  const alarms: number[] = [];
  let storageSyncCount = 0;
  let latestInitialization: Promise<unknown> | undefined;
  let kvPutFailure: { error: Error; key?: string } | undefined;
  const storage = {
    sql: wrapSqlStorage(db),
    kv: {
      get<T>(key: string): T | undefined {
        const value = values.get(key);
        return value === undefined ? undefined : structuredClone(value as T);
      },
      put(key: string, value: unknown): void {
        if (
          kvPutFailure !== undefined &&
          (kvPutFailure.key === undefined || kvPutFailure.key === key)
        ) {
          throw kvPutFailure.error;
        }
        values.set(key, structuredClone(value));
      },
      delete(key: string): void {
        values.delete(key);
      },
    },
    setAlarm(atMs: number): Promise<void> {
      alarms.push(atMs);
      return Promise.resolve();
    },
    sync(): Promise<void> {
      storageSyncCount += 1;
      return Promise.resolve();
    },
    transactionSync<T>(callback: () => T): T {
      return callback();
    },
  };
  const ctx = {
    id: { name },
    storage,
    exports: {},
    waitUntil(work: Promise<unknown>): void {
      backgroundWork.push(work);
    },
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      const work = Promise.resolve().then(callback);
      latestInitialization = work;
      return work;
    },
    abort(): never {
      throw new Error("test Durable Object aborted");
    },
  } as unknown as DurableObjectState;

  return {
    alarms,
    close: () => db.close(),
    ctx,
    deleteEventChunksBetween(firstOffset: number, lastOffset: number): void {
      db.prepare("delete from event_chunks where offset >= ? and offset <= ?").run(
        firstOffset,
        lastOffset,
      );
    },
    replaceEventBody(offset: number, event: StreamEvent): void {
      const bytes = new TextEncoder().encode(JSON.stringify(event));
      db.prepare("delete from event_chunks where offset = ?").run(offset);
      db.prepare(
        "insert into event_chunks (offset, chunk_index, chunk_bytes) values (?, 0, ?)",
      ).run(offset, bytes);
    },
    failKvPutsWith(error: Error | undefined, key?: string): void {
      kvPutFailure = error === undefined ? undefined : { error, key };
    },
    getKv<T>(key: string): T | undefined {
      const value = values.get(key);
      return value === undefined ? undefined : structuredClone(value as T);
    },
    setKv(key: string, value: unknown): void {
      values.set(key, structuredClone(value));
    },
    storageSyncCount(): number {
      return storageSyncCount;
    },
    async waitForInitialization(): Promise<void> {
      await latestInitialization;
    },
    async settle(): Promise<void> {
      let seen = -1;
      while (seen !== backgroundWork.length) {
        seen = backgroundWork.length;
        await Promise.allSettled([...backgroundWork]);
        await Promise.resolve();
      }
    },
  };
}

function subscriptionConfiguration(): SubscriptionConfiguredPayload {
  return {
    subscriptionKey: SUBSCRIPTION_KEY,
    filter: { eventTypes: [MATCHING_EVENT_TYPE] },
    receiver: {
      action: "cross-post",
      receivingStreamPath: RECEIVING_STREAM_PATH,
      delivery: {
        start: "beginning",
        onFailingEvent: "halt",
        includeEphemeral: false,
      },
    },
  };
}

async function receiverWithRecordedSubscription() {
  const context = durableObjectContext(streamName(RECEIVING_STREAM_PATH));
  const env = {
    STREAM: {
      getByName() {
        return {
          async appendCoreEvent(event: StreamEventInput): Promise<StreamEvent> {
            return {
              ...event,
              path: SOURCE_PATH,
              offset: 1,
              createdAt: SOURCE_STREAM_CREATED_AT,
            } as StreamEvent;
          },
        };
      },
    },
  } as unknown as Env;
  const receiver = new StreamDurableObject(context.ctx, env);
  await context.settle();

  const configuration = subscriptionConfiguration();
  const configuredEvent: StreamEvent = {
    type: "events.iterate.com/stream/subscription-configured",
    path: SOURCE_PATH,
    offset: 4,
    createdAt: SOURCE_STREAM_CREATED_AT,
    payload: configuration,
  };
  receiver.recordCrossPostListFromSource({
    type: "events.iterate.com/stream/cross-post-list-recorded",
    payload: {
      source: {
        projectId: PROJECT_ID,
        path: SOURCE_PATH,
        streamId: SOURCE_STREAM_ID,
        streamCreatedAt: SOURCE_STREAM_CREATED_AT,
      },
      sourceOffset: 5,
      subscriptionsByKey: {
        [SUBSCRIPTION_KEY]: {
          configuredAtSourceOffset: configuredEvent.offset,
          configuration: {
            filter: configuration.filter,
            ...(configuration.endWhen === undefined ? {} : { endWhen: configuration.endWhen }),
            delivery:
              configuration.receiver.action === "cross-post"
                ? configuration.receiver.delivery
                : undefined,
          },
        },
      },
    },
  });

  const batch = {
    projectId: PROJECT_ID,
    path: SOURCE_PATH,
    streamId: SOURCE_STREAM_ID,
    streamCreatedAt: SOURCE_STREAM_CREATED_AT,
    streamMaxOffset: 6,
    subscriptionKey: SUBSCRIPTION_KEY,
    cursorChangedAtSourceOffset: configuredEvent.offset,
    deliveryId: "delivery-1",
    attempt: 1,
    configuredEvent: subscriptionConfigurationForDelivery(configuredEvent),
    events: [],
  } satisfies StreamDeliveryBatch;

  return { batch, context, receiver };
}

afterEach(() => vi.restoreAllMocks());

describe("StreamDurableObject stream-ID-guarded append", () => {
  it("checks the current lifetime and commits in the same synchronous turn", async () => {
    const context = durableObjectContext(streamName("/guarded-append"));
    const env = {
      STREAM: {
        getByName() {
          return {
            async appendCoreEvent(event: StreamEventInput): Promise<StreamEvent> {
              return {
                ...event,
                path: "/",
                offset: 1,
                createdAt: "2026-07-21T12:00:00.000Z",
              } as StreamEvent;
            },
          };
        },
      },
    } as unknown as Env;
    const stream = new StreamDurableObject(context.ctx, env);
    await context.settle();

    try {
      const observed = stream.getEventPage();
      const headBefore = observed.streamMaxOffset;
      expect(() =>
        stream.appendIfStreamId({
          streamId: "22222222-2222-4222-8222-222222222222",
          events: [{ type: MATCHING_EVENT_TYPE, payload: { id: "wrong-lifetime" } }],
        }),
      ).toThrow(/stream ID changed.*append rejected/);
      expect(stream.getEventPage().streamMaxOffset).toBe(headBefore);

      const [committed] = stream.appendIfStreamId({
        streamId: observed.streamId,
        events: [{ type: MATCHING_EVENT_TYPE, payload: { id: "current-lifetime" } }],
      });
      expect(committed).toMatchObject({
        offset: headBefore + 1,
        type: MATCHING_EVENT_TYPE,
        payload: { id: "current-lifetime" },
      });
    } finally {
      context.close();
    }
  });
});

describe("StreamDurableObject circuit-breaker consequences", () => {
  it("records one pause, rejects ordinary appends, and resumes explicitly", async () => {
    const loggedError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const context = durableObjectContext(streamName("/circuit-breaker"));
    const env = {
      STREAM: {
        getByName() {
          return {
            async appendCoreEvent(event: StreamEventInput): Promise<StreamEvent> {
              return {
                ...event,
                path: SOURCE_PATH,
                offset: 1,
                createdAt: SOURCE_STREAM_CREATED_AT,
              } as StreamEvent;
            },
          };
        },
      },
    } as unknown as Env;
    const stream = new StreamDurableObject(context.ctx, env);
    await context.settle();

    try {
      stream.append({
        type: "events.iterate.com/stream/configured",
        payload: {
          config: { circuitBreaker: { burstCapacity: 1, refillRatePerMinute: 1 } },
        },
      });
      stream.append({ type: MATCHING_EVENT_TYPE, payload: { issue: 1 } });
      const [trippingEvent] = stream.append({
        type: MATCHING_EVENT_TYPE,
        payload: { issue: 2 },
      });

      expect(stream.runtimeState().coreProcessorState).toMatchObject({
        paused: true,
        pauseReason: "circuit breaker tripped: burst rate limit exceeded",
      });
      expect(stream.getEvents({ eventTypes: ["events.iterate.com/stream/paused"] })).toEqual([
        expect.objectContaining({
          offset: trippingEvent!.offset + 1,
          payload: { reason: "circuit breaker tripped: burst rate limit exceeded" },
        }),
      ]);
      expect(() => stream.append({ type: MATCHING_EVENT_TYPE, payload: { issue: 3 } })).toThrow(
        /stream paused: circuit breaker tripped/,
      );

      stream.alarm();
      await context.settle();
      expect(stream.getEvents({ eventTypes: ["events.iterate.com/stream/paused"] })).toHaveLength(
        1,
      );

      stream.append({
        type: "events.iterate.com/stream/resumed",
        payload: { reason: "operator reset" },
      });
      expect(stream.runtimeState().coreProcessorState).toMatchObject({
        paused: false,
        pauseReason: null,
      });
      expect(() =>
        stream.append({ type: MATCHING_EVENT_TYPE, payload: { issue: 4 } }),
      ).not.toThrow();
      await context.settle();
      expect(loggedError).not.toHaveBeenCalled();
    } finally {
      context.close();
    }
  });
});

describe("StreamDurableObject receiving retries", () => {
  it("keeps the newer recorded source incarnation when an older call arrives", async () => {
    const { context, receiver } = await receiverWithRecordedSubscription();

    try {
      expect(
        receiver.recordCrossPostListFromSource({
          type: "events.iterate.com/stream/cross-post-list-recorded",
          payload: {
            source: {
              projectId: PROJECT_ID,
              path: SOURCE_PATH,
              streamId: "00000000-0000-4000-8000-000000000000",
              streamCreatedAt: "2026-07-21T11:59:59.000Z",
            },
            sourceOffset: 100,
            subscriptionsByKey: {},
          },
        }),
      ).toMatchObject({
        payload: {
          source: {
            streamId: SOURCE_STREAM_ID,
            streamCreatedAt: SOURCE_STREAM_CREATED_AT,
          },
          sourceOffset: 5,
        },
      });
    } finally {
      context.close();
    }
  });

  it("stores a copied stream control event as inert data without interpreting its payload", async () => {
    const { batch, context, receiver } = await receiverWithRecordedSubscription();
    const copiedControl: StreamEvent = {
      type: "events.iterate.com/stream/configured",
      path: SOURCE_PATH,
      offset: 6,
      createdAt: "2026-07-21T12:00:01.000Z",
      payload: { retiredShape: true },
    };

    try {
      expect(receiver.receiveCrossPostedEvents({ ...batch, events: [copiedControl] })).toEqual({
        accepted: 1,
        dropped: [],
      });
      expect(receiver.getEvent({ offset: receiver.getEventPage().streamMaxOffset })).toMatchObject({
        type: copiedControl.type,
        payload: copiedControl.payload,
        source: { crossPostedFrom: [expect.objectContaining({ path: SOURCE_PATH, offset: 6 })] },
      });
      expect(receiver.runtimeState().coreProcessorState.paused).toBe(false);
    } finally {
      context.close();
    }
  });

  it("acknowledges the same cycle drop when a committed batch is retried", async () => {
    const { batch, context, receiver } = await receiverWithRecordedSubscription();
    const cycle: StreamEvent = {
      type: MATCHING_EVENT_TYPE,
      path: SOURCE_PATH,
      offset: 6,
      createdAt: "2026-07-21T12:00:01.000Z",
      payload: { issue: 42 },
      source: {
        crossPostedFrom: [
          {
            subscriptionKey: "earlier-hop",
            streamId: "22222222-2222-4222-8222-222222222222",
            streamCreatedAt: "2026-07-21T11:00:00.000Z",
            cursorChangedAtSourceOffset: 2,
            createdAt: "2026-07-21T11:00:01.000Z",
            offset: 3,
            path: RECEIVING_STREAM_PATH,
            projectId: PROJECT_ID,
            type: MATCHING_EVENT_TYPE,
          },
        ],
      },
    };
    const delivered = { ...batch, events: [cycle] };

    try {
      expect(receiver.receiveCrossPostedEvents(delivered)).toEqual({
        accepted: 0,
        dropped: [{ offset: 6, reason: "cycle" }],
      });
      expect(receiver.receiveCrossPostedEvents(delivered)).toEqual({
        accepted: 0,
        dropped: [{ offset: 6, reason: "cycle" }],
      });
      expect(
        receiver.getEvents({
          eventTypes: ["events.iterate.com/stream/cross-posted-events-dropped"],
        }),
      ).toHaveLength(1);
    } finally {
      context.close();
    }
  });
});

describe("StreamDurableObject reconciliation recovery", () => {
  it("rejects oversized retained state before inserting the configuring event", async () => {
    const context = durableObjectContext(streamName(SOURCE_PATH));
    const env = { STREAM: { getByName: vi.fn() } } as unknown as Env;
    const stream = new StreamDurableObject(context.ctx, env);
    await context.settle();

    try {
      expect(() =>
        stream.append({
          type: "events.iterate.com/stream/subscription-configured",
          payload: {
            ...subscriptionConfiguration(),
            description: "x".repeat(MAX_CORE_PROCESSOR_STATE_BYTES),
          },
        }),
      ).toThrow(/core processor state.*checkpoint safety limit/i);
      expect(
        stream.getEvents({ eventTypes: ["events.iterate.com/stream/subscription-configured"] }),
      ).toEqual([]);
    } finally {
      context.close();
    }
  });

  it("paces repeated alarm-turn repair failures instead of immediately hot-looping", async () => {
    let now = 2_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const context = durableObjectContext(streamName(SOURCE_PATH));
    const env = { STREAM: { getByName: vi.fn() } } as unknown as Env;
    const stream = new StreamDurableObject(context.ctx, env);
    await context.settle();

    try {
      stream.append({ type: MATCHING_EVENT_TYPE, payload: { issue: "checkpoint-me" } });
      context.failKvPutsWith(new Error("synthetic checkpoint outage"));

      stream.alarm();
      expect(context.alarms.at(-1)).toBe(now + 1_000);

      now = context.alarms.at(-1)!;
      stream.alarm();
      expect(context.alarms.at(-1)).toBe(now + 2_000);
    } finally {
      context.close();
    }
  });

  it("rebuilds after eviction and version skew without losing owed delivery or its cursor", async () => {
    const loggedError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sourceContext = durableObjectContext(streamName(SOURCE_PATH));
    const receiverContext = durableObjectContext(streamName(RECEIVING_STREAM_PATH));
    const streams = new Map<string, StreamDurableObject>();
    const receivedBatches: StreamDeliveryBatch[] = [];
    const streamNamespace = {
      getByName(name: string): StreamStub {
        const target = streams.get(name);
        if (target === undefined) throw new Error(`test stream ${name} does not exist`);
        return {
          async appendCoreEvent(event) {
            return target.appendCoreEvent(event);
          },
          async recordCrossPostListFromSource(event) {
            return target.recordCrossPostListFromSource(event);
          },
          async receiveCrossPostedEvents(batch) {
            receivedBatches.push(structuredClone(batch));
            return target.receiveCrossPostedEvents(batch);
          },
        };
      },
    };
    const env = { STREAM: streamNamespace } as unknown as Env;
    let source = new StreamDurableObject(sourceContext.ctx, env);
    streams.set(streamName(SOURCE_PATH), source);
    const receiver = new StreamDurableObject(receiverContext.ctx, env);
    streams.set(streamName(RECEIVING_STREAM_PATH), receiver);
    await Promise.all([sourceContext.settle(), receiverContext.settle()]);

    try {
      await expect(
        source.setCrossPostSubscription({ configuration: subscriptionConfiguration() }),
      ).resolves.toMatchObject({
        status: "configured",
      });
      const [productEvent] = source.append({
        type: MATCHING_EVENT_TYPE,
        payload: { issue: "survive-eviction" },
      });
      expect(receivedBatches).toHaveLength(0);
      expect(sourceContext.alarms).not.toHaveLength(0);

      source = new StreamDurableObject(sourceContext.ctx, env);
      streams.set(streamName(SOURCE_PATH), source);
      await sourceContext.settle();
      source.alarm();
      await Promise.all([sourceContext.settle(), receiverContext.settle()]);

      expect(receivedBatches).toHaveLength(1);
      expect(receivedBatches[0]).toMatchObject({
        subscriptionKey: SUBSCRIPTION_KEY,
        events: [{ offset: productEvent!.offset, type: MATCHING_EVENT_TYPE }],
      });
      expect(source.runtimeState().runtime.subscriptions[SUBSCRIPTION_KEY]).toMatchObject({
        acknowledgedOffset: expect.any(Number),
        acknowledgedEvents: 1,
        attempt: 0,
        lastError: null,
      });
      expect(
        receiver.runtimeState().coreProcessorState.subscriptions.inbound.bySourcePath[SOURCE_PATH]
          ?.byKey[SUBSCRIPTION_KEY],
      ).toMatchObject({ numEventsReceived: 1 });

      sourceContext.setKv("stateVersion", -1);
      source = new StreamDurableObject(sourceContext.ctx, env);
      await sourceContext.waitForInitialization();
      streams.set(streamName(SOURCE_PATH), source);
      await sourceContext.settle();

      expect(source.runtimeState().coreProcessorState.subscriptions).toMatchObject({
        outbound: {
          byKey: { [SUBSCRIPTION_KEY]: expect.any(Object) },
        },
      });
      expect(
        source.runtimeState().coreProcessorState.crossPostListDeliveriesByReceivingStream,
      ).toMatchObject({
        [RECEIVING_STREAM_PATH]: {
          status: "confirmed",
          subscriptionKeysRecordedByReceiver: [SUBSCRIPTION_KEY],
        },
      });
      expect(source.runtimeState().runtime.subscriptions[SUBSCRIPTION_KEY]).toMatchObject({
        acknowledgedOffset: expect.any(Number),
        acknowledgedEvents: 1,
        attempt: 0,
        lastError: null,
      });

      source.alarm();
      await Promise.all([sourceContext.settle(), receiverContext.settle()]);
      expect(receivedBatches).toHaveLength(1);

      sourceContext.setKv("stateVersion", CORE_STATE_VERSION);
      sourceContext.setKv("state", { eventCount: "corrupt" });
      expect(() => {
        source = new StreamDurableObject(sourceContext.ctx, env);
      }).not.toThrow();
      await sourceContext.waitForInitialization();
      streams.set(streamName(SOURCE_PATH), source);
      expect(
        source.runtimeState().coreProcessorState.subscriptions.outbound.byKey[SUBSCRIPTION_KEY],
      ).toEqual(expect.any(Object));
      expect(source.runtimeState().runtime.subscriptions[SUBSCRIPTION_KEY]).toMatchObject({
        acknowledgedEvents: 1,
        attempt: 0,
      });
      expect(loggedError).toHaveBeenCalledWith(
        "stream core-state checkpoint was invalid; rebuilt from the event log",
        expect.objectContaining({ path: SOURCE_PATH, stateVersion: CORE_STATE_VERSION }),
      );
      expect(
        source.getEvents({ eventTypes: ["events.iterate.com/stream/error-occurred"] }),
      ).toContainEqual(
        expect.objectContaining({
          payload: {
            message: expect.stringContaining("failed validation under version"),
          },
        }),
      );
    } finally {
      receiverContext.close();
      sourceContext.close();
    }
  });

  it("resumes a long version rebuild from its last durable replay checkpoint", async () => {
    const context = durableObjectContext(streamName(SOURCE_PATH));
    const env = { STREAM: { getByName: vi.fn() } } as unknown as Env;
    const stream = new StreamDurableObject(context.ctx, env);
    await context.settle();

    try {
      const eventCount = 4_200;
      stream.append(
        ...Array.from({ length: eventCount }, (_, index) => ({
          type: MATCHING_EVENT_TYPE,
          payload: { index },
        })),
      );
      const beforeRebuild = stream.runtimeState().coreProcessorState;

      context.setKv("stateVersion", -1);
      context.failKvPutsWith(new Error("synthetic interruption after replay progress"), "state");
      new StreamDurableObject(context.ctx, env);
      await expect(context.waitForInitialization()).rejects.toThrow(
        "synthetic interruption after replay progress",
      );

      const progress = context.getKv<{
        stateVersion: number;
        state: { maxOffset: number };
      }>("coreStateRebuild");
      expect(progress).toMatchObject({ stateVersion: CORE_STATE_VERSION });
      expect(progress!.state.maxOffset).toBeGreaterThan(0);
      expect(progress!.state.maxOffset).toBeLessThan(beforeRebuild.maxOffset);
      expect(context.storageSyncCount()).toBeGreaterThan(0);

      // Test-only probe: preserve stream/created so the staged checkpoint can
      // prove its stream lifetime, but remove the event bodies it already
      // folded. Resuming from the checkpoint never reads them; restarting at
      // offset zero fails loudly on the first metadata row with no body.
      context.deleteEventChunksBetween(2, progress!.state.maxOffset);
      context.failKvPutsWith(undefined);
      const recovered = new StreamDurableObject(context.ctx, env);
      await context.waitForInitialization();
      await context.settle();

      expect(recovered.runtimeState().coreProcessorState).toMatchObject({
        eventCount: beforeRebuild.eventCount + 1,
        maxOffset: beforeRebuild.maxOffset + 1,
      });
      expect(context.getKv("coreStateRebuild")).toBeUndefined();
    } finally {
      context.close();
    }
  });

  it("discards staged replay state from another reducer version without reporting corruption", async () => {
    const loggedError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const context = durableObjectContext(streamName(SOURCE_PATH));
    const env = { STREAM: { getByName: vi.fn() } } as unknown as Env;
    const stream = new StreamDurableObject(context.ctx, env);
    await context.settle();

    try {
      stream.append({ type: MATCHING_EVENT_TYPE, payload: { issue: "old-replay-stage" } });
      const beforeRebuild = stream.runtimeState().coreProcessorState;
      context.setKv("stateVersion", -1);
      context.setKv("coreStateRebuild", {
        stateVersion: CORE_STATE_VERSION - 1,
        state: { ...beforeRebuild, eventCount: 999_999 },
      });

      const recovered = new StreamDurableObject(context.ctx, env);
      await context.waitForInitialization();
      await context.settle();

      expect(recovered.runtimeState().coreProcessorState).toMatchObject({
        projectId: beforeRebuild.projectId,
        path: beforeRebuild.path,
        streamId: beforeRebuild.streamId,
        eventCount: beforeRebuild.eventCount + 1,
        maxOffset: beforeRebuild.maxOffset + 1,
      });
      expect(context.getKv("coreStateRebuild")).toBeUndefined();
      expect(loggedError).not.toHaveBeenCalledWith(
        "stream core-state checkpoint was invalid; rebuilt from the event log",
        expect.anything(),
      );
      expect(
        recovered.getEvents({ eventTypes: ["events.iterate.com/stream/error-occurred"] }),
      ).toEqual([]);
    } finally {
      context.close();
    }
  });

  it("fails replay loudly at the exact committed core event instead of deriving partial state", async () => {
    const context = durableObjectContext(streamName(SOURCE_PATH));
    const env = { STREAM: { getByName: vi.fn() } } as unknown as Env;
    const stream = new StreamDurableObject(context.ctx, env);
    await context.settle();

    try {
      const [woken] = stream.getEvents({
        eventTypes: ["events.iterate.com/stream/woken"],
      });
      expect(woken).toBeDefined();
      const storedBeforeReplay = context.getKv("state");
      context.replaceEventBody(woken!.offset, { ...woken!, payload: {} });
      context.setKv("stateVersion", -1);

      new StreamDurableObject(context.ctx, env);
      await expect(context.waitForInitialization()).rejects.toThrow(
        `failed to replay core event at path "${SOURCE_PATH}", offset ${woken!.offset}, type "events.iterate.com/stream/woken", state version ${CORE_STATE_VERSION}`,
      );

      // Initialization never promoted a partial reduction or authored a new
      // event. Recovery requires repairing/resetting the durable log.
      expect(context.getKv("state")).toEqual(storedBeforeReplay);
    } finally {
      context.close();
    }
  });

  it("rejects rebuild progress from a different stream lifetime at the same path", async () => {
    const loggedError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const context = durableObjectContext(streamName(SOURCE_PATH));
    const env = { STREAM: { getByName: vi.fn() } } as unknown as Env;
    const stream = new StreamDurableObject(context.ctx, env);
    await context.settle();

    try {
      stream.append({ type: MATCHING_EVENT_TYPE, payload: { issue: "same-path-rebuild" } });
      const authoritative = stream.runtimeState().coreProcessorState;
      context.setKv("stateVersion", -1);
      context.setKv("coreStateRebuild", {
        stateVersion: CORE_STATE_VERSION,
        state: {
          ...authoritative,
          streamId: "22222222-2222-4222-8222-222222222222",
        },
      });

      const recovered = new StreamDurableObject(context.ctx, env);
      await context.waitForInitialization();
      await context.settle();

      expect(recovered.runtimeState().coreProcessorState.streamId).toBe(authoritative.streamId);
      expect(context.getKv("coreStateRebuild")).toBeUndefined();
      expect(loggedError).toHaveBeenCalledWith(
        "stream core-state checkpoint was invalid; rebuilt from the event log",
        expect.objectContaining({ path: SOURCE_PATH, stateVersion: CORE_STATE_VERSION }),
      );
      expect(
        recovered.getEvents({ eventTypes: ["events.iterate.com/stream/error-occurred"] }),
      ).toContainEqual(
        expect.objectContaining({
          payload: {
            message: expect.stringContaining("failed validation under version"),
          },
        }),
      );
    } finally {
      context.close();
    }
  });
});

describe("StreamDurableObject cross-post list recovery", () => {
  it("requires retry identity for a keyless subscription and reuses its committed key after a failed handshake", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sourceContext = durableObjectContext(streamName(SOURCE_PATH));
    const receiverContext = durableObjectContext(streamName(RECEIVING_STREAM_PATH));
    const streams = new Map<string, StreamDurableObject>();
    const receivedBatches: StreamDeliveryBatch[] = [];
    let receiverListFailuresRemaining = 1;
    const streamNamespace = {
      getByName(name: string): StreamStub {
        const target = streams.get(name);
        if (target === undefined) throw new Error(`test stream ${name} does not exist`);
        return {
          async appendCoreEvent(event) {
            return target.appendCoreEvent(event);
          },
          async recordCrossPostListFromSource(event) {
            if (name === streamName(RECEIVING_STREAM_PATH) && receiverListFailuresRemaining > 0) {
              receiverListFailuresRemaining -= 1;
              throw new Error("synthetic first cross-post-list failure");
            }
            return target.recordCrossPostListFromSource(event);
          },
          async receiveCrossPostedEvents(batch) {
            receivedBatches.push(structuredClone(batch));
            return target.receiveCrossPostedEvents(batch);
          },
        };
      },
    };
    const env = { STREAM: streamNamespace } as unknown as Env;
    const source = new StreamDurableObject(sourceContext.ctx, env);
    streams.set(streamName(SOURCE_PATH), source);
    const receiver = new StreamDurableObject(receiverContext.ctx, env);
    streams.set(streamName(RECEIVING_STREAM_PATH), receiver);
    await Promise.all([sourceContext.settle(), receiverContext.settle()]);
    const { subscriptionKey: _omitted, ...keylessConfiguration } = subscriptionConfiguration();

    try {
      const offsetBeforeRejectedSetup = source.runtimeState().coreProcessorState.maxOffset;
      await expect(
        source.setCrossPostSubscription({ configuration: keylessConfiguration }),
      ).rejects.toThrow(
        "a keyless cross-post subscription requires idempotencyKey so setup is safe to retry",
      );
      expect(source.runtimeState().coreProcessorState.maxOffset).toBe(offsetBeforeRejectedSetup);

      const firstAttempt = source.setCrossPostSubscription({
        configuration: keylessConfiguration,
        idempotencyKey: "configure-review-feed-once",
      });
      await expect(firstAttempt).rejects.toThrow("synthetic first cross-post-list failure");
      await sourceContext.settle();
      const retryState = source.runtimeState().runtime.crossPostListRetries[RECEIVING_STREAM_PATH];
      expect(retryState).toMatchObject({ attempt: 1, sourceOffset: expect.any(Number) });
      now = retryState!.nextAttemptAt!;

      const first = await source.setCrossPostSubscription({
        configuration: keylessConfiguration,
        idempotencyKey: "configure-review-feed-once",
      });
      const retry = await source.setCrossPostSubscription({
        configuration: keylessConfiguration,
        idempotencyKey: "configure-review-feed-once",
      });
      if (first.status !== "configured" || retry.status !== "configured") {
        throw new Error("test setup unexpectedly blocked cross-post-list delivery");
      }
      expect(retry.subscriptionKey).toBe(first.subscriptionKey);
      expect(retry.subscriptionConfiguredEvent.offset).toBe(
        first.subscriptionConfiguredEvent.offset,
      );
      expect(first.subscriptionKey).toBe(
        `subscription:${first.subscriptionConfiguredEvent.offset}`,
      );

      const [crossPostedEvent] = source.append({
        type: MATCHING_EVENT_TYPE,
        payload: { issue: "generated-key-delivery" },
      });
      source.alarm();
      await Promise.all([sourceContext.settle(), receiverContext.settle()]);

      expect(receivedBatches).toHaveLength(1);
      expect(receivedBatches[0]).toMatchObject({
        subscriptionKey: first.subscriptionKey,
        configuredEvent: {
          offset: first.subscriptionConfiguredEvent.offset,
          payload: keylessConfiguration,
        },
        events: [{ offset: crossPostedEvent!.offset, type: MATCHING_EVENT_TYPE }],
      });
      expect(
        receiver.runtimeState().coreProcessorState.subscriptions.inbound.bySourcePath[SOURCE_PATH]
          ?.byKey[first.subscriptionKey],
      ).toMatchObject({ numEventsReceived: 1, lastEventReceivedAt: expect.any(String) });

      const second = await source.setCrossPostSubscription({
        configuration: keylessConfiguration,
        idempotencyKey: "configure-review-feed-twice",
      });
      const third = await source.setCrossPostSubscription({
        configuration: keylessConfiguration,
        idempotencyKey: "configure-review-feed-three-times",
      });
      if (second.status !== "configured" || third.status !== "configured") {
        throw new Error("test setup unexpectedly blocked cross-post-list delivery");
      }
      expect(
        new Set([first.subscriptionKey, second.subscriptionKey, third.subscriptionKey]).size,
      ).toBe(3);
      expect(
        Object.keys(source.runtimeState().coreProcessorState.subscriptions.outbound.byKey),
      ).toEqual([first.subscriptionKey, second.subscriptionKey, third.subscriptionKey]);

      const offsetBeforeOpen = source.runtimeState().coreProcessorState.maxOffset;
      const collidingGeneratedKey = `subscription:${offsetBeforeOpen + 2}`;
      const connection = source.openConnection({
        connectionKey: collidingGeneratedKey,
        processEventBatch: () => undefined,
      });
      try {
        expect(source.runtimeState().coreProcessorState.maxOffset).toBe(offsetBeforeOpen + 1);
        await expect(
          source.setCrossPostSubscription({
            configuration: keylessConfiguration,
            idempotencyKey: "configure-review-feed-with-colliding-generated-key",
          }),
        ).rejects.toThrow(
          `subscriptionKey "${collidingGeneratedKey}" is already used by a live session connection`,
        );
      } finally {
        connection.close();
      }
    } finally {
      receiverContext.close();
      sourceContext.close();
    }
  });

  it("does not acknowledge an identical receiver move while an older receiver still records the key", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const oldReceiverPath = "/old-reviewer";
    const newReceiverPath = "/new-reviewer";
    const sourceContext = durableObjectContext(streamName(SOURCE_PATH));
    const oldReceiverContext = durableObjectContext(streamName(oldReceiverPath));
    const newReceiverContext = durableObjectContext(streamName(newReceiverPath));
    const streams = new Map<string, StreamDurableObject>();
    let oldReceiverListCalls = 0;

    const streamNamespace = {
      getByName(name: string): StreamStub {
        const target = streams.get(name);
        if (target === undefined) throw new Error(`test stream ${name} does not exist`);
        return {
          async appendCoreEvent(event) {
            return target.appendCoreEvent(event);
          },
          async recordCrossPostListFromSource(event) {
            if (name === streamName(oldReceiverPath)) {
              oldReceiverListCalls += 1;
              if (oldReceiverListCalls > 1) {
                throw new Error("synthetic old-receiver outage");
              }
            }
            return target.recordCrossPostListFromSource(event);
          },
          async receiveCrossPostedEvents(batch) {
            return target.receiveCrossPostedEvents(batch);
          },
        };
      },
    };
    const env = { STREAM: streamNamespace } as unknown as Env;
    const source = new StreamDurableObject(sourceContext.ctx, env);
    streams.set(streamName(SOURCE_PATH), source);
    const oldReceiver = new StreamDurableObject(oldReceiverContext.ctx, env);
    streams.set(streamName(oldReceiverPath), oldReceiver);
    const newReceiver = new StreamDurableObject(newReceiverContext.ctx, env);
    streams.set(streamName(newReceiverPath), newReceiver);
    await Promise.all([
      sourceContext.settle(),
      oldReceiverContext.settle(),
      newReceiverContext.settle(),
    ]);

    const configurationFor = (path: string): SubscriptionConfiguredPayload => ({
      ...subscriptionConfiguration(),
      receiver: {
        action: "cross-post",
        receivingStreamPath: path,
        delivery: {
          start: "beginning",
          onFailingEvent: "halt",
          includeEphemeral: false,
        },
      },
    });

    try {
      await expect(
        source.setCrossPostSubscription({ configuration: configurationFor(oldReceiverPath) }),
      ).resolves.toMatchObject({
        status: "configured",
      });

      const newConfiguration = configurationFor(newReceiverPath);
      const [move] = source.append({
        type: "events.iterate.com/stream/subscription-configured",
        payload: newConfiguration,
      });
      const sourceState = source.runtimeState().coreProcessorState;
      const receivingStreamEvent = newReceiver.recordCrossPostListFromSource({
        type: "events.iterate.com/stream/cross-post-list-recorded",
        payload: {
          source: {
            projectId: PROJECT_ID,
            path: SOURCE_PATH,
            streamId: sourceState.streamId!,
            streamCreatedAt: sourceState.createdAt!,
          },
          sourceOffset: move!.offset,
          subscriptionsByKey: {
            [SUBSCRIPTION_KEY]: {
              configuredAtSourceOffset: move!.offset,
              configuration: recordedSubscriptionForCrossPost(newConfiguration),
            },
          },
        },
      });
      source.appendCoreEvent({
        type: "events.iterate.com/stream/cross-post-list-confirmed",
        idempotencyKey: internalStreamId(
          "cross-post-list-confirmed",
          newReceiverPath,
          sourceState.streamId!,
          move!.offset,
        ),
        payload: {
          receivingStreamPath: newReceiverPath,
          sourceOffset: move!.offset,
          receivingStreamEvent,
        },
      });
      await Promise.all([
        sourceContext.settle(),
        oldReceiverContext.settle(),
        newReceiverContext.settle(),
      ]);

      expect(
        source.runtimeState().coreProcessorState.crossPostListDeliveriesByReceivingStream[
          oldReceiverPath
        ],
      ).toMatchObject({
        sourceOffset: move!.offset,
        status: "pending",
        subscriptionKeysRecordedByReceiver: [SUBSCRIPTION_KEY],
      });
      expect(
        source.runtimeState().coreProcessorState.crossPostListDeliveriesByReceivingStream[
          newReceiverPath
        ],
      ).toMatchObject({
        sourceOffset: move!.offset,
        status: "confirmed",
        subscriptionKeysRecordedByReceiver: [SUBSCRIPTION_KEY],
      });

      source.appendCoreEvent({
        type: "events.iterate.com/stream/cross-post-list-delivery-blocked",
        payload: {
          receivingStreamPath: oldReceiverPath,
          sourceOffset: move!.offset,
          attempts: MAX_CROSS_POST_LIST_ATTEMPTS,
          error: "synthetic old-receiver outage",
        },
      });
      const [resend] = source.append({
        type: "events.iterate.com/stream/cross-post-list-resend-requested",
        payload: { receivingStreamPath: oldReceiverPath },
      });

      expect(
        source.runtimeState().coreProcessorState.crossPostListDeliveriesByReceivingStream[
          oldReceiverPath
        ],
      ).toMatchObject({
        sourceOffset: resend!.offset,
        status: "pending",
        subscriptionKeysRecordedByReceiver: [SUBSCRIPTION_KEY],
      });
      await expect(
        source.setCrossPostSubscription({ configuration: configurationFor(newReceiverPath) }),
      ).rejects.toThrow(
        /sending cross-post list to "\/old-reviewer" failed: synthetic old-receiver outage|backing off/,
      );
    } finally {
      newReceiverContext.close();
      oldReceiverContext.close();
      sourceContext.close();
    }
  });

  it("keeps one retry budget across eviction, blocks, resends, records the receiver ack, and resumes event delivery", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const sourceContext = durableObjectContext(streamName(SOURCE_PATH));
    const receiverContext = durableObjectContext(streamName(RECEIVING_STREAM_PATH));
    const streams = new Map<string, StreamDurableObject>();
    let receiverFailuresRemaining = MAX_CROSS_POST_LIST_ATTEMPTS;
    const receivedBatches: StreamDeliveryBatch[] = [];

    const streamNamespace = {
      getByName(name: string): StreamStub {
        const target = streams.get(name);
        if (target === undefined) throw new Error(`test stream ${name} does not exist`);
        return {
          async appendCoreEvent(event) {
            return target.appendCoreEvent(event);
          },
          async recordCrossPostListFromSource(event) {
            if (name === streamName(RECEIVING_STREAM_PATH) && receiverFailuresRemaining > 0) {
              receiverFailuresRemaining -= 1;
              throw new Error("synthetic receiving-stream outage");
            }
            return target.recordCrossPostListFromSource(event);
          },
          async receiveCrossPostedEvents(batch) {
            receivedBatches.push(structuredClone(batch));
            return target.receiveCrossPostedEvents(batch);
          },
        };
      },
    };
    const env = { STREAM: streamNamespace } as unknown as Env;
    let source = new StreamDurableObject(sourceContext.ctx, env);
    streams.set(streamName(SOURCE_PATH), source);
    const receiver = new StreamDurableObject(receiverContext.ctx, env);
    streams.set(streamName(RECEIVING_STREAM_PATH), receiver);
    await Promise.all([sourceContext.settle(), receiverContext.settle()]);

    try {
      const configuration = subscriptionConfiguration();
      let configuredAtSourceOffset: number | undefined;
      for (let attempt = 1; attempt <= MAX_CROSS_POST_LIST_ATTEMPTS; attempt += 1) {
        await expect(source.setCrossPostSubscription({ configuration })).rejects.toThrow(
          "synthetic receiving-stream outage",
        );
        const runtime = source.runtimeState();
        const retry = runtime.runtime.crossPostListRetries[RECEIVING_STREAM_PATH];
        configuredAtSourceOffset ??= retry?.sourceOffset;
        if (attempt < MAX_CROSS_POST_LIST_ATTEMPTS) {
          expect(retry).toMatchObject({ attempt, sourceOffset: configuredAtSourceOffset });
          expect(retry?.nextAttemptAt).toBe(now + computeBackoffMs(attempt, 0.5));
          expect(sourceContext.alarms.some((alarmAt) => alarmAt <= retry!.nextAttemptAt!)).toBe(
            true,
          );

          if (attempt === 5) {
            await sourceContext.settle();
            const alarmsBeforeEviction = sourceContext.alarms.length;
            source = new StreamDurableObject(sourceContext.ctx, env);
            streams.set(streamName(SOURCE_PATH), source);
            await sourceContext.settle();

            expect(
              source.runtimeState().runtime.crossPostListRetries[RECEIVING_STREAM_PATH],
            ).toMatchObject({
              attempt,
              sourceOffset: configuredAtSourceOffset,
              nextAttemptAt: retry!.nextAttemptAt,
            });
            expect(sourceContext.alarms.slice(alarmsBeforeEviction)).toContain(
              retry!.nextAttemptAt,
            );
          }

          now = retry!.nextAttemptAt!;
        } else {
          expect(retry).toBeUndefined();
        }
      }

      const blockedRuntime = source.runtimeState();
      expect(
        blockedRuntime.coreProcessorState.crossPostListDeliveriesByReceivingStream[
          RECEIVING_STREAM_PATH
        ],
      ).toMatchObject({
        sourceOffset: configuredAtSourceOffset,
        status: "blocked",
        attempts: MAX_CROSS_POST_LIST_ATTEMPTS,
        subscriptionKeysRecordedByReceiver: [],
      });
      expect(blockedRuntime.runtime.crossPostListRetries[RECEIVING_STREAM_PATH]).toBeUndefined();
      expect(
        source.getEvents({
          eventTypes: ["events.iterate.com/stream/cross-post-list-delivery-blocked"],
        }),
      ).toHaveLength(1);
      await expect(source.setCrossPostSubscription({ configuration })).resolves.toMatchObject({
        status: "blocked",
        receivingStreamPath: RECEIVING_STREAM_PATH,
        attempts: MAX_CROSS_POST_LIST_ATTEMPTS,
        message: expect.stringMatching(/blocked after .* attempts/),
      });

      receiverFailuresRemaining = 0;
      const [resend] = source.append({
        type: "events.iterate.com/stream/cross-post-list-resend-requested",
        payload: { receivingStreamPath: RECEIVING_STREAM_PATH },
      });
      expect(resend).toMatchObject({
        type: "events.iterate.com/stream/cross-post-list-resend-requested",
      });
      expect(
        source.runtimeState().coreProcessorState.crossPostListDeliveriesByReceivingStream[
          RECEIVING_STREAM_PATH
        ],
      ).toEqual({
        sourceOffset: resend!.offset,
        status: "pending",
        subscriptionKeysRecordedByReceiver: [],
      });

      source.alarm();
      await Promise.all([sourceContext.settle(), receiverContext.settle()]);
      expect(
        source.runtimeState().coreProcessorState.crossPostListDeliveriesByReceivingStream[
          RECEIVING_STREAM_PATH
        ],
      ).toEqual({
        sourceOffset: resend!.offset,
        status: "confirmed",
        subscriptionKeysRecordedByReceiver: [SUBSCRIPTION_KEY],
      });
      expect(
        receiver.runtimeState().coreProcessorState.subscriptions.inbound.bySourcePath[SOURCE_PATH]
          ?.byKey[SUBSCRIPTION_KEY],
      ).toMatchObject({ configuredAtSourceOffset, numEventsReceived: 0 });
      expect(
        source.runtimeState().runtime.crossPostListRetries[RECEIVING_STREAM_PATH],
      ).toBeUndefined();

      const [productEvent] = source.append({
        type: MATCHING_EVENT_TYPE,
        payload: { issue: 42 },
      });
      source.alarm();
      await Promise.all([sourceContext.settle(), receiverContext.settle()]);

      expect(receivedBatches).toHaveLength(1);
      expect(receivedBatches[0]).toMatchObject({
        path: SOURCE_PATH,
        subscriptionKey: SUBSCRIPTION_KEY,
        events: [{ offset: productEvent!.offset, type: MATCHING_EVENT_TYPE }],
      });
      expect(
        receiver.runtimeState().coreProcessorState.subscriptions.inbound.bySourcePath[SOURCE_PATH]
          ?.byKey[SUBSCRIPTION_KEY],
      ).toMatchObject({ numEventsReceived: 1, lastEventReceivedAt: expect.any(String) });
      expect(source.runtimeState().runtime.subscriptions[SUBSCRIPTION_KEY]).toMatchObject({
        acknowledgedOffset: productEvent!.offset,
        attempt: 0,
        lastError: null,
      });

      const oldConfigurationBatch = structuredClone(receivedBatches[0]!);
      await expect(
        source.removeCrossPostSubscription({
          subscriptionKey: SUBSCRIPTION_KEY,
          expectedReceiverPath: RECEIVING_STREAM_PATH,
        }),
      ).resolves.toMatchObject({ status: "removed" });
      expect(
        receiver.runtimeState().coreProcessorState.subscriptions.inbound.bySourcePath[SOURCE_PATH],
      ).toBeUndefined();
      expect(() => receiver.receiveCrossPostedEvents(oldConfigurationBatch)).toThrow(
        /has no current subscription/,
      );

      expect(warn).toHaveBeenCalledTimes(MAX_CROSS_POST_LIST_ATTEMPTS - 1);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(
        "sending cross-post list to receiving stream is blocked",
        expect.objectContaining({
          receivingStreamPath: RECEIVING_STREAM_PATH,
          attempt: MAX_CROSS_POST_LIST_ATTEMPTS,
        }),
      );
    } finally {
      receiverContext.close();
      sourceContext.close();
    }
  });
});

import type { StreamEvent, StreamEventInput } from "iterate/processors";
import { describe, expect, it, vi } from "vitest";
import { CoreProcessorContract, type CoreProcessorState } from "./core-processor-contract.ts";
import {
  isCrossPostListBlockedError,
  CrossPostListSender,
  type CrossPostListRetryStateStore,
} from "./cross-post-list-sender.ts";
import {
  MAX_CROSS_POST_LIST_ATTEMPTS,
  type CrossPostListRetryRow,
} from "./cross-post-list-retry-store.ts";

const PROJECT_ID = "prj_cross_post_list_sender";
const SOURCE_PATH = "/sources/issues";
const RECEIVER_PATH = "/agents/reviewer";
const SOURCE_STREAM_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_STREAM_CREATED_AT = "2026-07-22T10:00:00.000Z";
const SUBSCRIPTION_KEY = "issues";

function stateWithReceiver(
  receiver:
    | { sourceOffset: number; status: "pending"; subscriptionKeysRecordedByReceiver: string[] }
    | { sourceOffset: number; status: "confirmed"; subscriptionKeysRecordedByReceiver: string[] }
    | {
        sourceOffset: number;
        status: "blocked";
        attempts: number;
        error: string;
        blockedAt: string;
        subscriptionKeysRecordedByReceiver: string[];
      },
): CoreProcessorState {
  return CoreProcessorContract.stateSchema.parse({
    projectId: PROJECT_ID,
    path: SOURCE_PATH,
    streamId: SOURCE_STREAM_ID,
    createdAt: SOURCE_STREAM_CREATED_AT,
    maxOffset: 2,
    subscriptions: {
      outbound: {
        byKey: {
          [SUBSCRIPTION_KEY]: {
            configuration: {
              subscriptionKey: SUBSCRIPTION_KEY,
              receiver: {
                action: "cross-post",
                receivingStreamPath: RECEIVER_PATH,
                delivery: {
                  start: "beginning",
                  onFailingEvent: "halt",
                  includeEphemeral: false,
                },
              },
            },
            configuredAtOffset: 2,
            configuredAt: "2026-07-22T10:00:02.000Z",
          },
        },
      },
    },
    crossPostListDeliveriesByReceivingStream: {
      [RECEIVER_PATH]: receiver,
    },
  });
}

function receivingStreamEvent(
  sourceOffset = 2,
  source: {
    streamId: string;
    streamCreatedAt: string;
  } = {
    streamId: SOURCE_STREAM_ID,
    streamCreatedAt: SOURCE_STREAM_CREATED_AT,
  },
): StreamEvent {
  return {
    type: "events.iterate.com/stream/cross-post-list-recorded",
    path: RECEIVER_PATH,
    offset: 1,
    createdAt: "2026-07-22T10:00:03.000Z",
    payload: {
      source: {
        projectId: PROJECT_ID,
        path: SOURCE_PATH,
        ...source,
      },
      sourceOffset,
      subscriptionsByKey: {
        [SUBSCRIPTION_KEY]: {
          configuredAtSourceOffset: 2,
          configuration: {
            delivery: {
              start: "beginning",
              onFailingEvent: "halt",
              includeEphemeral: false,
            },
          },
        },
      },
    },
  };
}

function memoryRetryStore(): CrossPostListRetryStateStore {
  const rows = new Map<string, CrossPostListRetryRow>();
  return {
    get: (path) => rows.get(path),
    list: () => [...rows.values()],
    ensure: (path, sourceOffset) => {
      const existing = rows.get(path);
      if (existing !== undefined && existing.sourceOffset >= sourceOffset) return existing;
      const row = {
        receivingStreamPath: path,
        sourceOffset,
        attempt: 0,
        nextAttemptAt: null,
        lastError: null,
      };
      rows.set(path, row);
      return row;
    },
    fail: (path, args) => {
      const current = rows.get(path);
      if (current?.sourceOffset !== args.sourceOffset) return;
      rows.set(path, {
        ...current,
        attempt: args.attempt,
        nextAttemptAt: args.nextAttemptAt,
        lastError: args.error,
      });
    },
    delete: (path, sourceOffset) => {
      const current = rows.get(path);
      if (sourceOffset === undefined || current?.sourceOffset === sourceOffset) rows.delete(path);
    },
    prune: (paths) => {
      for (const path of rows.keys()) {
        if (!paths.has(path)) rows.delete(path);
      }
    },
  };
}

function unused<T>(): T {
  throw new Error("unexpected test hook call");
}

describe("CrossPostListSender", () => {
  it("blocks immediately when the receiver already records a newer source lifetime", async () => {
    let state = stateWithReceiver({
      sourceOffset: 2,
      status: "pending",
      subscriptionKeysRecordedByReceiver: [],
    });
    const retryStore = memoryRetryStore();
    const newerReceiverEvent = receivingStreamEvent(2, {
      streamId: "22222222-2222-4222-8222-222222222222",
      streamCreatedAt: "2026-07-22T10:00:01.000Z",
    });
    const recordCrossPostListOnReceivingStream = vi.fn(async () => newerReceiverEvent);
    const appended: StreamEventInput[] = [];
    const sender = new CrossPostListSender({
      projectId: PROJECT_ID,
      path: SOURCE_PATH,
      coreState: () => state,
      retryStore,
      appendCore: (event) => {
        const parsed = CoreProcessorContract.parseEventInput(event);
        if (parsed.type !== "events.iterate.com/stream/cross-post-list-delivery-blocked") {
          throw new Error(`unexpected event ${parsed.type}`);
        }
        appended.push(parsed);
        state = stateWithReceiver({
          sourceOffset: parsed.payload.sourceOffset,
          status: "blocked",
          attempts: parsed.payload.attempts,
          error: parsed.payload.error,
          blockedAt: "2026-07-22T10:00:02.000Z",
          subscriptionKeysRecordedByReceiver: [],
        });
        return {
          ...parsed,
          path: SOURCE_PATH,
          offset: 3,
          createdAt: "2026-07-22T10:00:02.000Z",
        } as StreamEvent;
      },
      getEvent: () => unused(),
      latestCrossPostListRecordedByReceiver: () => unused(),
      recordCrossPostListOnReceivingStream,
      scheduleDurable: (work) => void work(),
      armAlarm: vi.fn(),
      now: () => Date.parse("2026-07-22T10:00:00.000Z"),
      random: () => 0.5,
    });

    await expect(sender.waitUntilConfirmed(RECEIVER_PATH)).rejects.toThrow(
      /newer lifetime.*reset the receiving stream.*resend cannot succeed/i,
    );

    expect(recordCrossPostListOnReceivingStream).toHaveBeenCalledOnce();
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      type: "events.iterate.com/stream/cross-post-list-delivery-blocked",
      payload: {
        receivingStreamPath: RECEIVER_PATH,
        sourceOffset: 2,
        attempts: 1,
        error: expect.stringMatching(/newer lifetime/),
      },
    });
    expect(retryStore.get(RECEIVER_PATH)).toBeUndefined();

    await expect(sender.waitUntilConfirmed(RECEIVER_PATH)).rejects.toThrow(
      /blocked after 1 attempt.*newer lifetime.*resend cannot succeed/i,
    );
    expect(recordCrossPostListOnReceivingStream).toHaveBeenCalledOnce();
  });

  it("bounds a terminal receiver error before appending the blocked event", async () => {
    const message = `terminal ${"x".repeat(5_000)}`;
    let state = stateWithReceiver({
      sourceOffset: 2,
      status: "pending",
      subscriptionKeysRecordedByReceiver: [],
    });
    const retryStore = memoryRetryStore();
    retryStore.ensure(RECEIVER_PATH, 2);
    retryStore.fail(RECEIVER_PATH, {
      sourceOffset: 2,
      attempt: 14,
      nextAttemptAt: Date.parse("2026-07-22T10:00:00.000Z"),
      error: "previous failure",
    });
    const appended: StreamEventInput[] = [];
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sender = new CrossPostListSender({
      projectId: PROJECT_ID,
      path: SOURCE_PATH,
      coreState: () => state,
      retryStore,
      appendCore: (input) => {
        const parsed = CoreProcessorContract.parseEventInput(input);
        if (parsed.type !== "events.iterate.com/stream/cross-post-list-delivery-blocked") {
          throw new Error(`unexpected event ${parsed.type}`);
        }
        appended.push(parsed);
        state = stateWithReceiver({
          sourceOffset: parsed.payload.sourceOffset,
          status: "blocked",
          attempts: parsed.payload.attempts,
          error: parsed.payload.error,
          blockedAt: "2026-07-22T10:00:04.000Z",
          subscriptionKeysRecordedByReceiver: [],
        });
        return {
          ...parsed,
          path: SOURCE_PATH,
          offset: 3,
          createdAt: "2026-07-22T10:00:04.000Z",
        } as StreamEvent;
      },
      getEvent: () => unused(),
      latestCrossPostListRecordedByReceiver: () => unused(),
      recordCrossPostListOnReceivingStream: async () => {
        throw new Error(message);
      },
      scheduleDurable: (work) => void work(),
      armAlarm: () => undefined,
      now: () => Date.parse("2026-07-22T10:00:00.000Z"),
      random: () => 0.5,
    });

    await expect(sender.waitUntilConfirmed(RECEIVER_PATH)).rejects.toThrow();

    expect(appended).toHaveLength(1);
    expect(appended[0]?.payload?.error).toHaveLength(4_096);
    expect(retryStore.get(RECEIVER_PATH)).toBeUndefined();
  });

  it("retries the final attempt when recording the blocked event is interrupted by eviction", async () => {
    let now = Date.parse("2026-07-22T10:00:00.000Z");
    let state = stateWithReceiver({
      sourceOffset: 2,
      status: "pending",
      subscriptionKeysRecordedByReceiver: [],
    });
    const retryStore = memoryRetryStore();
    retryStore.ensure(RECEIVER_PATH, 2);
    retryStore.fail(RECEIVER_PATH, {
      sourceOffset: 2,
      attempt: MAX_CROSS_POST_LIST_ATTEMPTS - 1,
      nextAttemptAt: now,
      error: "previous failure",
    });
    const armAlarm = vi.fn();
    let interruptBlockedEvent = true;
    const recordedFailure = `sending cross-post list to "${RECEIVER_PATH}" failed: receiver unavailable`;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sender = new CrossPostListSender({
      projectId: PROJECT_ID,
      path: SOURCE_PATH,
      coreState: () => state,
      retryStore,
      appendCore: (input) => {
        if (interruptBlockedEvent) {
          throw Object.assign(new Error("synthetic eviction"), { durableObjectReset: true });
        }
        const parsed = CoreProcessorContract.parseEventInput(input);
        if (parsed.type !== "events.iterate.com/stream/cross-post-list-delivery-blocked") {
          throw new Error(`unexpected event ${parsed.type}`);
        }
        state = stateWithReceiver({
          sourceOffset: parsed.payload.sourceOffset,
          status: "blocked",
          attempts: parsed.payload.attempts,
          error: parsed.payload.error,
          blockedAt: "2026-07-22T10:00:01.000Z",
          subscriptionKeysRecordedByReceiver: [],
        });
        return {
          ...parsed,
          path: SOURCE_PATH,
          offset: 3,
          createdAt: "2026-07-22T10:00:01.000Z",
        } as StreamEvent;
      },
      getEvent: () => unused(),
      latestCrossPostListRecordedByReceiver: () => unused(),
      recordCrossPostListOnReceivingStream: async () => {
        throw new Error("receiver unavailable");
      },
      scheduleDurable: (work) => void work(),
      armAlarm,
      now: () => now,
      random: () => 0.5,
    });

    await expect(sender.waitUntilConfirmed(RECEIVER_PATH)).rejects.toThrow("receiver unavailable");
    expect(retryStore.get(RECEIVER_PATH)).toMatchObject({
      attempt: MAX_CROSS_POST_LIST_ATTEMPTS - 1,
      nextAttemptAt: now + 1_000,
      lastError: recordedFailure,
    });
    expect(state.crossPostListDeliveriesByReceivingStream[RECEIVER_PATH]).toMatchObject({
      status: "pending",
    });
    expect(armAlarm).toHaveBeenCalledWith(now + 1_000);

    interruptBlockedEvent = false;
    now += 1_000;
    await expect(sender.waitUntilConfirmed(RECEIVER_PATH)).rejects.toThrow("receiver unavailable");
    expect(state.crossPostListDeliveriesByReceivingStream[RECEIVER_PATH]).toMatchObject({
      status: "blocked",
      attempts: MAX_CROSS_POST_LIST_ATTEMPTS,
      error: recordedFailure,
    });
    expect(retryStore.get(RECEIVER_PATH)).toBeUndefined();
  });

  it("preserves the blocked error classification when state changes at the send gate", async () => {
    const pending = stateWithReceiver({
      sourceOffset: 2,
      status: "pending",
      subscriptionKeysRecordedByReceiver: [],
    });
    const blocked = stateWithReceiver({
      sourceOffset: 2,
      status: "blocked",
      attempts: 15,
      error: "receiver unavailable",
      blockedAt: "2026-07-22T10:00:04.000Z",
      subscriptionKeysRecordedByReceiver: [],
    });
    let stateReads = 0;
    const recordCrossPostListOnReceivingStream = vi.fn<() => Promise<unknown>>();
    const sender = new CrossPostListSender({
      projectId: PROJECT_ID,
      path: SOURCE_PATH,
      coreState: () => (stateReads++ === 0 ? pending : blocked),
      retryStore: memoryRetryStore(),
      appendCore: () => unused(),
      getEvent: () => unused(),
      latestCrossPostListRecordedByReceiver: () => unused(),
      recordCrossPostListOnReceivingStream,
      scheduleDurable: () => unused(),
      armAlarm: () => unused(),
      now: () => Date.parse("2026-07-22T10:00:00.000Z"),
      random: () => 0.5,
    });

    let failure: unknown;
    try {
      await sender.waitUntilConfirmed(RECEIVER_PATH);
    } catch (error) {
      failure = error;
    }

    expect(isCrossPostListBlockedError(failure)).toBe(true);
    expect(failure).toMatchObject({
      crossPostListBlocked: true,
      receivingStreamPath: RECEIVER_PATH,
      attempts: 15,
    });
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("receiver unavailable");
    expect((failure as Error).message).toMatch(/fix .* then call resendCrossPostList/i);
    expect(recordCrossPostListOnReceivingStream).not.toHaveBeenCalled();
  });

  it("tolerates append reconciliation re-entering the sender without duplicating the call", async () => {
    let state = stateWithReceiver({
      sourceOffset: 2,
      status: "pending",
      subscriptionKeysRecordedByReceiver: [],
    });
    const retryStore = memoryRetryStore();
    const receiving = receivingStreamEvent();
    const recordCrossPostListOnReceivingStream = vi.fn(async () => receiving);
    const appended: StreamEventInput[] = [];
    let sender!: CrossPostListSender;
    sender = new CrossPostListSender({
      projectId: PROJECT_ID,
      path: SOURCE_PATH,
      coreState: () => state,
      retryStore,
      appendCore: (event) => {
        appended.push(event);
        state = stateWithReceiver({
          sourceOffset: 2,
          status: "confirmed",
          subscriptionKeysRecordedByReceiver: [SUBSCRIPTION_KEY],
        });
        sender.reconcile();
        return {
          ...event,
          path: SOURCE_PATH,
          offset: 3,
          createdAt: "2026-07-22T10:00:04.000Z",
        } as StreamEvent;
      },
      getEvent: () => unused(),
      latestCrossPostListRecordedByReceiver: () => unused(),
      recordCrossPostListOnReceivingStream,
      scheduleDurable: () => unused(),
      armAlarm: vi.fn(),
      now: () => Date.parse("2026-07-22T10:00:00.000Z"),
      random: () => 0.5,
    });

    await expect(sender.waitUntilConfirmed(RECEIVER_PATH)).resolves.toEqual(receiving);

    expect(recordCrossPostListOnReceivingStream).toHaveBeenCalledOnce();
    expect(appended).toHaveLength(1);
    expect(appended[0]?.type).toBe("events.iterate.com/stream/cross-post-list-confirmed");
    expect(sender.runtimeState()).toEqual({});
  });
});

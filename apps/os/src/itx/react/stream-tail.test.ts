// Unit tests for the stream-tail multiplexer: one remote subscription per
// stream path, refcounted, with linger, retry-with-backoff, reconnect-resume,
// offset dedupe, buffer cap, and useSyncExternalStore-safe snapshots.
//
// The itx client is faked entirely: we control connection status, fire status
// listeners by hand, and record every remote subscribe() with its callback so
// tests can push event batches.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Event as StreamLegacyEvent } from "@iterate-com/shared/streams/types";
import type { ItxBrowserClient, ItxConnectionStatus } from "./connection.ts";
import { acquireStreamTailStore } from "./stream-tail.ts";

const RELEASE_LINGER_MS = 5_000;
const RETRY_INITIAL_MS = 1_000;
const RETRY_MAX_MS = 15_000;
const MAX_BUFFERED_EVENTS = 500;

function makeEvent(offset: number): StreamLegacyEvent {
  return {
    streamPath: "/itx",
    type: "test:event",
    payload: {},
    offset,
    createdAt: "2026-06-10T00:00:00.000Z",
  } as StreamLegacyEvent;
}

function makeEvents(fromOffset: number, toOffset: number): StreamLegacyEvent[] {
  return Array.from({ length: toOffset - fromOffset + 1 }, (_, i) => makeEvent(fromOffset + i));
}

type SubscribeCallback = (batch: {
  events: StreamLegacyEvent[];
  streamMaxOffset: number;
}) => unknown;

type RecordedSubscribe = {
  callback: SubscribeCallback;
  afterOffset: number | "start" | "end";
  unsubscribe: ReturnType<typeof vi.fn>;
};

function createFakeClient() {
  let status: ItxConnectionStatus = "connected";
  let failSubscribes = false;
  const statusListeners = new Set<() => void>();
  const subscribeCalls: RecordedSubscribe[] = [];

  const subscribe = vi.fn(
    async (callback: SubscribeCallback, opts: { afterOffset: number | "start" | "end" }) => {
      const call: RecordedSubscribe = {
        callback,
        afterOffset: opts.afterOffset,
        unsubscribe: vi.fn(),
      };
      subscribeCalls.push(call);
      if (failSubscribes) throw new Error("subscribe exploded");
      return { unsubscribe: call.unsubscribe };
    },
  );

  const handle = { streams: { get: vi.fn(() => ({ subscribe })) } };
  const subscribeStatus = vi.fn((listener: () => void) => {
    statusListeners.add(listener);
    return () => statusListeners.delete(listener);
  });

  return {
    client: {
      project: vi.fn(async () => handle),
      getStatus: () => status,
      subscribeStatus,
    } as unknown as ItxBrowserClient,
    subscribe,
    subscribeCalls,
    subscribeStatus,
    setSubscribeFailing(fail: boolean) {
      failSubscribes = fail;
    },
    /** Change connection status and fire status listeners, like the real client. */
    setStatus(next: ItxConnectionStatus) {
      status = next;
      for (const listener of [...statusListeners]) listener();
    },
  };
}

/** start() is async (project handle + remote subscribe); drain microtasks. */
async function flush() {
  for (let i = 0; i < 25; i++) await Promise.resolve();
}

describe("acquireStreamTailStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("two retains share exactly one remote subscription", async () => {
    const fake = createFakeClient();
    const store = acquireStreamTailStore(fake.client, "proj", "/itx");

    store.retain();
    await flush();
    store.retain();
    await flush();

    expect(fake.subscribe).toHaveBeenCalledTimes(1);
    expect(fake.subscribeCalls[0]!.afterOffset).toBe("start");
    expect(store.getSnapshot().status).toBe("live");
  });

  test("release lingers 5s before teardown; the next retain starts fresh", async () => {
    const fake = createFakeClient();
    const store = acquireStreamTailStore(fake.client, "proj", "/itx");

    const release1 = store.retain();
    const release2 = store.retain();
    await flush();
    const first = fake.subscribeCalls[0]!;
    first.callback({ events: [makeEvent(7)], streamMaxOffset: 7 });

    release1();
    release1(); // double-release is a no-op
    release2();
    await vi.advanceTimersByTimeAsync(RELEASE_LINGER_MS - 1);
    expect(first.unsubscribe).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(first.unsubscribe).toHaveBeenCalledTimes(1);
    // The entry is gone: the snapshot resets to empty.
    expect(store.getSnapshot().events).toEqual([]);

    // A later retain starts a fresh subscription from the beginning.
    store.retain();
    await flush();
    expect(fake.subscribe).toHaveBeenCalledTimes(2);
    expect(fake.subscribeCalls[1]!.afterOffset).toBe("start");
  });

  test("a retain during the linger window keeps the live subscription", async () => {
    const fake = createFakeClient();
    const store = acquireStreamTailStore(fake.client, "proj", "/itx");

    const release = store.retain();
    await flush();
    expect(fake.subscribe).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(3_000);
    store.retain();

    // Well past where the linger would have expired: no teardown, no restart.
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(fake.subscribeCalls[0]!.unsubscribe).not.toHaveBeenCalled();
    expect(fake.subscribe).toHaveBeenCalledTimes(1);
    expect(fake.subscribeStatus).toHaveBeenCalledTimes(1);
  });

  test("a failed start retries with capped exponential backoff while connected", async () => {
    const fake = createFakeClient();
    fake.setSubscribeFailing(true);
    const store = acquireStreamTailStore(fake.client, "proj", "/itx");

    store.retain();
    await flush();
    expect(fake.subscribe).toHaveBeenCalledTimes(1);
    // The client never left "connected", so only the retry timer can save us.
    expect(store.getSnapshot().status).toBe("error");
    expect(store.getSnapshot().error).toBe("subscribe exploded");

    // Delays double from 1s and cap at 15s.
    for (const delay of [RETRY_INITIAL_MS, 2_000, 4_000, 8_000, RETRY_MAX_MS, RETRY_MAX_MS]) {
      const attempts = fake.subscribe.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(fake.subscribe).toHaveBeenCalledTimes(attempts);
      await vi.advanceTimersByTimeAsync(1);
      await flush();
      expect(fake.subscribe).toHaveBeenCalledTimes(attempts + 1);
      expect(store.getSnapshot().status).toBe("error");
    }

    // A success resets the delay…
    fake.setSubscribeFailing(false);
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS);
    await flush();
    expect(store.getSnapshot().status).toBe("live");

    // …so the next failure (after a drop + reconnect) retries at 1s again.
    fake.setSubscribeFailing(true);
    fake.setStatus("reconnecting");
    fake.setStatus("connected");
    await flush();
    expect(store.getSnapshot().status).toBe("error");
    const attempts = fake.subscribe.mock.calls.length;
    await vi.advanceTimersByTimeAsync(RETRY_INITIAL_MS - 1);
    expect(fake.subscribe).toHaveBeenCalledTimes(attempts);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(fake.subscribe).toHaveBeenCalledTimes(attempts + 1);
  });

  test("rapid retain/release/retain installs exactly one status watcher", async () => {
    const fake = createFakeClient();
    const store = acquireStreamTailStore(fake.client, "proj", "/itx");

    // Before start() has resolved…
    const release1 = store.retain();
    release1();
    store.retain();
    await flush();
    expect(fake.subscribeStatus).toHaveBeenCalledTimes(1);

    // …and again after it has.
    const release2 = store.retain();
    release2();
    store.retain();
    await flush();
    expect(fake.subscribeStatus).toHaveBeenCalledTimes(1);
  });

  test("a reconnect restarts the tail from the last seen offset", async () => {
    const fake = createFakeClient();
    const store = acquireStreamTailStore(fake.client, "proj", "/itx");

    store.retain();
    await flush();
    const first = fake.subscribeCalls[0]!;
    expect(first.afterOffset).toBe("start");
    first.callback({ events: makeEvents(1, 3), streamMaxOffset: 3 });
    expect(store.getSnapshot().events.map((e) => e.offset)).toEqual([1, 2, 3]);

    fake.setStatus("reconnecting");
    fake.setStatus("connected");
    await flush();

    // The restart resumes after the last delivered offset.
    expect(fake.subscribeCalls).toHaveLength(2);
    const second = fake.subscribeCalls[1]!;
    expect(second.afterOffset).toBe(3);

    // The old server-side subscription died with the socket; the store drops
    // its disposer instead of calling unsubscribe on a dead stub.
    expect(first.unsubscribe).not.toHaveBeenCalled();

    // Deliveries to the stale-generation callback are ignored entirely.
    const before = store.getSnapshot();
    first.callback({ events: [makeEvent(99)], streamMaxOffset: 99 });
    expect(store.getSnapshot()).toBe(before);

    second.callback({ events: [makeEvent(4)], streamMaxOffset: 4 });
    expect(store.getSnapshot().events.map((e) => e.offset)).toEqual([1, 2, 3, 4]);
  });

  test("overlapping replays dedupe by offset and the buffer caps at 500", async () => {
    const fake = createFakeClient();
    const store = acquireStreamTailStore(fake.client, "proj", "/itx");

    store.retain();
    await flush();
    const { callback } = fake.subscribeCalls[0]!;

    callback({ events: makeEvents(1, 5), streamMaxOffset: 5 });
    callback({ events: makeEvents(4, 7), streamMaxOffset: 7 });
    expect(store.getSnapshot().events.map((e) => e.offset)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    callback({ events: makeEvents(8, 707), streamMaxOffset: 707 });
    const events = store.getSnapshot().events;
    expect(events).toHaveLength(MAX_BUFFERED_EVENTS);
    // The newest 500 survive.
    expect(events[0]!.offset).toBe(208);
    expect(events[events.length - 1]!.offset).toBe(707);
  });

  test("getSnapshot returns the same reference until something appends", async () => {
    const fake = createFakeClient();
    const store = acquireStreamTailStore(fake.client, "proj", "/itx");

    // Idle store: stable empty snapshot (useSyncExternalStore render guard).
    expect(store.getSnapshot()).toBe(store.getSnapshot());

    store.retain();
    await flush();
    const live = store.getSnapshot();
    expect(store.getSnapshot()).toBe(live);

    const { callback } = fake.subscribeCalls[0]!;
    callback({ events: [makeEvent(1)], streamMaxOffset: 1 });
    const after = store.getSnapshot();
    expect(after).not.toBe(live);

    // An empty batch appends nothing → identical reference…
    callback({ events: [], streamMaxOffset: 1 });
    expect(store.getSnapshot()).toBe(after);
    // …and so does a fully-duplicate batch.
    callback({ events: [makeEvent(1)], streamMaxOffset: 1 });
    expect(store.getSnapshot()).toBe(after);
  });
});

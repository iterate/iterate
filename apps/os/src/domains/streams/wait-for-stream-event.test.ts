import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamEventBatch, StreamSubscriptionHandle } from "./rpc-types.ts";
import type { StreamEvent } from "./schemas.ts";
import { type SubscribeForStreamWait, waitForStreamEvent } from "./wait-for-stream-event.ts";

function event(offset: number, type = "test/event"): StreamEvent {
  return {
    createdAt: new Date(offset).toISOString(),
    offset,
    path: "/test",
    type,
  };
}

function batch(events: StreamEvent[], scannedThroughOffset = events.at(-1)?.offset ?? 0) {
  return {
    events,
    path: "/test",
    projectId: "prj_test",
    scannedAfterOffset:
      events[0]?.offset === undefined
        ? Math.max(0, scannedThroughOffset - 1)
        : events[0].offset - 1,
    scannedThroughOffset,
    state: {} as StreamEventBatch["state"],
    streamMaxOffset: scannedThroughOffset,
  } satisfies StreamEventBatch;
}

function makeHandle(ping: () => boolean | Promise<boolean>): StreamSubscriptionHandle {
  return {
    ping,
    streamMaxOffset: 0,
    subscriptionKey: "wait",
    unsubscribe: vi.fn(),
    [Symbol.dispose]: vi.fn(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("waitForStreamEvent", () => {
  it("preserves event order across async predicates and closes after the first match", async () => {
    let processBatch: ((value: StreamEventBatch) => unknown) | undefined;
    const handle = makeHandle(() => true);
    const subscribe: SubscribeForStreamWait = async (args) => {
      processBatch = args.processEventBatch;
      return handle;
    };
    const releases: Array<() => void> = [];
    const checked: number[] = [];

    const pending = waitForStreamEvent(subscribe, {
      eventTypes: ["test/event"],
      predicate: async (candidate) => {
        checked.push(candidate.offset);
        await new Promise<void>((resolve) => releases.push(resolve));
        return candidate.offset === 2;
      },
      timeoutMs: 10_000,
    });
    await vi.waitFor(() => expect(processBatch).toBeDefined());
    processBatch!(batch([event(1), event(2), event(3)]));

    await vi.waitFor(() => expect(checked).toEqual([1]));
    releases.shift()!();
    await vi.waitFor(() => expect(checked).toEqual([1, 2]));
    releases.shift()!();

    await expect(pending).resolves.toMatchObject({ offset: 2 });
    expect(checked).toEqual([1, 2]);
    expect(handle.unsubscribe).toHaveBeenCalledOnce();
  });

  it("re-subscribes after a reset from the last delivered cursor", async () => {
    vi.useFakeTimers();
    const callbacks: Array<(value: StreamEventBatch) => unknown> = [];
    const cursors: Array<number | undefined> = [];
    const dead = makeHandle(() => Promise.reject(new Error("durable object reset")));
    const live = makeHandle(() => true);
    const subscribe: SubscribeForStreamWait = async (args) => {
      callbacks.push(args.processEventBatch);
      cursors.push(args.replayAfterOffset);
      return callbacks.length === 1 ? dead : live;
    };

    const pending = waitForStreamEvent(
      subscribe,
      { afterOffset: 4, eventTypes: ["test/event"], timeoutMs: 10_000 },
      { heartbeatMs: 100 },
    );
    await vi.waitFor(() => expect(callbacks).toHaveLength(1));
    callbacks[0]!(batch([], 5));
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(callbacks).toHaveLength(2));

    expect(cursors).toEqual([4, 5]);
    callbacks[0]!(batch([event(6)], 6));
    callbacks[1]!(batch([event(7)], 7));
    await expect(pending).resolves.toMatchObject({ offset: 7 });
    expect(dead.unsubscribe).toHaveBeenCalledOnce();
    expect(live.unsubscribe).toHaveBeenCalledOnce();
  });

  it("times out with bounded diagnostics and closes the subscription", async () => {
    vi.useFakeTimers();
    let processBatch: ((value: StreamEventBatch) => unknown) | undefined;
    const handle = makeHandle(() => true);
    const pending = waitForStreamEvent(
      async (args) => {
        processBatch = args.processEventBatch;
        return handle;
      },
      { eventTypes: ["test/event"], predicate: () => false, timeoutMs: 250 },
      { heartbeatMs: 100 },
    );
    await vi.waitFor(() => expect(processBatch).toBeDefined());
    processBatch!(batch([event(1), event(2, "test/other")]));
    const rejected = expect(pending).rejects.toThrow(
      "Timed out waiting for stream event after 250ms (saw 2 events; recent types: test/event, test/other).",
    );
    await vi.advanceTimersByTimeAsync(250);

    await rejected;
    expect(handle.unsubscribe).toHaveBeenCalledOnce();
  });
});

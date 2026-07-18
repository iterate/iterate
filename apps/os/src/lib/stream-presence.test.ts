import { expect, test, vi } from "vitest";
import { createBrowserStreamMetricsViewStore } from "./stream-presence.ts";
import type { BrowserStreamMetrics } from "~/domains/streams/client-libraries/browser/stream-browser-store.ts";

test("browser metrics render only producer-published snapshots and retain an RTT sparkline", () => {
  let current = metrics();
  const listeners = new Set<() => void>();
  const source = {
    metrics: vi.fn(() => current),
    subscribeMetrics: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  const viewStore = createBrowserStreamMetricsViewStore(source);
  const onChange = vi.fn();
  const unsubscribe = viewStore.subscribe(onChange);

  const initial = viewStore.getSnapshot();
  expect(initial).toEqual({ transportRttMs: null, subscriber: undefined, spark: [] });
  expect(viewStore.getSnapshot()).toBe(initial);

  // Defensive duplicate notifications carrying the same metrics snapshot are ignored.
  for (const listener of listeners) listener();
  expect(onChange).not.toHaveBeenCalled();
  expect(viewStore.getSnapshot()).toBe(initial);

  for (let sample = 1; sample <= 26; sample += 1) {
    current = metrics(sample);
    for (const listener of listeners) listener();
  }

  expect(onChange).toHaveBeenCalledTimes(26);
  expect(viewStore.getSnapshot().spark).toEqual(
    Array.from({ length: 24 }, (_, index) => index + 3),
  );

  const beforeSubscriberChange = viewStore.getSnapshot();
  current = {
    ...current,
    subscriber: {
      measuredSince: "2026-07-18T00:00:00.000Z",
      consumeOwnAppendMs: null,
      appendRoundTripMs: null,
      deliveryAgeMs: null,
      ingestMs: null,
      batchesIngested: 1,
      eventsIngested: 2,
      clockOffsetMs: null,
    },
  };
  for (const listener of listeners) listener();

  expect(viewStore.getSnapshot()).not.toBe(beforeSubscriberChange);
  expect(viewStore.getSnapshot().spark).toBe(beforeSubscriberChange.spark);
  unsubscribe();
  expect(listeners.size).toBe(0);
});

test("browser metrics never poll while producers are idle", () => {
  vi.useFakeTimers();
  try {
    const source = {
      metrics: vi.fn(() => metrics()),
      subscribeMetrics: vi.fn(() => () => {}),
    };
    const viewStore = createBrowserStreamMetricsViewStore(source);
    const unsubscribe = viewStore.subscribe(() => {});
    viewStore.getSnapshot();
    const readsAfterSubscription = source.metrics.mock.calls.length;

    vi.advanceTimersByTime(60_000);

    expect(source.metrics).toHaveBeenCalledTimes(readsAfterSubscription);
    unsubscribe();
  } finally {
    vi.useRealTimers();
  }
});

function metrics(sample?: number): BrowserStreamMetrics {
  return {
    transportRttMs:
      sample === undefined
        ? null
        : {
            last: sample,
            p50: sample,
            p95: sample,
            samples: sample,
            lastAt: sample,
          },
    subscriber: undefined,
  };
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamRuntimeDebugState } from "./stream-runtime-live-state.ts";
import { StreamRuntimeLiveProjection } from "./stream-runtime-live-state.ts";

function state(revision: number): StreamRuntimeDebugState {
  return {
    coreProcessorState: { maxOffset: revision },
    runtime: {
      connections: {},
      subscriptions: {},
      metrics: {
        measuredSince: new Date(0).toISOString(),
        reportedAt: new Date(revision).toISOString(),
        ingress: {
          perSecond5s: 0,
          bytesPerSecond5s: 0,
          lastMinute: { count: 0, bytes: 0, perSecond: 0 },
          series: { counts: new Array(60).fill(0), bytes: new Array(60).fill(0) },
        },
        egress: {
          perSecond5s: 0,
          bytesPerSecond5s: 0,
          lastMinute: { count: 0, bytes: 0, perSecond: 0 },
          series: { counts: new Array(60).fill(0), bytes: new Array(60).fill(0) },
        },
      },
      storageSizeBytes: revision,
    },
  };
}

describe("StreamRuntimeLiveProjection", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does no projection work while dormant and refreshes before first observation", () => {
    let revision = 0;
    const readState = vi.fn(() => state(revision));
    const projection = new StreamRuntimeLiveProjection(readState);
    expect(readState).not.toHaveBeenCalled();

    revision = 1;
    projection.invalidate();
    vi.advanceTimersByTime(1_000);
    expect(readState).not.toHaveBeenCalled();

    projection.loadAndRefreshLive();
    const snapshots: StreamRuntimeDebugState[] = [];
    projection.live.subscribe((update) => {
      if (update.type === "snapshot") snapshots.push(update.state);
    });
    expect(readState).toHaveBeenCalledOnce();
    expect(snapshots[0]?.runtime.storageSizeBytes).toBe(1);
  });

  it("coalesces observed mutations and stops reading after the observer leaves", () => {
    let revision = 0;
    const readState = vi.fn(() => state(revision));
    const projection = new StreamRuntimeLiveProjection(readState);
    const updates: unknown[] = [];
    const handle = projection.live.subscribe((update) => void updates.push(update));

    revision = 3;
    projection.invalidate();
    projection.invalidate();
    projection.invalidate();
    vi.advanceTimersByTime(99);
    expect(readState).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    vi.runOnlyPendingTimers();
    expect(readState).toHaveBeenCalledTimes(2);
    expect(updates).toHaveLength(2);

    handle.unsubscribe();
    revision = 4;
    projection.invalidate();
    vi.advanceTimersByTime(1_000);
    expect(readState).toHaveBeenCalledTimes(2);
  });
});

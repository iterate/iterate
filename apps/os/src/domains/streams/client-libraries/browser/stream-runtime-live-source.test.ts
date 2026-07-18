import { describe, expect, test, vi } from "vitest";

import type { LiveUpdate } from "../../../../itx-api.generated.ts";
import {
  createStreamRuntimeLiveSource,
  type StreamRuntimeLiveConnection,
  type StreamServerRuntimeState,
} from "./stream-runtime-live-source.ts";

type RuntimeUpdate = LiveUpdate<StreamServerRuntimeState>;

function runtimeState(maxOffset: number): StreamServerRuntimeState {
  const throughput = {
    perSecond5s: 0,
    bytesPerSecond5s: 0,
    lastMinute: { count: 0, bytes: 0, perSecond: 0 },
    series: { counts: new Array<number>(60).fill(0), bytes: new Array<number>(60).fill(0) },
  };
  return {
    coreProcessorState: { maxOffset },
    runtime: {
      connections: {},
      subscriptions: {},
      metrics: {
        measuredSince: "2026-07-18T00:00:00.000Z",
        reportedAt: "2026-07-18T00:00:00.000Z",
        ingress: throughput,
        egress: throughput,
      },
      storageSizeBytes: 0,
    },
  };
}

function controlledConnection() {
  const updates: Array<(update: RuntimeUpdate) => unknown> = [];
  const handles: Array<{
    ping: ReturnType<typeof vi.fn>;
    unsubscribe: ReturnType<typeof vi.fn>;
    [Symbol.dispose]: ReturnType<typeof vi.fn>;
  }> = [];
  const subscribe = vi.fn(async (listener: (update: RuntimeUpdate) => unknown) => {
    updates.push(listener);
    const handle = {
      ping: vi.fn(() => true),
      unsubscribe: vi.fn(),
      [Symbol.dispose]: vi.fn(),
    };
    handles.push(handle);
    return handle;
  });
  return {
    connection: { subscribe } as StreamRuntimeLiveConnection,
    subscribe,
    updates,
    handles,
  };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

async function expectReleased(handle: ReturnType<typeof controlledConnection>["handles"][number]) {
  await vi.waitFor(() => {
    expect(handle.unsubscribe).toHaveBeenCalledTimes(1);
    expect(handle[Symbol.dispose]).toHaveBeenCalledTimes(1);
  });
}

describe("createStreamRuntimeLiveSource", () => {
  test("subscribes only while observed and preserves the last value between observations", async () => {
    const remote = controlledConnection();
    const source = createStreamRuntimeLiveSource(remote.connection);
    expect(remote.subscribe).not.toHaveBeenCalled();

    const listener = vi.fn();
    const unobserve = source.subscribe(listener);
    expect(remote.subscribe).toHaveBeenCalledTimes(1);
    remote.updates[0]!({ type: "snapshot", revision: 0, state: runtimeState(3) });
    await settle();
    expect(source.getSnapshot()).toMatchObject({
      value: runtimeState(3),
      status: "live",
      refreshing: false,
    });

    unobserve();
    await expectReleased(remote.handles[0]!);
    expect(source.getSnapshot()).toMatchObject({
      value: runtimeState(3),
      status: "connecting",
      refreshing: false,
    });

    const unobserveAgain = source.subscribe(() => {});
    expect(remote.subscribe).toHaveBeenCalledTimes(2);
    expect(source.getSnapshot()).toMatchObject({
      value: runtimeState(3),
      status: "connecting",
      refreshing: true,
    });
    unobserveAgain();
    source.dispose();
    await expectReleased(remote.handles[1]!);
  });

  test("setConnection replaces the transport generation without showing stale pushes", async () => {
    const first = controlledConnection();
    const second = controlledConnection();
    const source = createStreamRuntimeLiveSource(first.connection);
    const unobserve = source.subscribe(() => {});
    first.updates[0]!({ type: "snapshot", revision: 0, state: runtimeState(4) });
    await settle();

    source.setConnection(second.connection);
    expect(source.getSnapshot()).toMatchObject({
      value: runtimeState(4),
      status: "connecting",
      refreshing: true,
    });
    expect(second.subscribe).toHaveBeenCalledTimes(1);
    await expectReleased(first.handles[0]!);

    first.updates[0]!({ type: "snapshot", revision: 1, state: runtimeState(99) });
    expect(source.getSnapshot().value).toEqual(runtimeState(4));
    second.updates[0]!({ type: "snapshot", revision: 0, state: runtimeState(5) });
    await settle();
    expect(source.getSnapshot()).toMatchObject({
      value: runtimeState(5),
      status: "live",
      refreshing: false,
    });

    source.setConnection(undefined);
    await expectReleased(second.handles[0]!);
    expect(source.getSnapshot()).toMatchObject({
      value: runtimeState(5),
      status: "connecting",
      refreshing: true,
    });
    unobserve();
    source.dispose();
  });

  test("refresh and revision gaps resubscribe for a full snapshot without clearing the value", async () => {
    const remote = controlledConnection();
    const source = createStreamRuntimeLiveSource(remote.connection);
    const unobserve = source.subscribe(() => {});
    remote.updates[0]!({ type: "snapshot", revision: 0, state: runtimeState(6) });
    await settle();

    source.refresh();
    expect(remote.subscribe).toHaveBeenCalledTimes(2);
    expect(source.getSnapshot()).toMatchObject({
      value: runtimeState(6),
      status: "connecting",
      refreshing: true,
    });
    await expectReleased(remote.handles[0]!);
    remote.updates[1]!({ type: "snapshot", revision: 0, state: runtimeState(7) });
    await settle();

    remote.updates[1]!({
      type: "patch",
      from: 8,
      to: 9,
      patch: { fields: { coreProcessorState: { set: { maxOffset: 99 } } } },
    });
    expect(remote.subscribe).toHaveBeenCalledTimes(3);
    expect(source.getSnapshot()).toMatchObject({
      value: runtimeState(7),
      status: "connecting",
      refreshing: true,
    });
    await expectReleased(remote.handles[1]!);
    remote.updates[2]!({ type: "snapshot", revision: 0, state: runtimeState(8) });
    await settle();
    expect(source.getSnapshot()).toMatchObject({
      value: runtimeState(8),
      status: "live",
      refreshing: false,
    });

    unobserve();
    source.dispose();
  });

  test("the subscription watchdog resubscribes and completely releases the dead handle", async () => {
    vi.useFakeTimers();
    try {
      const remote = controlledConnection();
      const source = createStreamRuntimeLiveSource(remote.connection);
      const unobserve = source.subscribe(() => {});
      remote.updates[0]!({ type: "snapshot", revision: 0, state: runtimeState(9) });
      await settle();
      remote.handles[0]!.ping.mockReturnValue(false);

      await vi.advanceTimersByTimeAsync(45_000);
      expect(remote.handles[0]!.ping).toHaveBeenCalledTimes(1);
      expect(remote.subscribe).toHaveBeenCalledTimes(2);
      expect(source.getSnapshot()).toMatchObject({
        value: runtimeState(9),
        status: "live",
        refreshing: true,
      });
      await settle();
      expect(remote.handles[0]!.unsubscribe).toHaveBeenCalledTimes(1);
      expect(remote.handles[0]![Symbol.dispose]).toHaveBeenCalledTimes(1);

      unobserve();
      source.dispose();
      await settle();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a late handle is released after unobserve, and dispose prevents future work", async () => {
    let resolveHandle!: (handle: {
      ping(): boolean;
      unsubscribe(): void;
      [Symbol.dispose](): void;
    }) => void;
    const pendingHandle = new Promise<Parameters<typeof resolveHandle>[0]>((resolve) => {
      resolveHandle = resolve;
    });
    const subscribe = vi.fn(() => pendingHandle);
    const source = createStreamRuntimeLiveSource({ subscribe } as StreamRuntimeLiveConnection);
    const unobserve = source.subscribe(() => {});
    unobserve();

    const handle = {
      ping: vi.fn(() => true),
      unsubscribe: vi.fn(),
      [Symbol.dispose]: vi.fn(),
    };
    resolveHandle(handle);
    await expectReleased(handle);

    source.dispose();
    source.subscribe(() => {});
    source.refresh();
    source.setConnection(controlledConnection().connection);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  test("subscription errors retain the last value and a refresh can recover", async () => {
    const good = controlledConnection();
    const source = createStreamRuntimeLiveSource(good.connection);
    const unobserve = source.subscribe(() => {});
    good.updates[0]!({ type: "snapshot", revision: 0, state: runtimeState(10) });
    await settle();

    const failure = new Error("runtime live state unavailable");
    const broken = {
      subscribe: vi.fn(() => Promise.reject(failure)),
    } as StreamRuntimeLiveConnection;
    source.setConnection(broken);
    await settle();
    expect(source.getSnapshot()).toMatchObject({
      value: runtimeState(10),
      status: "error",
      error: failure.message,
      refreshing: false,
    });

    source.setConnection(good.connection);
    expect(good.subscribe).toHaveBeenCalledTimes(2);
    good.updates[1]!({ type: "snapshot", revision: 0, state: runtimeState(11) });
    await settle();
    expect(source.getSnapshot()).toMatchObject({
      value: runtimeState(11),
      status: "live",
      refreshing: false,
    });
    expect(source.getSnapshot().error).toBeUndefined();

    unobserve();
    source.dispose();
  });

  test("bounds subscribe establishment, reports suspicion, retries, and releases a late handle", async () => {
    vi.useFakeTimers();
    try {
      let resolveLateHandle!: (handle: {
        ping(): boolean;
        unsubscribe(): void;
        [Symbol.dispose](): void;
      }) => void;
      const lateHandle = new Promise<Parameters<typeof resolveLateHandle>[0]>((resolve) => {
        resolveLateHandle = resolve;
      });
      const callbacks: Array<(update: RuntimeUpdate) => unknown> = [];
      const recoveredHandle = {
        ping: vi.fn(() => true),
        unsubscribe: vi.fn(),
        [Symbol.dispose]: vi.fn(),
      };
      const subscribe = vi
        .fn()
        .mockImplementationOnce((listener: (update: RuntimeUpdate) => unknown) => {
          callbacks.push(listener);
          return lateHandle;
        })
        .mockImplementationOnce(async (listener: (update: RuntimeUpdate) => unknown) => {
          callbacks.push(listener);
          return recoveredHandle;
        });
      const reportTransportSuspicion = vi.fn();
      const source = createStreamRuntimeLiveSource({ subscribe } as StreamRuntimeLiveConnection, {
        reportTransportSuspicion,
      });
      const unobserve = source.subscribe(() => {});

      await vi.advanceTimersByTimeAsync(15_000);
      expect(reportTransportSuspicion).toHaveBeenCalledTimes(1);
      expect(source.getSnapshot()).toMatchObject({
        status: "error",
        error: "itx subscription did not establish within 15000ms",
        refreshing: false,
      });
      expect(subscribe).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(9_999);
      expect(subscribe).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(subscribe).toHaveBeenCalledTimes(2);
      callbacks[1]!({ type: "snapshot", revision: 0, state: runtimeState(12) });
      await settle();
      expect(source.getSnapshot()).toMatchObject({
        value: runtimeState(12),
        status: "live",
        refreshing: false,
      });

      const staleHandle = {
        ping: vi.fn(() => true),
        unsubscribe: vi.fn(),
        [Symbol.dispose]: vi.fn(),
      };
      resolveLateHandle(staleHandle);
      await settle();
      await expectReleased(staleHandle);

      unobserve();
      source.dispose();
      await expectReleased(recoveredHandle);
    } finally {
      vi.useRealTimers();
    }
  });

  test("retries transport rejections but leaves application failures terminal", async () => {
    vi.useFakeTimers();
    try {
      const recovered = controlledConnection();
      const transportFailure = new Error("WebSocket connection failed.");
      const subscribe = vi
        .fn()
        .mockRejectedValueOnce(transportFailure)
        .mockImplementation(recovered.subscribe);
      const reportTransportSuspicion = vi.fn();
      const source = createStreamRuntimeLiveSource({ subscribe } as StreamRuntimeLiveConnection, {
        reportTransportSuspicion,
      });
      const unobserve = source.subscribe(() => {});
      await settle();
      expect(source.getSnapshot()).toMatchObject({
        status: "error",
        error: transportFailure.message,
      });
      expect(reportTransportSuspicion).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(subscribe).toHaveBeenCalledTimes(2);
      recovered.updates[0]!({ type: "snapshot", revision: 0, state: runtimeState(13) });
      await settle();
      expect(source.getSnapshot()).toMatchObject({ value: runtimeState(13), status: "live" });
      unobserve();
      source.dispose();

      const applicationSubscribe = vi.fn(() => Promise.reject(new Error("permission denied")));
      const applicationSource = createStreamRuntimeLiveSource(
        { subscribe: applicationSubscribe } as StreamRuntimeLiveConnection,
        { reportTransportSuspicion },
      );
      const unobserveApplication = applicationSource.subscribe(() => {});
      await settle();
      expect(applicationSource.getSnapshot()).toMatchObject({
        status: "error",
        error: "permission denied",
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(applicationSubscribe).toHaveBeenCalledTimes(1);
      expect(reportTransportSuspicion).not.toHaveBeenCalled();
      unobserveApplication();
      applicationSource.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

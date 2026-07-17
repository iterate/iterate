import { describe, expect, it, test, vi } from "vitest";
import type {
  GetProcessorRuntimeState,
  ProcessEventBatch,
  StreamEventBatch,
  StreamSubscriberPing,
} from "./rpc-types.ts";
import {
  retainProcessEventBatch,
  retainStreamProcessorEventBatch,
  retainWakeHandshakeResponse,
} from "./subscriber-sinks.ts";

const batch = {} as Parameters<ReturnType<typeof retainProcessEventBatch>>[0];

function disposableResult() {
  const deferred = Promise.withResolvers<void>();
  const dispose = vi.fn();
  return {
    deferred,
    dispose,
    result: Object.assign(deferred.promise, { [Symbol.dispose]: dispose }),
  };
}

function processorBatch(scannedThroughOffset: number, streamMaxOffset: number): StreamEventBatch {
  return {
    projectId: "prj_test",
    path: "/processor-test",
    events: [],
    scannedAfterOffset: Math.max(0, scannedThroughOffset - 1),
    scannedThroughOffset,
    streamMaxOffset,
    state: {},
  };
}

describe("retainProcessEventBatch", () => {
  it("settles and disposes a successful durable result", async () => {
    const pending = disposableResult();
    const onDeliveryError = vi.fn();
    const onSettled = vi.fn();
    const sink = retainProcessEventBatch(() => pending.result, { onDeliveryError });

    sink(batch, 123, onSettled);
    expect(sink.pendingDeliveries?.()).toBe(1);
    expect(pending.dispose).not.toHaveBeenCalled();

    pending.deferred.resolve();
    await pending.result;
    await Promise.resolve();

    expect(onDeliveryError).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledWith("ok", 123);
    expect(sink.pendingDeliveries?.()).toBe(0);
    expect(pending.dispose).toHaveBeenCalledOnce();
  });

  it("reports, settles, and disposes a rejected durable result", async () => {
    const pending = disposableResult();
    const error = new Error("receiver unavailable");
    const onDeliveryError = vi.fn();
    const onSettled = vi.fn();
    const sink = retainProcessEventBatch(() => pending.result, { onDeliveryError });

    sink(batch, 456, onSettled);
    pending.deferred.reject(error);
    await Promise.resolve();
    await Promise.resolve();

    expect(onDeliveryError).toHaveBeenCalledOnce();
    expect(onDeliveryError).toHaveBeenCalledWith(error);
    expect(onSettled).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledWith("error", 456);
    expect(sink.pendingDeliveries?.()).toBe(0);
    expect(pending.dispose).toHaveBeenCalledOnce();
  });

  it("cleans up overlapping results independently when they settle out of order", async () => {
    const first = disposableResult();
    const second = disposableResult();
    const results = [first.result, second.result];
    const onSettled = vi.fn();
    const sink = retainProcessEventBatch(() => results.shift()!, {
      onDeliveryError: vi.fn(),
    });

    sink(batch, 1, onSettled);
    sink(batch, 2, onSettled);
    expect(sink.pendingDeliveries?.()).toBe(2);

    second.deferred.resolve();
    await second.result;
    await Promise.resolve();
    expect(sink.pendingDeliveries?.()).toBe(1);
    expect(second.dispose).toHaveBeenCalledOnce();
    expect(first.dispose).not.toHaveBeenCalled();

    first.deferred.resolve();
    await first.result;
    await Promise.resolve();
    expect(sink.pendingDeliveries?.()).toBe(0);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(onSettled.mock.calls).toEqual([
      ["ok", 2],
      ["ok", 1],
    ]);
  });

  it("normalizes thenables so cleanup runs exactly once", async () => {
    const dispose = vi.fn();
    const error = new Error("late rejection");
    const result = {
      then(resolve: () => void, reject: (error: unknown) => void) {
        resolve();
        reject(error);
      },
      [Symbol.dispose]: dispose,
    };
    const onDeliveryError = vi.fn();
    const onSettled = vi.fn();
    const sink = retainProcessEventBatch(() => result, { onDeliveryError });

    sink(batch, 789, onSettled);
    expect(sink.pendingDeliveries?.()).toBe(1);
    await Promise.resolve();
    await Promise.resolve();

    expect(onDeliveryError).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledWith("ok", 789);
    expect(sink.pendingDeliveries?.()).toBe(0);
    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe("retainStreamProcessorEventBatch", () => {
  it("sends only the fields consumed by the hosted processor", () => {
    const received = vi.fn();
    const sink = retainStreamProcessorEventBatch(received);
    const fullBatch: StreamEventBatch = {
      projectId: "prj_test",
      path: "/agents/test",
      events: [],
      scannedAfterOffset: 41,
      scannedThroughOffset: 42,
      streamMaxOffset: 42,
      state: { configuredSubscribersByKey: { large: "unused" } },
    };

    sink(fullBatch);

    expect(received).toHaveBeenCalledOnce();
    expect(received).toHaveBeenCalledWith({
      events: [],
      scannedAfterOffset: 41,
      scannedThroughOffset: 42,
      streamMaxOffset: 42,
    });
  });

  it("pulls one cumulative result per eight-batch catch-up window", async () => {
    const results = Array.from({ length: 8 }, () => disposableResult());
    const received = vi.fn(() => results[received.mock.calls.length - 1]!.result);
    const onSettled = vi.fn();
    const sink = retainStreamProcessorEventBatch(received, { onDeliveryError: vi.fn() });

    for (let offset = 1; offset <= 8; offset += 1) {
      sink(processorBatch(offset, 9), offset, onSettled);
    }

    expect(sink.pendingDeliveries?.()).toBe(8);
    for (const result of results.slice(0, 7)) expect(result.dispose).toHaveBeenCalledOnce();
    expect(results[7]!.dispose).not.toHaveBeenCalled();

    results[7]!.deferred.resolve();
    await results[7]!.result;
    await Promise.resolve();

    expect(sink.pendingDeliveries?.()).toBe(0);
    expect(results[7]!.dispose).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledWith("ok", 8);
  });

  it("pulls a quiet tail before the settlement window fills", async () => {
    const results = Array.from({ length: 2 }, () => disposableResult());
    const received = vi.fn(() => results[received.mock.calls.length - 1]!.result);
    const onSettled = vi.fn();
    const sink = retainStreamProcessorEventBatch(received, { onDeliveryError: vi.fn() });

    sink(processorBatch(1, 2), 1, onSettled);
    sink(processorBatch(2, 2), 2, onSettled);

    expect(sink.pendingDeliveries?.()).toBe(2);
    expect(results[0]!.dispose).toHaveBeenCalledOnce();
    expect(results[1]!.dispose).not.toHaveBeenCalled();

    results[1]!.deferred.resolve();
    await results[1]!.result;
    await Promise.resolve();

    expect(sink.pendingDeliveries?.()).toBe(0);
    expect(onSettled).toHaveBeenCalledWith("ok", 2);
  });

  it("surfaces an unpulled intermediate failure through the cumulative fence", async () => {
    const error = new Error("intermediate ingest failed");
    let chain = Promise.resolve();
    let deliveryFailure: unknown;
    const received = vi.fn(() => {
      const call = received.mock.calls.length;
      const attempt = chain.then(() => {
        if (deliveryFailure !== undefined) throw deliveryFailure;
        if (call === 2) throw error;
      });
      chain = attempt.catch((caught: unknown) => {
        deliveryFailure ??= caught;
      });
      return Object.assign(attempt, { [Symbol.dispose]: vi.fn() });
    });
    const onDeliveryError = vi.fn();
    const onSettled = vi.fn();
    const sink = retainStreamProcessorEventBatch(received, { onDeliveryError });

    for (let offset = 1; offset <= 8; offset += 1) {
      sink(processorBatch(offset, 9), offset, onSettled);
    }
    await chain;
    await Promise.resolve();

    expect(onDeliveryError).toHaveBeenCalledOnce();
    expect(onDeliveryError).toHaveBeenCalledWith(error);
    expect(onSettled).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledWith("error", 8);
    expect(sink.pendingDeliveries?.()).toBe(0);
  });
});

function remoteCallback<Arg, Result>(implementation: (arg: Arg) => Result) {
  const rawDispose = vi.fn();
  const duplicateDispose = vi.fn();
  const duplicate = Object.assign((arg: Arg) => implementation(arg), {
    [Symbol.dispose]: duplicateDispose,
  });
  const raw = Object.assign((arg: Arg) => implementation(arg), {
    dup: vi.fn(() => duplicate),
    [Symbol.dispose]: rawDispose,
  });
  return { duplicateDispose, raw, rawDispose };
}

describe("wake-handshake RPC ownership", () => {
  test("retains every returned capability and disposes the original RPC result", async () => {
    const sink = remoteCallback<Parameters<ProcessEventBatch>[0], void>(() => {});
    const getRuntimeState = remoteCallback<void, { snapshot: { offset: number; state: object } }>(
      () => ({ snapshot: { offset: 17, state: {} } }),
    );
    const ping = remoteCallback<{ t0: number }, { t0: number; t1: number; t2: number }>(
      ({ t0 }) => ({
        t0,
        t1: t0 + 1,
        t2: t0 + 2,
      }),
    );
    const disposeResult = vi.fn(() => {
      sink.raw[Symbol.dispose]();
      getRuntimeState.raw[Symbol.dispose]();
      ping.raw[Symbol.dispose]();
    });
    const disposeAuthorityRoot = vi.fn();

    const retained = retainWakeHandshakeResponse({
      onDeliveryError: vi.fn(),
      onDisposed: disposeAuthorityRoot,
      value: {
        checkpointOffset: 17,
        sink: sink.raw as ProcessEventBatch,
        getRuntimeState: getRuntimeState.raw as GetProcessorRuntimeState,
        ping: ping.raw as StreamSubscriberPing,
        [Symbol.dispose]: disposeResult,
      },
    });

    expect(disposeResult).toHaveBeenCalledOnce();
    expect(sink.rawDispose).toHaveBeenCalledOnce();
    expect(getRuntimeState.rawDispose).toHaveBeenCalledOnce();
    expect(ping.rawDispose).toHaveBeenCalledOnce();
    expect(sink.raw.dup).toHaveBeenCalledOnce();
    expect(getRuntimeState.raw.dup).toHaveBeenCalledOnce();
    expect(ping.raw.dup).toHaveBeenCalledOnce();

    retained.sink({
      events: [],
      path: "/",
      projectId: "prj_test",
      scannedAfterOffset: 17,
      scannedThroughOffset: 17,
      state: {},
      streamMaxOffset: 17,
    });
    expect(await retained.getRuntimeState?.()).toEqual({
      snapshot: { offset: 17, state: {} },
    });
    expect(await retained.ping?.({ t0: 10 })).toEqual({ t0: 10, t1: 11, t2: 12 });

    retained.sink[Symbol.dispose]();
    expect(sink.duplicateDispose).toHaveBeenCalledOnce();
    expect(getRuntimeState.duplicateDispose).toHaveBeenCalledOnce();
    expect(ping.duplicateDispose).toHaveBeenCalledOnce();
    expect(disposeAuthorityRoot).toHaveBeenCalledOnce();
  });

  test("disposes the RPC result and authority root when the handshake is invalid", () => {
    const disposeResult = vi.fn();
    const disposeAuthorityRoot = vi.fn();

    expect(() =>
      retainWakeHandshakeResponse({
        onDeliveryError: vi.fn(),
        onDisposed: disposeAuthorityRoot,
        value: {
          checkpointOffset: -1,
          sink: () => {},
          [Symbol.dispose]: disposeResult,
        },
      }),
    ).toThrow("checkpointOffset");
    expect(disposeResult).toHaveBeenCalledOnce();
    expect(disposeAuthorityRoot).toHaveBeenCalledOnce();
  });
});

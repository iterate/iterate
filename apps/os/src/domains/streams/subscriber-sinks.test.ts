import { describe, expect, it, vi } from "vitest";
import type { StreamEventBatch } from "./rpc-types.ts";
import { retainProcessEventBatch, retainStreamProcessorEventBatch } from "./subscriber-sinks.ts";

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
      deliveryThroughOffset: 42,
      streamMaxOffset: 42,
      state: { configuredSubscribersByKey: { large: "unused" } },
    };

    sink(fullBatch);

    expect(received).toHaveBeenCalledOnce();
    expect(received).toHaveBeenCalledWith({
      events: [],
      deliveryThroughOffset: 42,
      streamMaxOffset: 42,
    });
  });
});

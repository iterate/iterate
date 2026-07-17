import { describe, expect, it, vi } from "vitest";
import {
  ProcessorRelayRpcTarget,
  StreamProcessorRpcTarget,
  StreamRpcTarget,
} from "../../rpc-targets.ts";
import type { StreamEvent } from "./schemas.ts";
import type { ProcessorReads } from "./stream-processor.ts";

describe("StreamRpcTarget", () => {
  it("re-acquires when a remote stream waiter is orphaned", async () => {
    vi.useFakeTimers();
    const firstWait = Promise.withResolvers<StreamEvent>();
    const event = {
      createdAt: new Date(0).toISOString(),
      offset: 9,
      path: "/agents/onboarding",
      type: "events.iterate.com/test/recovered",
    } satisfies StreamEvent;
    let acquisitions = 0;
    class TestStreamRpcTarget extends StreamRpcTarget {
      override get durableObjectStub() {
        acquisitions += 1;
        return {
          waitForEvent: () => (acquisitions === 1 ? firstWait.promise : Promise.resolve(event)),
        } as never;
      }
    }
    const stream = new TestStreamRpcTarget({
      auth: { assertCanAccessProject: vi.fn() } as never,
      path: "/agents/onboarding",
      projectId: "prj_test",
    });

    const waiting = stream.waitForEvent({
      afterOffset: 8,
      eventTypes: [event.type],
      timeoutMs: 30_000,
    });
    try {
      await vi.advanceTimersByTimeAsync(10_000);

      expect(acquisitions).toBe(2);
      await expect(waiting).resolves.toBe(event);
    } finally {
      firstWait.reject(new Error("late rejection from superseded stream waiter"));
      await waiting.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("keeps a late ephemeral match from a superseded waiter", async () => {
    vi.useFakeTimers();
    const firstWait = Promise.withResolvers<StreamEvent>();
    const secondWait = Promise.withResolvers<StreamEvent>();
    const event = {
      createdAt: new Date(0).toISOString(),
      ephemeral: true,
      offset: 9,
      path: "/events",
      type: "events.iterate.com/test/ephemeral",
    } satisfies StreamEvent;
    let acquisitions = 0;
    class TestStreamRpcTarget extends StreamRpcTarget {
      override get durableObjectStub() {
        acquisitions += 1;
        return {
          waitForEvent: () => (acquisitions === 1 ? firstWait.promise : secondWait.promise),
        } as never;
      }
    }
    const stream = new TestStreamRpcTarget({
      auth: { assertCanAccessProject: vi.fn() } as never,
      path: "/events",
      projectId: "prj_test",
    });

    const waiting = stream.waitForEvent({
      afterOffset: 8,
      eventTypes: [event.type],
      timeoutMs: 30_000,
    });
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(acquisitions).toBe(2);

      firstWait.resolve(event);
      await expect(waiting).resolves.toBe(event);
    } finally {
      firstWait.resolve(event);
      secondWait.reject(new Error("late rejection after the ephemeral match"));
      await waiting.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("propagates stream predicate failures without retrying", async () => {
    const predicateError = new Error("predicate failed");
    let acquisitions = 0;
    class TestStreamRpcTarget extends StreamRpcTarget {
      override get durableObjectStub() {
        acquisitions += 1;
        return { waitForEvent: () => Promise.reject(predicateError) } as never;
      }
    }
    const stream = new TestStreamRpcTarget({
      auth: { assertCanAccessProject: vi.fn() } as never,
      path: "/events",
      projectId: "prj_test",
    });

    await expect(stream.waitForEvent({ predicate: () => true, timeoutMs: 30_000 })).rejects.toBe(
      predicateError,
    );
    expect(acquisitions).toBe(1);
  });

  it("keeps one public timeout across orphaned stream waiters", async () => {
    vi.useFakeTimers();
    let acquisitions = 0;
    class TestStreamRpcTarget extends StreamRpcTarget {
      override get durableObjectStub() {
        acquisitions += 1;
        return { waitForEvent: () => new Promise<StreamEvent>(() => undefined) } as never;
      }
    }
    const stream = new TestStreamRpcTarget({
      auth: { assertCanAccessProject: vi.fn() } as never,
      path: "/events",
      projectId: "prj_test",
    });

    const waiting = stream.waitForEvent({
      eventTypes: ["events.iterate.com/test/absent"],
      timeoutMs: 30_000,
    });
    const rejected = expect(waiting).rejects.toThrow(
      "stream-wait-timeout: Timed out waiting for stream event after 30000ms",
    );
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      expect(acquisitions).toBe(3);
    } finally {
      await waiting.catch(() => undefined);
      vi.useRealTimers();
    }
  });
});

describe("StreamProcessorRpcTarget", () => {
  it("lets the runner waiter own the complete waitUntilProcessed timeout", async () => {
    const catchUpBeforeSnapshot = vi.fn(async () => undefined);
    const waitUntilEvent = vi.fn(async () => undefined);
    const reads: ProcessorReads<{ seen: number }> = {
      getRuntimeState: async () => ({ snapshot: { offset: 0, state: { seen: 0 } } }),
      snapshot: async () => ({ offset: 0, state: { seen: 0 } }),
      waitUntilEvent,
    };
    const target = new StreamProcessorRpcTarget(reads, { catchUpBeforeSnapshot });

    await target.waitUntilProcessed({ offset: 7, timeoutMs: 123 });

    expect(waitUntilEvent).toHaveBeenCalledWith({ offset: 7, timeoutMs: 123 });
    expect(catchUpBeforeSnapshot).not.toHaveBeenCalled();

    await target.snapshot();
    expect(catchUpBeforeSnapshot).toHaveBeenCalledOnce();
  });
});

describe("ProcessorRelayRpcTarget", () => {
  it("disposes the transient remote processor facade after success and failure", async () => {
    const disposals: string[] = [];
    let invocation = 0;
    const processorFacade = () => {
      invocation += 1;
      const label = `processor-${invocation}`;
      return Promise.resolve({
        [Symbol.dispose]: () => disposals.push(label),
        getRuntimeState: async () => ({ snapshot: { offset: 0, state: {} } }),
        snapshot: async () => {
          if (invocation === 2) throw new Error("snapshot failed");
          return { offset: 1, state: {} };
        },
        waitUntilProcessed: async () => undefined,
      });
    };
    const relay = new ProcessorRelayRpcTarget({
      auth: { principal: "trusted-internal" } as never,
      host: () => ({
        processor: processorFacade(),
        wakeStreamSubscriber: async () => {
          throw new Error("not used");
        },
      }),
    });

    await expect(relay.snapshot()).resolves.toEqual({ offset: 1, state: {} });
    await expect(relay.snapshot()).rejects.toThrow("snapshot failed");
    expect(disposals).toEqual(["processor-1", "processor-2"]);
  });

  it("does not turn a successful processor call into a failure when disposal throws", async () => {
    const disposeError = new Error("stale RPC stub could not be disposed");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const relay = new ProcessorRelayRpcTarget({
      auth: { principal: "trusted-internal" } as never,
      host: () => ({
        processor: Promise.resolve({
          [Symbol.dispose]: () => {
            throw disposeError;
          },
          getRuntimeState: async () => ({ snapshot: { offset: 0, state: {} } }),
          snapshot: async () => ({ offset: 1, state: { configured: true } }),
          waitUntilProcessed: async () => undefined,
        }),
        wakeStreamSubscriber: async () => {
          throw new Error("not used");
        },
      }),
    });

    try {
      await expect(relay.snapshot()).resolves.toEqual({
        offset: 1,
        state: { configured: true },
      });
      expect(warn).toHaveBeenCalledWith("processor relay transient facade dispose failed", {
        error: disposeError,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("still retries a lifecycle reset when disposing the stale facade throws", async () => {
    let acquisitions = 0;
    const disposeError = new Error("stale facade dispose failed");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const lifecycleReset = Object.assign(
      new Error("Durable Object reset because its code was updated."),
      { durableObjectReset: true },
    );
    const relay = new ProcessorRelayRpcTarget({
      auth: { principal: "trusted-internal" } as never,
      host: () => ({
        processor: Promise.resolve({}),
        wakeStreamSubscriber: async () => {
          throw new Error("not used");
        },
      }),
      processorFacade: () => {
        acquisitions += 1;
        return Promise.resolve({
          [Symbol.dispose]: () => {
            if (acquisitions === 1) throw disposeError;
          },
          getRuntimeState: async () => ({ snapshot: { offset: 0, state: {} } }),
          snapshot: async () => {
            if (acquisitions === 1) throw lifecycleReset;
            return { offset: 2, state: {} };
          },
          waitUntilProcessed: async () => undefined,
        });
      },
    });

    try {
      await expect(relay.snapshot()).resolves.toEqual({ offset: 2, state: {} });
      expect(acquisitions).toBe(2);
      expect(warn).toHaveBeenCalledWith("processor relay transient facade dispose failed", {
        error: disposeError,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("re-dials once when a deploy resets the host during facade acquisition", async () => {
    let acquisitions = 0;
    const processor = {
      [Symbol.dispose]: vi.fn(),
      getRuntimeState: async () => ({ snapshot: { offset: 0, state: {} } }),
      snapshot: async () => ({ offset: 1, state: {} }),
      waitUntilProcessed: vi.fn(
        async (_input: { offset: number; timeoutMs?: number }) => undefined,
      ),
    };
    const lifecycleReset = Object.assign(
      new Error("Durable Object reset because its code was updated."),
      { durableObjectReset: true },
    );
    const relay = new ProcessorRelayRpcTarget({
      auth: { principal: "trusted-internal" } as never,
      host: () => ({
        processor: Promise.resolve(processor),
        wakeStreamSubscriber: async () => {
          throw new Error("not used");
        },
      }),
      processorFacade: () => {
        acquisitions += 1;
        return acquisitions === 1 ? Promise.reject(lifecycleReset) : Promise.resolve(processor);
      },
    });

    await expect(
      relay.waitUntilProcessed({ offset: 3, timeoutMs: 30_000 }),
    ).resolves.toBeUndefined();
    expect(acquisitions).toBe(2);
    expect(processor.waitUntilProcessed).toHaveBeenCalledOnce();
    const retriedWait = processor.waitUntilProcessed.mock.calls[0]?.[0];
    expect(retriedWait).toMatchObject({ offset: 3 });
    expect(retriedWait?.timeoutMs).toBeGreaterThan(0);
    expect(retriedWait?.timeoutMs).toBeLessThanOrEqual(30_000);
    expect(processor[Symbol.dispose]).toHaveBeenCalledOnce();
  });

  it("does not retry processor application errors", async () => {
    let acquisitions = 0;
    const applicationError = new Error("duplicate created event");
    const relay = new ProcessorRelayRpcTarget({
      auth: { principal: "trusted-internal" } as never,
      host: () => ({
        processor: Promise.resolve({}),
        wakeStreamSubscriber: async () => {
          throw new Error("not used");
        },
      }),
      processorFacade: () => {
        acquisitions += 1;
        return Promise.reject(applicationError);
      },
    });

    await expect(relay.snapshot()).rejects.toBe(applicationError);
    expect(acquisitions).toBe(1);
  });

  it("shares one waitUntilProcessed timeout across a lifecycle retry", async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const lifecycleReset = Object.assign(
      new Error("Durable Object reset because its code was updated."),
      { durableObjectReset: true },
    );
    const waits: { offset: number; timeoutMs?: number }[] = [];
    const processor = {
      [Symbol.dispose]: vi.fn(),
      getRuntimeState: async () => ({ snapshot: { offset: 0, state: {} } }),
      snapshot: async () => ({ offset: 1, state: {} }),
      waitUntilProcessed: async (input: { offset: number; timeoutMs?: number }) => {
        waits.push(input);
        if (waits.length === 1) {
          now += 70;
          throw lifecycleReset;
        }
      },
    };
    const relay = new ProcessorRelayRpcTarget({
      auth: { principal: "trusted-internal" } as never,
      host: () => ({
        processor: Promise.resolve(processor),
        wakeStreamSubscriber: async () => {
          throw new Error("not used");
        },
      }),
    });

    try {
      await expect(
        relay.waitUntilProcessed({ offset: 3, timeoutMs: 100 }),
      ).resolves.toBeUndefined();
      expect(waits).toEqual([
        { offset: 3, timeoutMs: 100 },
        { offset: 3, timeoutMs: 30 },
      ]);
      expect(processor[Symbol.dispose]).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("re-acquires when a remote processor waiter is orphaned", async () => {
    vi.useFakeTimers();
    const firstWait = Promise.withResolvers<void>();
    const disposals: number[] = [];
    let acquisitions = 0;
    const relay = new ProcessorRelayRpcTarget({
      auth: { principal: "trusted-internal" } as never,
      host: () => ({
        processor: Promise.resolve({}),
        wakeStreamSubscriber: async () => {
          throw new Error("not used");
        },
      }),
      processorFacade: () => {
        acquisitions += 1;
        const acquisition = acquisitions;
        return Promise.resolve({
          [Symbol.dispose]: () => disposals.push(acquisition),
          getRuntimeState: async () => ({ snapshot: { offset: 0, state: {} } }),
          snapshot: async () => ({ offset: 0, state: {} }),
          waitUntilProcessed: () =>
            acquisition === 1 ? firstWait.promise : Promise.resolve(undefined),
        });
      },
    });

    const waiting = relay.waitUntilProcessed({ offset: 3, timeoutMs: 30_000 });
    try {
      await vi.advanceTimersByTimeAsync(10_000);

      expect(acquisitions).toBe(2);
      await expect(waiting).resolves.toBeUndefined();
      expect(disposals).toEqual([1, 2]);
    } finally {
      firstWait.reject(new Error("late rejection from superseded waiter"));
      await waiting.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("bounds facade acquisition and releases a facade that arrives late", async () => {
    vi.useFakeTimers();
    const disposals: number[] = [];
    let acquisitions = 0;
    const processor = (acquisition: number) => ({
      [Symbol.dispose]: () => disposals.push(acquisition),
      getRuntimeState: async () => ({ snapshot: { offset: 0, state: {} } }),
      snapshot: async () => ({ offset: 0, state: {} }),
      waitUntilProcessed: async () => undefined,
    });
    const firstAcquisition = Promise.withResolvers<ReturnType<typeof processor>>();
    const relay = new ProcessorRelayRpcTarget({
      auth: { principal: "trusted-internal" } as never,
      host: () => ({
        processor: Promise.resolve({}),
        wakeStreamSubscriber: async () => {
          throw new Error("not used");
        },
      }),
      processorFacade: () => {
        acquisitions += 1;
        return acquisitions === 1
          ? firstAcquisition.promise
          : Promise.resolve(processor(acquisitions));
      },
    });

    const waiting = relay.waitUntilProcessed({ offset: 3, timeoutMs: 30_000 });
    try {
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(waiting).resolves.toBeUndefined();
      expect(acquisitions).toBe(2);
      expect(disposals).toEqual([2]);

      firstAcquisition.resolve(processor(1));
      await vi.advanceTimersByTimeAsync(0);
      expect(disposals).toEqual([2, 1]);
    } finally {
      firstAcquisition.resolve(processor(1));
      await waiting.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("does not start a processor call when acquisition consumes the wait slice", async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const waitUntilProcessed = vi.fn(async () => undefined);
    const dispose = vi.fn();
    const processor = {
      [Symbol.dispose]: dispose,
      getRuntimeState: async () => ({ snapshot: { offset: 0, state: {} } }),
      snapshot: async () => ({ offset: 0, state: {} }),
      waitUntilProcessed,
    };
    const relay = new ProcessorRelayRpcTarget({
      auth: { principal: "trusted-internal" } as never,
      host: () => ({
        processor: Promise.resolve({}),
        wakeStreamSubscriber: async () => {
          throw new Error("not used");
        },
      }),
      processorFacade: async () => {
        now = 1_100;
        return processor;
      },
    });

    try {
      await expect(relay.waitUntilProcessed({ offset: 3, timeoutMs: 100 })).rejects.toThrow(
        "waitUntilProcessed timed out after 100ms waiting for offset 3",
      );
      expect(waitUntilProcessed).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("keeps one public timeout across orphaned wait slices", async () => {
    vi.useFakeTimers();
    const disposals: number[] = [];
    let acquisitions = 0;
    const relay = new ProcessorRelayRpcTarget({
      auth: { principal: "trusted-internal" } as never,
      host: () => ({
        processor: Promise.resolve({}),
        wakeStreamSubscriber: async () => {
          throw new Error("not used");
        },
      }),
      processorFacade: () => {
        acquisitions += 1;
        const acquisition = acquisitions;
        return Promise.resolve({
          [Symbol.dispose]: () => disposals.push(acquisition),
          getRuntimeState: async () => ({ snapshot: { offset: 0, state: {} } }),
          snapshot: async () => ({ offset: 0, state: {} }),
          waitUntilProcessed: () => new Promise<void>(() => undefined),
        });
      },
    });

    const waiting = relay.waitUntilProcessed({ offset: 3, timeoutMs: 30_000 });
    const rejected = expect(waiting).rejects.toThrow(
      "waitUntilProcessed timed out after 30000ms waiting for offset 3",
    );
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      expect(acquisitions).toBe(3);
      expect(disposals).toEqual([1, 2, 3]);
    } finally {
      await waiting.catch(() => undefined);
      vi.useRealTimers();
    }
  });
});

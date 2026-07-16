import { describe, expect, it, vi } from "vitest";
import { ProcessorRelayRpcTarget, StreamProcessorRpcTarget } from "../../rpc-targets.ts";
import type { ProcessorReads } from "./stream-processor.ts";

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
});

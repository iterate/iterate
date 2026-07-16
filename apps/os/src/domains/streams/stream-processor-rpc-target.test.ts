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

  it("re-dials once when a deploy resets the host during facade acquisition", async () => {
    let acquisitions = 0;
    const processor = {
      [Symbol.dispose]: vi.fn(),
      getRuntimeState: async () => ({ snapshot: { offset: 0, state: {} } }),
      snapshot: async () => ({ offset: 1, state: {} }),
      waitUntilProcessed: vi.fn(async () => undefined),
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
    expect(processor.waitUntilProcessed).toHaveBeenCalledWith({ offset: 3, timeoutMs: 30_000 });
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
});

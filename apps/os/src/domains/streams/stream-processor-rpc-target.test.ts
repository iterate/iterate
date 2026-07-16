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
});

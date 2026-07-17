import { describe, expect, it, vi } from "vitest";
import { ProcessorRelayRpcTarget, StreamProcessorRpcTarget } from "../../rpc-targets.ts";
import type { ProcessorReadRequest } from "./processor-rpc.ts";
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
  const auth = { principal: "trusted-internal" } as never;
  const wakeStreamSubscriber = async () => {
    throw new Error("not used");
  };

  it("uses the host's data-only processor operation with an explicit slug", async () => {
    const requests: ProcessorReadRequest[] = [];
    const relay = new ProcessorRelayRpcTarget<{ seen: number }>({
      auth,
      host: () => ({
        readStreamProcessor: async (request) => {
          requests.push(request);
          switch (request.operation) {
            case "snapshot":
              return { offset: 2, state: { seen: 1 } };
            case "getRuntimeState":
              return { snapshot: { offset: 2, state: { seen: 1 } } };
            case "waitUntilProcessed":
              return undefined;
          }
        },
        wakeStreamSubscriber,
      }),
      processorSlug: "project",
    });

    await expect(relay.snapshot()).resolves.toEqual({ offset: 2, state: { seen: 1 } });
    await expect(relay.getRuntimeState()).resolves.toEqual({
      snapshot: { offset: 2, state: { seen: 1 } },
    });
    await expect(relay.waitUntilProcessed({ offset: 3, timeoutMs: 100 })).resolves.toBeUndefined();
    expect(requests).toEqual([
      { operation: "snapshot", processorSlug: "project" },
      { operation: "getRuntimeState", processorSlug: "project" },
      {
        input: { offset: 3, timeoutMs: expect.any(Number) },
        operation: "waitUntilProcessed",
        processorSlug: "project",
      },
    ]);
  });

  it("re-dials once when a deploy resets the host during a data-only call", async () => {
    let calls = 0;
    const lifecycleReset = Object.assign(
      new Error("Durable Object reset because its code was updated."),
      { durableObjectReset: true },
    );
    const relay = new ProcessorRelayRpcTarget({
      auth,
      host: () => ({
        readStreamProcessor: async () => {
          calls += 1;
          if (calls === 1) throw lifecycleReset;
          return { offset: 2, state: {} };
        },
        wakeStreamSubscriber,
      }),
      processorSlug: "project",
    });

    await expect(relay.snapshot()).resolves.toEqual({ offset: 2, state: {} });
    expect(calls).toBe(2);
  });

  it("does not retry processor application errors", async () => {
    let calls = 0;
    const applicationError = new Error("duplicate created event");
    const relay = new ProcessorRelayRpcTarget({
      auth,
      host: () => ({
        readStreamProcessor: async () => {
          calls += 1;
          throw applicationError;
        },
        wakeStreamSubscriber,
      }),
      processorSlug: "project",
    });

    await expect(relay.snapshot()).rejects.toBe(applicationError);
    expect(calls).toBe(1);
  });

  it("shares one waitUntilProcessed timeout across a lifecycle retry", async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const lifecycleReset = Object.assign(
      new Error("Durable Object reset because its code was updated."),
      { durableObjectReset: true },
    );
    const waits: { offset: number; timeoutMs?: number }[] = [];
    const relay = new ProcessorRelayRpcTarget({
      auth,
      host: () => ({
        readStreamProcessor: async (request) => {
          if (request.operation !== "waitUntilProcessed") {
            throw new Error("unexpected operation");
          }
          waits.push(request.input);
          if (waits.length === 1) {
            now += 70;
            throw lifecycleReset;
          }
        },
        wakeStreamSubscriber,
      }),
      processorSlug: "project",
    });

    try {
      await expect(
        relay.waitUntilProcessed({ offset: 3, timeoutMs: 100 }),
      ).resolves.toBeUndefined();
      expect(waits).toEqual([
        { offset: 3, timeoutMs: 100 },
        { offset: 3, timeoutMs: 30 },
      ]);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

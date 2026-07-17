import { describe, expect, it, vi } from "vitest";
import type { ProcessorReadRequest } from "./processor-rpc.ts";
import type { StreamEvent } from "iterate/processors";
import type { ProcessorReads } from "iterate/processors";
import {
  ProcessorRelayRpcTarget,
  StreamProcessorRpcTarget,
  StreamRpcTarget,
} from "../../rpc-targets.ts";

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

  it("resolves an asynchronous data-only host for reads and wake delivery", async () => {
    const requests: ProcessorReadRequest[] = [];
    const wake = vi.fn(async () => ({ accepted: true as const })) as never;
    const relay = new ProcessorRelayRpcTarget<{ running: boolean }>({
      auth,
      host: async () => ({
        readStreamProcessor: async (request) => {
          requests.push(request);
          return { offset: 4, state: { running: true } };
        },
        wakeStreamSubscriber: wake,
      }),
      processorSlug: "sandbox",
    });

    await expect(relay.snapshot()).resolves.toEqual({ offset: 4, state: { running: true } });
    const request = { processorSlug: "sandbox", subscriptionKey: "sandbox-test" } as never;
    await expect(relay.wakeStreamSubscriber(request)).resolves.toEqual({ accepted: true });
    expect(requests).toEqual([{ operation: "snapshot", processorSlug: "sandbox" }]);
    expect(wake).toHaveBeenCalledWith(request);
  });

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

  it("re-dials once when a deploy resets asynchronous host acquisition", async () => {
    let acquisitions = 0;
    const reads = vi.fn(async () => ({ offset: 2, state: {} }));
    const lifecycleReset = Object.assign(
      new Error("Durable Object reset because its code was updated."),
      { durableObjectReset: true },
    );
    const host = {
      readStreamProcessor: reads,
      wakeStreamSubscriber,
    };
    const relay = new ProcessorRelayRpcTarget({
      auth,
      host: () => {
        acquisitions += 1;
        return acquisitions === 1 ? Promise.reject(lifecycleReset) : Promise.resolve(host);
      },
      processorSlug: "sandbox",
    });

    await expect(relay.snapshot()).resolves.toEqual({ offset: 2, state: {} });
    expect(acquisitions).toBe(2);
    expect(reads).toHaveBeenCalledOnce();
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

  it("does not start a data call when asynchronous host acquisition consumes the deadline", async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const readStreamProcessor = vi.fn(async () => undefined);
    const relay = new ProcessorRelayRpcTarget({
      auth,
      host: async () => {
        now = 1_100;
        return { readStreamProcessor, wakeStreamSubscriber };
      },
      processorSlug: "sandbox",
    });

    try {
      await expect(relay.waitUntilProcessed({ offset: 3, timeoutMs: 100 })).rejects.toThrow(
        "waitUntilProcessed timed out after 100ms waiting for offset 3",
      );
      expect(readStreamProcessor).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("re-acquires when a data-only processor wait is orphaned", async () => {
    vi.useFakeTimers();
    const firstWait = Promise.withResolvers<void>();
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    let waits = 0;
    const relay = new ProcessorRelayRpcTarget({
      auth,
      host: () => ({
        readStreamProcessor: async (request) => {
          if (request.operation !== "waitUntilProcessed") {
            throw new Error("unexpected operation");
          }
          waits += 1;
          return waits === 1 ? firstWait.promise : undefined;
        },
        wakeStreamSubscriber,
      }),
      processorSlug: "project",
    });

    const waiting = relay.waitUntilProcessed({ offset: 3, timeoutMs: 30_000 });
    try {
      await vi.advanceTimersByTimeAsync(10_000);

      expect(waits).toBe(2);
      await expect(waiting).resolves.toBeUndefined();
      expect(consoleInfo).toHaveBeenCalledWith(
        "processor relay re-acquiring after bounded wait slice",
        { offset: 3, remainingMs: 20_000 },
      );
    } finally {
      firstWait.reject(new Error("late rejection from superseded processor wait"));
      await waiting.catch(() => undefined);
      consoleInfo.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps one public timeout across orphaned data-only processor waits", async () => {
    vi.useFakeTimers();
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const remoteTimeouts: number[] = [];
    const relay = new ProcessorRelayRpcTarget({
      auth,
      host: () => ({
        readStreamProcessor: (request) => {
          if (request.operation !== "waitUntilProcessed") {
            throw new Error("unexpected operation");
          }
          remoteTimeouts.push(request.input.timeoutMs!);
          return new Promise<void>(() => undefined);
        },
        wakeStreamSubscriber,
      }),
      processorSlug: "project",
    });

    const waiting = relay.waitUntilProcessed({ offset: 3, timeoutMs: 30_000 });
    const rejected = expect(waiting).rejects.toThrow(
      "waitUntilProcessed timed out after 30000ms waiting for offset 3",
    );
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      expect(remoteTimeouts).toEqual([30_000, 20_000, 10_000]);
      expect(consoleInfo).toHaveBeenCalledTimes(2);
    } finally {
      await waiting.catch(() => undefined);
      consoleInfo.mockRestore();
      vi.useRealTimers();
    }
  });
});

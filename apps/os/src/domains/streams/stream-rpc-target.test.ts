import type { StreamEvent } from "iterate/processors";
import { describe, expect, it, vi } from "vitest";
import { StreamRpcTarget } from "../../rpc-targets.ts";

describe("StreamRpcTarget native RPC result ownership", () => {
  it("detaches every plain-data result and releases its native invocation", async () => {
    const event = {
      createdAt: new Date(0).toISOString(),
      offset: 9,
      path: "/events",
      payload: { message: "still readable" },
      type: "events.iterate.com/test/plain-rpc-result",
    } satisfies StreamEvent;
    const appended = [{ ...event }];
    const read = { ...event };
    const page = [{ ...event }];
    const waitLease = { events: [{ ...event }], scannedThroughOffset: event.offset };
    const processorState = { snapshot: { offset: 9, state: { seen: true } } };
    const runtimeState = {
      coreProcessorState: {},
      runtime: {
        connections: {},
        metrics: {},
        storageSizeBytes: 123,
        subscriptions: {},
      },
    };
    const disposals = {
      append: vi.fn(),
      page: vi.fn(),
      processorState: vi.fn(),
      read: vi.fn(),
      runtimeState: vi.fn(),
      waitLease: vi.fn(),
    };
    Object.defineProperty(appended, Symbol.dispose, { value: disposals.append });
    Object.defineProperty(read, Symbol.dispose, { enumerable: true, value: disposals.read });
    Object.defineProperty(page, Symbol.dispose, { value: disposals.page });
    Object.defineProperty(waitLease, Symbol.dispose, { value: disposals.waitLease });
    Object.defineProperty(processorState, Symbol.dispose, { value: disposals.processorState });
    Object.defineProperty(runtimeState, Symbol.dispose, { value: disposals.runtimeState });

    class TestStreamRpcTarget extends StreamRpcTarget {
      override get durableObjectStub() {
        return {
          append: async () => appended,
          getEvent: async () => read,
          getEvents: async () => page,
          getProcessorRuntimeState: async () => processorState,
          getWaitForEventStartOffset: () => 8,
          runtimeState: async () => runtimeState,
          waitForEventLease: async () => waitLease,
        } as never;
      }
    }
    const stream = new TestStreamRpcTarget({
      auth: { assertCanAccessProject: vi.fn() } as never,
      path: "/events",
      projectId: "prj_test",
    });

    const appendedResult = await stream.append(event);
    const readResult = await stream.getEvent({ offset: event.offset });
    const pageResult = await stream.getEvents();
    const waitedResult = await stream.waitForEvent({
      afterOffset: 8,
      eventTypes: [event.type],
      timeoutMs: 1_000,
    });
    const processorStateResult = await stream.getProcessorRuntimeState({
      subscriptionKey: "project-worker",
    });
    const runtimeStateResult = await stream.runtimeState();

    expect(appendedResult).toEqual([event]);
    expect(appendedResult).not.toBe(appended);
    expect(readResult).toEqual(event);
    expect(readResult).not.toBe(read);
    expect(Reflect.has(readResult ?? {}, Symbol.dispose)).toBe(false);
    expect(pageResult).toEqual([event]);
    expect(pageResult).not.toBe(page);
    expect(waitedResult).toEqual(event);
    expect(processorStateResult).toEqual(processorState);
    expect(processorStateResult).not.toBe(processorState);
    expect(runtimeStateResult).toEqual(runtimeState);
    expect(runtimeStateResult).not.toBe(runtimeState);
    for (const dispose of Object.values(disposals)) expect(dispose).toHaveBeenCalledOnce();
  });

  it("preserves a successful result when native invocation disposal throws", async () => {
    const disposalError = new Error("native invocation disposal failed");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = [
      {
        createdAt: new Date(0).toISOString(),
        offset: 1,
        path: "/events",
        type: "events.iterate.com/test/read",
      } satisfies StreamEvent,
    ];
    Object.defineProperty(result, Symbol.dispose, {
      value: () => {
        throw disposalError;
      },
    });

    class TestStreamRpcTarget extends StreamRpcTarget {
      override get durableObjectStub() {
        return { getEvents: async () => result } as never;
      }
    }
    const stream = new TestStreamRpcTarget({
      auth: { assertCanAccessProject: vi.fn() } as never,
      path: "/events",
      projectId: "prj_test",
    });

    try {
      await expect(stream.getEvents()).resolves.toEqual(result);
      expect(warn).toHaveBeenCalledWith("stream plain-data RPC result dispose failed", {
        error: disposalError,
      });
    } finally {
      warn.mockRestore();
    }
  });
});

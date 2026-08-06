import { describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "iterate/processors";
import type { ProcessorReads } from "iterate/processors";
import {
  ProcessorRelayRpcTarget,
  STREAM_DURABLE_OBJECT_APPEND,
  STREAM_DURABLE_OBJECT_STUB,
  StreamProcessorRpcTarget,
  StreamRpcTarget,
} from "../../rpc-targets.ts";
import { streamDeliveryAuthContext } from "../../auth.ts";

describe("StreamRpcTarget", () => {
  it("appends project birth facts through the exact rollout-proven root Stream stub", async () => {
    const event = {
      createdAt: new Date(0).toISOString(),
      offset: 1,
      path: "/",
      payload: {},
      type: "events.iterate.com/test/project-birth",
    } satisfies StreamEvent;
    const provenAppend = vi.fn(async () => [event]);
    const unprovenAppend = vi.fn(async () => {
      throw new Error("must not reacquire after the version proof");
    });

    class TestStreamRpcTarget extends StreamRpcTarget {
      override get [STREAM_DURABLE_OBJECT_STUB]() {
        return { append: unprovenAppend } as never;
      }
    }
    const stream = new TestStreamRpcTarget({
      auth: { assertCanAccessProject: vi.fn() } as never,
      path: "/",
      projectId: "prj_test",
    });

    await expect(
      stream[STREAM_DURABLE_OBJECT_APPEND]({ append: provenAppend }, event),
    ).resolves.toEqual([event]);
    expect(provenAppend).toHaveBeenCalledExactlyOnceWith(event);
    expect(unprovenAppend).not.toHaveBeenCalled();
  });

  it("serves liveState from the socket-fed relay engine, never the DO's liveState property", async () => {
    const runtimeState = {
      coreProcessorState: { maxOffset: 4 },
      runtime: {
        connections: {},
        dormantSubscribers: {},
        subscriptions: {},
        metrics: {
          measuredSince: new Date(0).toISOString(),
          reportedAt: new Date(0).toISOString(),
          ingress: {},
          egress: {},
        },
        storageSizeBytes: 42,
      },
    };
    // The DO's liveState property must never be traversed: subscribing there
    // retains a diff callback inside the DO and pins it — the exact cost the
    // state-socket lane removes.
    const doLiveState = vi.fn();
    const runtimeStateRead = vi.fn(async () => runtimeState);

    class TestStreamRpcTarget extends StreamRpcTarget {
      override get [STREAM_DURABLE_OBJECT_STUB]() {
        return {
          get liveState() {
            doLiveState();
            return Promise.resolve({});
          },
          runtimeState: runtimeStateRead,
          // No webSocket on the response: the relay degrades to
          // snapshot-per-read, which is all this unit needs.
          fetch: async () => new Response(null, { status: 400 }),
        } as never;
      }
    }
    const stream = new TestStreamRpcTarget({
      auth: { assertCanAccessProject: vi.fn() } as never,
      path: "/events",
      projectId: "prj_test",
    });

    const live = stream.liveState;
    await expect(live.get()).resolves.toEqual(runtimeState);

    const updates: unknown[] = [];
    const handle = await live.subscribe((update) => void updates.push(update));
    expect(updates).toEqual([
      { type: "snapshot", revision: expect.any(Number), state: runtimeState },
    ]);
    // This fixture serves the DEGRADED path (the upgrade above returns no
    // socket), so the subscription is frozen at its first paint and must
    // report unhealthy — that is what makes the owner's watchdog re-subscribe
    // and try for a socket again.
    expect(handle.ping()).toBe(false);
    handle.unsubscribe();

    // One transient snapshot read per get/subscribe; zero DO-side liveState.
    expect(runtimeStateRead).toHaveBeenCalledTimes(2);
    expect(doLiveState).not.toHaveBeenCalled();
  });

  it("detaches every plain-data result and releases its native RPC invocation", async () => {
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
    const waited = { ...event };
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
    const appendDispose = vi.fn();
    const readDispose = vi.fn();
    const pageDispose = vi.fn();
    const waitDispose = vi.fn();
    const processorStateDispose = vi.fn();
    const runtimeStateDispose = vi.fn();
    const runtimeStateStubDispose = vi.fn();
    Object.defineProperty(appended, Symbol.dispose, { value: appendDispose });
    Object.defineProperty(read, Symbol.dispose, { enumerable: true, value: readDispose });
    Object.defineProperty(page, Symbol.dispose, { value: pageDispose });
    Object.defineProperty(waited, Symbol.dispose, { value: waitDispose });
    Object.defineProperty(processorState, Symbol.dispose, { value: processorStateDispose });
    Object.defineProperty(runtimeState, Symbol.dispose, { value: runtimeStateDispose });

    class TestStreamRpcTarget extends StreamRpcTarget {
      override get [STREAM_DURABLE_OBJECT_STUB]() {
        const stub = {
          append: async () => appended,
          getEvent: async () => read,
          getEvents: async () => page,
          getProcessorRuntimeState: async () => processorState,
          runtimeState: async () => runtimeState,
          waitForEvent: async () => waited,
        };
        Object.defineProperty(stub, Symbol.dispose, { value: runtimeStateStubDispose });
        return stub as never;
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
    const waitedResult = await stream.waitForEvent({ afterOffset: 8, timeoutMs: 1_000 });
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
    expect(waitedResult).not.toBe(waited);
    expect(processorStateResult).toEqual(processorState);
    expect(processorStateResult).not.toBe(processorState);
    expect(runtimeStateResult).toEqual(runtimeState);
    expect(runtimeStateResult).not.toBe(runtimeState);
    expect(appendDispose).toHaveBeenCalledOnce();
    expect(readDispose).toHaveBeenCalledOnce();
    expect(pageDispose).toHaveBeenCalledOnce();
    expect(waitDispose).toHaveBeenCalledOnce();
    expect(processorStateDispose).toHaveBeenCalledOnce();
    expect(runtimeStateDispose).toHaveBeenCalledOnce();
    expect(runtimeStateStubDispose).toHaveBeenCalledOnce();
  });

  it("preserves a successful plain-data result when native disposal throws", async () => {
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
      override get [STREAM_DURABLE_OBJECT_STUB]() {
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

  it("replays a keyed append once when its native RPC acknowledgement is orphaned", async () => {
    vi.useFakeTimers();
    const firstAppend = Promise.withResolvers<StreamEvent[]>();
    const firstDispose = vi.fn();
    const secondDispose = vi.fn();
    const event = {
      createdAt: new Date(0).toISOString(),
      idempotencyKey: "keyed-orphan",
      offset: 3,
      path: "/events",
      payload: { recovered: true },
      type: "events.iterate.com/test/keyed-orphan",
    } satisfies StreamEvent;
    const firstResult = [{ ...event }];
    const secondResult = [{ ...event }];
    Object.defineProperty(firstResult, Symbol.dispose, { value: firstDispose });
    Object.defineProperty(secondResult, Symbol.dispose, { value: secondDispose });
    let acquisitions = 0;
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    class TestStreamRpcTarget extends StreamRpcTarget {
      override get [STREAM_DURABLE_OBJECT_STUB]() {
        acquisitions += 1;
        return {
          append: () => (acquisitions === 1 ? firstAppend.promise : Promise.resolve(secondResult)),
        } as never;
      }
    }
    const stream = new TestStreamRpcTarget({
      auth: { assertCanAccessProject: vi.fn() } as never,
      path: "/events",
      projectId: "prj_test",
    });

    const appending = stream.append({
      idempotencyKey: event.idempotencyKey,
      payload: event.payload,
      type: event.type,
    });
    try {
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(appending).resolves.toEqual([event]);
      expect(acquisitions).toBe(2);
      expect(secondDispose).toHaveBeenCalledOnce();
      expect(info).toHaveBeenCalledWith(
        "keyed stream append retrying after Durable Object unavailability",
        expect.objectContaining({
          error: expect.objectContaining({
            message: expect.stringContaining("received no response within 10000ms"),
          }),
          path: "/events",
          projectId: "prj_test",
        }),
      );

      firstAppend.resolve(firstResult);
      await vi.runAllTimersAsync();
      expect(firstDispose).toHaveBeenCalledOnce();
    } finally {
      firstAppend.reject(new Error("late keyed append rejection"));
      await appending.catch(() => undefined);
      info.mockRestore();
      vi.useRealTimers();
    }
  });

  it("never deadline-replays an unkeyed append", async () => {
    vi.useFakeTimers();
    const firstAppend = Promise.withResolvers<StreamEvent[]>();
    const result = [
      {
        createdAt: new Date(0).toISOString(),
        offset: 3,
        path: "/events",
        type: "events.iterate.com/test/unkeyed",
      } satisfies StreamEvent,
    ];
    let acquisitions = 0;

    class TestStreamRpcTarget extends StreamRpcTarget {
      override get [STREAM_DURABLE_OBJECT_STUB]() {
        acquisitions += 1;
        return { append: () => firstAppend.promise } as never;
      }
    }
    const stream = new TestStreamRpcTarget({
      auth: { assertCanAccessProject: vi.fn() } as never,
      path: "/events",
      projectId: "prj_test",
    });

    const appending = stream.append({ type: result[0]!.type });
    try {
      await vi.advanceTimersByTimeAsync(20_000);
      expect(acquisitions).toBe(1);

      firstAppend.resolve(result);
      await expect(appending).resolves.toEqual(result);
    } finally {
      firstAppend.reject(new Error("late unkeyed append rejection"));
      await appending.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("never deadline-replays a keyed root append", async () => {
    vi.useFakeTimers();
    const firstAppend = Promise.withResolvers<StreamEvent[]>();
    const result = [
      {
        createdAt: new Date(0).toISOString(),
        idempotencyKey: "root-birth",
        offset: 3,
        path: "/",
        type: "events.iterate.com/test/root-birth",
      } satisfies StreamEvent,
    ];
    let acquisitions = 0;

    class TestStreamRpcTarget extends StreamRpcTarget {
      override get [STREAM_DURABLE_OBJECT_STUB]() {
        acquisitions += 1;
        return { append: () => firstAppend.promise } as never;
      }
    }
    const stream = new TestStreamRpcTarget({
      auth: { assertCanAccessProject: vi.fn() } as never,
      path: "/",
      projectId: "prj_test",
    });

    const appending = stream.append({
      idempotencyKey: result[0]!.idempotencyKey,
      type: result[0]!.type,
    });
    try {
      await vi.advanceTimersByTimeAsync(20_000);
      expect(acquisitions).toBe(1);

      firstAppend.resolve(result);
      await expect(appending).resolves.toEqual(result);
    } finally {
      firstAppend.reject(new Error("late keyed root append rejection"));
      await appending.catch(() => undefined);
      vi.useRealTimers();
    }
  });

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
      override get [STREAM_DURABLE_OBJECT_STUB]() {
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
      await expect(waiting).resolves.toEqual(event);
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
    const remoteTimeouts: number[] = [];
    class TestStreamRpcTarget extends StreamRpcTarget {
      override get [STREAM_DURABLE_OBJECT_STUB]() {
        acquisitions += 1;
        return {
          waitForEvent: (input: { timeoutMs: number }) => {
            remoteTimeouts.push(input.timeoutMs);
            return acquisitions === 1 ? firstWait.promise : secondWait.promise;
          },
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
      expect(remoteTimeouts).toEqual([20_000, 20_000]);

      firstWait.resolve(event);
      await expect(waiting).resolves.toEqual(event);
    } finally {
      firstWait.resolve(event);
      secondWait.reject(new Error("late rejection after the ephemeral match"));
      await waiting.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("pins a cursor-less wait so a durable event in the re-arm gap is replayed", async () => {
    vi.useFakeTimers();
    const firstWait = Promise.withResolvers<StreamEvent>();
    const event = {
      createdAt: new Date(0).toISOString(),
      offset: 9,
      path: "/events",
      type: "events.iterate.com/test/in-rearm-gap",
    } satisfies StreamEvent;
    const waitInputs: { afterOffset?: number; timeoutMs: number }[] = [];
    let headReads = 0;
    class TestStreamRpcTarget extends StreamRpcTarget {
      override get [STREAM_DURABLE_OBJECT_STUB]() {
        return {
          getMaxOffset: () => {
            headReads += 1;
            return 8;
          },
          waitForEvent: (input: { afterOffset?: number; timeoutMs: number }) => {
            waitInputs.push(input);
            if (waitInputs.length === 1) return firstWait.promise;
            return input.afterOffset === 8
              ? Promise.resolve(event)
              : new Promise<StreamEvent>(() => undefined);
          },
        } as never;
      }
    }
    const stream = new TestStreamRpcTarget({
      auth: { assertCanAccessProject: vi.fn() } as never,
      path: "/events",
      projectId: "prj_test",
    });

    const waiting = stream.waitForEvent({
      eventTypes: [event.type],
      timeoutMs: 30_000,
    });
    try {
      await vi.advanceTimersByTimeAsync(10_000);

      expect(headReads).toBe(1);
      expect(waitInputs).toHaveLength(2);
      expect(waitInputs.map(({ afterOffset }) => afterOffset)).toEqual([8, 8]);
      await expect(waiting).resolves.toEqual(event);
    } finally {
      firstWait.reject(new Error("late rejection from superseded cursor-less wait"));
      await waiting.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("re-acquires when the cursor-pinning head read is orphaned", async () => {
    vi.useFakeTimers();
    const firstHead = Promise.withResolvers<number>();
    const event = {
      createdAt: new Date(0).toISOString(),
      offset: 9,
      path: "/events",
      type: "events.iterate.com/test/after-orphaned-head-read",
    } satisfies StreamEvent;
    let headReads = 0;
    let waits = 0;
    class TestStreamRpcTarget extends StreamRpcTarget {
      override get [STREAM_DURABLE_OBJECT_STUB]() {
        return {
          getMaxOffset: () => {
            headReads += 1;
            return headReads === 1 ? firstHead.promise : 8;
          },
          waitForEvent: () => {
            waits += 1;
            return Promise.resolve(event);
          },
        } as never;
      }
    }
    const stream = new TestStreamRpcTarget({
      auth: { assertCanAccessProject: vi.fn() } as never,
      path: "/events",
      projectId: "prj_test",
    });

    const waiting = stream.waitForEvent({ eventTypes: [event.type], timeoutMs: 30_000 });
    try {
      await vi.advanceTimersByTimeAsync(10_000);

      expect(headReads).toBe(2);
      expect(waits).toBe(1);
      await expect(waiting).resolves.toEqual(event);
    } finally {
      firstHead.reject(new Error("late rejection from superseded head read"));
      await waiting.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("propagates stream predicate failures without retrying", async () => {
    const predicateError = new Error("predicate failed");
    let acquisitions = 0;
    class TestStreamRpcTarget extends StreamRpcTarget {
      override get [STREAM_DURABLE_OBJECT_STUB]() {
        acquisitions += 1;
        return { waitForEvent: () => Promise.reject(predicateError) } as never;
      }
    }
    const stream = new TestStreamRpcTarget({
      auth: { assertCanAccessProject: vi.fn() } as never,
      path: "/events",
      projectId: "prj_test",
    });

    await expect(
      stream.waitForEvent({ afterOffset: 0, predicate: () => true, timeoutMs: 30_000 }),
    ).rejects.toThrow("predicate failed");
    expect(acquisitions).toBe(1);
  });

  it("tags an explicit stream lifecycle rejection without hiding it behind recovery", async () => {
    const lifecycleError = Object.assign(new Error("kill requested"), {
      durableObjectReset: true,
    });
    let acquisitions = 0;
    class TestStreamRpcTarget extends StreamRpcTarget {
      override get [STREAM_DURABLE_OBJECT_STUB]() {
        acquisitions += 1;
        return { waitForEvent: () => Promise.reject(lifecycleError) } as never;
      }
    }
    const stream = new TestStreamRpcTarget({
      auth: { assertCanAccessProject: vi.fn() } as never,
      path: "/events",
      projectId: "prj_test",
    });

    await expect(stream.waitForEvent({ afterOffset: 0, timeoutMs: 30_000 })).rejects.toThrow(
      "stream-unavailable: kill requested",
    );
    expect(acquisitions).toBe(1);
  });

  it("keeps one public timeout across orphaned stream waiters", async () => {
    vi.useFakeTimers();
    let acquisitions = 0;
    class TestStreamRpcTarget extends StreamRpcTarget {
      override get [STREAM_DURABLE_OBJECT_STUB]() {
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
      afterOffset: 0,
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

  it("requires branded sender authority and the receiving stream's project", async () => {
    const receiveCopiedEvents = vi.fn(async () => ({ accepted: 0, dropped: [] }));
    class TestStreamRpcTarget extends StreamRpcTarget {
      override get [STREAM_DURABLE_OBJECT_STUB]() {
        return { receiveCopiedEvents } as never;
      }
    }
    const batch = {
      projectId: "prj_receiver",
      path: "/source",
      events: [],
      streamMaxOffset: 1,
      subscriptionKey: "test",
      cursorChangedAtSourceOffset: 1,
      deliveryId: "test",
      attempt: 1,
      configuredEvent: {
        type: "events.iterate.com/stream/subscription-configured",
        offset: 1,
        createdAt: new Date(0).toISOString(),
        path: "/source",
        payload: {},
      },
    };

    const forged = new TestStreamRpcTarget({
      auth: {
        assertCanAccessProject: vi.fn(),
        principal: "trusted-internal",
      } as never,
      path: "/receiver",
      projectId: "prj_receiver",
    });
    expect(() => forged.receiveCopiedEvents(batch as never)).toThrow(
      "accepted only from trusted internal senders",
    );

    const branded = new TestStreamRpcTarget({
      auth: streamDeliveryAuthContext("prj_receiver"),
      path: "/receiver",
      projectId: "prj_receiver",
    });
    expect(() =>
      branded.receiveCopiedEvents({ ...batch, projectId: "prj_other" } as never),
    ).toThrow("must come from the receiving stream's project");
    await expect(branded.receiveCopiedEvents(batch as never)).resolves.toEqual({
      accepted: 0,
      dropped: [],
    });
    expect(receiveCopiedEvents).toHaveBeenCalledOnce();
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

  it("tags a processor lifecycle reset before RPC strips its retryable flag", async () => {
    const lifecycleReset = Object.assign(
      new Error(
        "Internal error while starting up Durable Object storage caused object to be reset",
      ),
      { retryable: true },
    );
    const reads: ProcessorReads<{ seen: number }> = {
      getRuntimeState: async () => ({ snapshot: { offset: 0, state: { seen: 0 } } }),
      snapshot: async () => ({ offset: 0, state: { seen: 0 } }),
      waitUntilEvent: async () => {
        throw lifecycleReset;
      },
    };
    const target = new StreamProcessorRpcTarget(reads);

    await expect(target.waitUntilProcessed({ offset: 8, timeoutMs: 75_000 })).rejects.toThrow(
      "stream-unavailable: Internal error while starting up Durable Object storage caused object to be reset",
    );
  });
});

describe("ProcessorRelayRpcTarget", () => {
  it.each(["user:test", "trusted-internal"])(
    "rejects hosted-processor wake calls carrying only principal %s",
    async (principal) => {
      const wakeStreamProcessor = vi.fn(async () => ({ accepted: true as const })) as never;
      const relay = new ProcessorRelayRpcTarget({
        auth: { principal } as never,
        host: () => ({
          processor: Promise.resolve({
            getRuntimeState: async () => ({ snapshot: { offset: 0, state: {} } }),
            snapshot: async () => ({ offset: 0, state: {} }),
            waitUntilProcessed: async () => undefined,
          }),
          wakeStreamProcessor,
        }),
      });

      await expect(
        relay.wakeStreamProcessor({
          processorSlug: "test",
          subscriptionKey: "test",
        } as never),
      ).rejects.toThrow("wakeStreamProcessor may be called only by trusted stream event sending");
      expect(wakeStreamProcessor).not.toHaveBeenCalled();
    },
  );

  it("resolves an asynchronous host for processor reads and wake delivery", async () => {
    const wakeStreamProcessor = vi.fn(async () => ({ accepted: true as const })) as never;
    const relay = new ProcessorRelayRpcTarget({
      auth: streamDeliveryAuthContext("prj_test"),
      host: async () => ({
        processor: Promise.resolve({
          getRuntimeState: async () => ({ snapshot: { offset: 4, state: { running: true } } }),
          snapshot: async () => ({ offset: 4, state: { running: true } }),
          waitUntilProcessed: async () => undefined,
        }),
        wakeStreamProcessor,
      }),
    });

    await expect(relay.snapshot()).resolves.toEqual({ offset: 4, state: { running: true } });
    const request = { processorSlug: "sandbox", subscriptionKey: "sandbox-test" } as never;
    await expect(relay.wakeStreamProcessor(request)).resolves.toEqual({ accepted: true });
    expect(wakeStreamProcessor).toHaveBeenCalledWith(request);
  });

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
        wakeStreamProcessor: async () => {
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
        wakeStreamProcessor: async () => {
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
        wakeStreamProcessor: async () => {
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
        wakeStreamProcessor: async () => {
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
        wakeStreamProcessor: async () => {
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

  it("shares one waitUntilProcessed timeout across a serialized availability retry", async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const lifecycleReset = new Error(
      "stream-unavailable: Durable Object reset because its code was updated.",
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
        wakeStreamProcessor: async () => {
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

  it("re-acquires within the public deadline after repeated availability failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const lifecycleReset = new Error(
      "stream-unavailable: Durable Object is overloaded. Requests queued for too long.",
    );
    const waits: { offset: number; timeoutMs?: number }[] = [];
    const disposals: number[] = [];
    let acquisitions = 0;
    const relay = new ProcessorRelayRpcTarget({
      auth: { principal: "trusted-internal" } as never,
      host: () => ({
        processor: Promise.resolve({}),
        wakeStreamProcessor: async () => {
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
          waitUntilProcessed: async (input: { offset: number; timeoutMs?: number }) => {
            waits.push(input);
            if (acquisition <= 6) throw lifecycleReset;
          },
        });
      },
    });

    const waiting = relay.waitUntilProcessed({ offset: 3, timeoutMs: 5_000 });
    const completed = expect(waiting).resolves.toBeUndefined();
    try {
      await vi.advanceTimersByTimeAsync(700);
      await completed;
      expect(waits).toEqual([
        { offset: 3, timeoutMs: 5_000 },
        { offset: 3, timeoutMs: 5_000 },
        { offset: 3, timeoutMs: 4_900 },
        { offset: 3, timeoutMs: 4_900 },
        { offset: 3, timeoutMs: 4_700 },
        { offset: 3, timeoutMs: 4_700 },
        { offset: 3, timeoutMs: 4_300 },
      ]);
      expect(disposals).toEqual([1, 2, 3, 4, 5, 6, 7]);
    } finally {
      await waiting.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("does not re-acquire a wait after a processor application error", async () => {
    const applicationError = new Error("project birth was rejected");
    const dispose = vi.fn();
    let acquisitions = 0;
    const relay = new ProcessorRelayRpcTarget({
      auth: { principal: "trusted-internal" } as never,
      host: () => ({
        processor: Promise.resolve({}),
        wakeStreamProcessor: async () => {
          throw new Error("not used");
        },
      }),
      processorFacade: () => {
        acquisitions += 1;
        return Promise.resolve({
          [Symbol.dispose]: dispose,
          getRuntimeState: async () => ({ snapshot: { offset: 0, state: {} } }),
          snapshot: async () => ({ offset: 0, state: {} }),
          waitUntilProcessed: async () => {
            throw applicationError;
          },
        });
      },
    });

    await expect(relay.waitUntilProcessed({ offset: 3, timeoutMs: 30_000 })).rejects.toBe(
      applicationError,
    );
    expect(acquisitions).toBe(1);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("bounds repeated availability re-acquisition by the public timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const lifecycleReset = new Error(
      "stream-unavailable: Durable Object is overloaded. Requests queued for too long.",
    );
    const dispose = vi.fn();
    let acquisitions = 0;
    const relay = new ProcessorRelayRpcTarget({
      auth: { principal: "trusted-internal" } as never,
      host: () => ({
        processor: Promise.resolve({}),
        wakeStreamProcessor: async () => {
          throw new Error("not used");
        },
      }),
      processorFacade: () => {
        acquisitions += 1;
        return Promise.resolve({
          [Symbol.dispose]: dispose,
          getRuntimeState: async () => ({ snapshot: { offset: 0, state: {} } }),
          snapshot: async () => ({ offset: 0, state: {} }),
          waitUntilProcessed: async () => {
            throw lifecycleReset;
          },
        });
      },
    });

    const waiting = relay.waitUntilProcessed({ offset: 3, timeoutMs: 500 });
    const rejected = expect(waiting).rejects.toThrow(
      "waitUntilProcessed timed out after 500ms waiting for offset 3",
    );
    try {
      await vi.advanceTimersByTimeAsync(500);
      await rejected;
      expect(acquisitions).toBe(6);
      expect(dispose).toHaveBeenCalledTimes(6);
    } finally {
      await waiting.catch(() => undefined);
      vi.useRealTimers();
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
        wakeStreamProcessor: async () => {
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
        wakeStreamProcessor: async () => {
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
        wakeStreamProcessor: async () => {
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
        wakeStreamProcessor: async () => {
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

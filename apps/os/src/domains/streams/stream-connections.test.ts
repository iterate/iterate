import { DatabaseSync } from "node:sqlite";
import type { StreamEvent, StreamEventBatch, StreamWakeEventBatch } from "iterate/processors";
import { describe, expect, it, vi } from "vitest";
import { CoreProcessorContract, type CoreProcessorState } from "./core-processor-contract.ts";
import { compileEventFilter } from "./event-filter.ts";
import { StreamConnections } from "./stream-connections.ts";
import { DEFAULT_DELIVERY_TIMEOUT_MS } from "./stream-delivery-utils.ts";
import type { RetainedProcessEventBatch } from "./retained-event-callbacks.ts";
import { SqliteSubscriptionCursorStore } from "./stream-storage.ts";

function wrapSqlStorage(db: DatabaseSync): SqlStorage {
  return {
    exec<T = unknown>(sql: string, ...bindings: (ArrayBuffer | null | number | string)[]) {
      const rows = db
        .prepare(sql)
        .all(
          ...bindings.map((binding) =>
            binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding,
          ),
        )
        .map((row) => Object.fromEntries(Object.entries(row).map(fromNodeSqlValue)));
      return { toArray: () => rows as T[] };
    },
  } as SqlStorage;
}

function fromNodeSqlValue([key, value]: [string, unknown]) {
  if (value instanceof Uint8Array) {
    return [key, value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)];
  }
  return [key, value];
}

function streamEvent(offset: number, type = "events.example.com/item-created"): StreamEvent {
  return {
    type,
    payload: { offset },
    createdAt: new Date(offset).toISOString(),
    offset,
    path: "/source",
  };
}

type DeliveryCall = {
  batch: StreamEventBatch;
  report(outcome: "ok" | "error"): void;
};

function retainedProcessEventBatch(
  calls: DeliveryCall[],
  disposed: () => void,
): RetainedProcessEventBatch {
  return Object.assign(
    (batch: StreamEventBatch) => {
      calls.push({
        batch,
        report: (outcome) => {
          if (!("reportDeliveryResult" in batch)) {
            throw new Error("test tried to report a result for a session delivery");
          }
          (batch as StreamWakeEventBatch).reportDeliveryResult(
            outcome === "ok"
              ? { outcome: "ok" }
              : {
                  outcome: "error",
                  error: { name: "Error", message: "test delivery failed" },
                },
          );
        },
      });
    },
    {
      [Symbol.dispose]: () => disposed(),
    },
  );
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function harness(
  options: {
    events?: StreamEvent[];
    onAppend?: (args: {
      connections: StreamConnections;
      state: CoreProcessorState;
      event: Parameters<
        ConstructorParameters<typeof StreamConnections>[0]["hooks"]["appendDeliveryEvent"]
      >[0];
    }) => boolean | void;
  } = {},
) {
  let now = 1_000;
  const events = options.events ?? [streamEvent(1), streamEvent(2), streamEvent(3)];
  const store = new SqliteSubscriptionCursorStore(wrapSqlStorage(new DatabaseSync(":memory:")));
  store.ensure("processor", 0, 12);
  const row = store.get("processor")!;
  const expectedDelivery = {
    configuredAtOffset: 12,
    cursorChangedAtOffset: row.cursorChangedAtOffset,
    connectionGeneration: 7,
  };
  const state = CoreProcessorContract.stateSchema.parse({
    projectId: "project",
    path: "/source",
    streamId: "11111111-1111-4111-8111-111111111111",
    createdAt: "2026-07-22T12:00:00.000Z",
    maxOffset: events.length,
  }) satisfies CoreProcessorState;
  const alarmTimes: number[] = [];
  const durableDeliveryWakes = vi.fn();
  const deliveryFailures = vi.fn((connectionKey: string, error: unknown) => {
    const current = store.get(connectionKey)!;
    store.nack(connectionKey, {
      attempt: current.attempt + 1,
      nextAttemptAt: now + 100,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  let connections!: StreamConnections;
  connections = new StreamConnections({
    idleTeardownMs: 60_000,
    hooks: {
      // Force several batches so the test can observe the one-at-a-time gate.
      readBatch: (afterOffset) =>
        events
          .filter((event) => event.offset > afterOffset)
          .slice(0, 1)
          .map((event) => ({ event, byteLength: JSON.stringify(event).length })),
      coreState: () => state,
      store,
      appendDeliveryEvent: (event) => {
        return options.onAppend?.({ connections, state, event }) ?? true;
      },
      recordEgress: () => undefined,
      runtimeChanged: () => undefined,
      now: () => now,
      armAlarm: (atMs) => alarmTimes.push(atMs),
      keepAlive: () => undefined,
      hostedDeliveryStillMatches: (_subscriptionKey, candidate) =>
        candidate.configuredAtOffset === expectedDelivery.configuredAtOffset &&
        candidate.cursorChangedAtOffset === expectedDelivery.cursorChangedAtOffset &&
        candidate.connectionGeneration === expectedDelivery.connectionGeneration,
      onHostedDeliveryFailure: deliveryFailures,
      sendDueSubscriptions: durableDeliveryWakes,
    },
  });
  return {
    connections,
    state,
    store,
    expectedDelivery,
    alarmTimes,
    deliveryFailures,
    durableDeliveryWakes,
    setNow(value: number) {
      now = value;
    },
  };
}

describe("StreamConnections hosted delivery watchdog", () => {
  it("does not publish a hosted callback until its opened event finishes appending", () => {
    const calls: DeliveryCall[] = [];
    const h = harness({
      onAppend: ({ connections, event }) => {
        if (event.type === "events.iterate.com/stream/connection-opened") {
          // Mirrors StreamDurableObject.#append's synchronous post-commit
          // send check while openHosted is still recording this event.
          connections.sendQueued();
        }
      },
    });
    const connection = h.connections.openHosted({
      connectionKey: "processor",
      expectedHostedDelivery: h.expectedDelivery,
      processEventBatch: retainedProcessEventBatch(calls, () => undefined),
      replayAfterOffset: 0,
    });

    expect(calls).toHaveLength(0);
    expect(h.connections.runtimeState().processor).toMatchObject({
      kind: "hosted",
      subscriptionKey: "processor",
    });

    // The wake path records the reported checkpoint after openHosted returns,
    // then explicitly starts delivery. Its ack can no longer clear a marker
    // that the first batch has already written.
    h.store.ack("processor", 0);
    connection.sendQueued();
    expect(calls).toHaveLength(1);
    expect(h.store.get("processor")).toMatchObject({
      inFlightDeadlineAt: 1_000 + DEFAULT_DELIVERY_TIMEOUT_MS,
      inFlightConnectionGeneration: 7,
    });
  });

  it("disposes and rejects a hosted callback when its opened fact is interrupted", () => {
    const calls: DeliveryCall[] = [];
    const disposed = vi.fn();
    const h = harness({
      onAppend: ({ event }) =>
        event.type === "events.iterate.com/stream/connection-opened" ? false : undefined,
    });

    expect(() =>
      h.connections.openHosted({
        connectionKey: "processor",
        expectedHostedDelivery: h.expectedDelivery,
        processEventBatch: retainedProcessEventBatch(calls, disposed),
        replayAfterOffset: 0,
      }),
    ).toThrow(/opened-event append was interrupted/);

    expect(disposed).toHaveBeenCalledOnce();
    expect(h.connections.has("processor")).toBe(false);
    expect(calls).toHaveLength(0);
    expect(h.store.get("processor")).toMatchObject({
      inFlightDeadlineAt: null,
      inFlightConnectionGeneration: null,
    });
  });

  it("disposes and rejects a session callback when its opened fact is interrupted", () => {
    const calls: DeliveryCall[] = [];
    const disposed = vi.fn();
    const h = harness({
      onAppend: ({ event }) =>
        event.type === "events.iterate.com/stream/connection-opened" ? false : undefined,
    });

    expect(() =>
      h.connections.openSession({
        connectionKey: "session",
        processEventBatch: retainedProcessEventBatch(calls, disposed),
      }),
    ).toThrow(/opened-event append was interrupted/);

    expect(disposed).toHaveBeenCalledOnce();
    expect(h.connections.has("session")).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("treats a lifecycle-interrupted closed fact as a best-effort observation", () => {
    const calls: DeliveryCall[] = [];
    const disposed = vi.fn();
    const h = harness({
      onAppend: ({ event }) =>
        event.type === "events.iterate.com/stream/connection-closed" ? false : undefined,
    });
    const connection = h.connections.openHosted({
      connectionKey: "processor",
      expectedHostedDelivery: h.expectedDelivery,
      processEventBatch: retainedProcessEventBatch(calls, disposed),
      replayAfterOffset: 0,
    });

    expect(() => connection.close("closed-by-owner")).not.toThrow();
    expect(disposed).toHaveBeenCalledOnce();
    expect(h.connections.has("processor")).toBe(false);
  });

  it("records rpc-broken when a session callback transport reports that it broke", () => {
    const appended: unknown[] = [];
    const h = harness({
      onAppend: ({ event }) => {
        appended.push(event);
      },
    });
    let reportBroken: ((error: unknown) => void) | undefined;
    const processEventBatch = retainedProcessEventBatch([], () => undefined);
    processEventBatch.onRpcBroken = (handler) => {
      reportBroken = handler;
    };
    h.connections.openSession({
      connectionKey: "session",
      processEventBatch,
    });

    reportBroken!(new Error("transport closed"));

    expect(h.connections.has("session")).toBe(false);
    expect(appended).toContainEqual({
      type: "events.iterate.com/stream/connection-closed",
      payload: { connectionKey: "session", reason: "rpc-broken", error: "transport closed" },
    });
    expect(h.durableDeliveryWakes).toHaveBeenCalledOnce();
  });

  it("closes and records a session connection whose event condition throws", async () => {
    const appended: unknown[] = [];
    const h = harness({
      onAppend: ({ event }) => {
        appended.push(event);
      },
    });
    const infoLog = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const calls: DeliveryCall[] = [];
    const disposed = vi.fn();
    const connection = h.connections.openSession({
      connectionKey: "session",
      processEventBatch: retainedProcessEventBatch(calls, disposed),
      replayAfterOffset: 0,
      filter: compileEventFilter({ condition: '$error("session filter exploded")' }),
    });

    await flushMicrotasks();

    expect(calls).toHaveLength(0);
    expect(connection.isLive()).toBe(false);
    expect(disposed).toHaveBeenCalledOnce();
    expect(appended).toContainEqual({
      type: "events.iterate.com/stream/connection-closed",
      payload: {
        connectionKey: "session",
        reason: "delivery-failed",
        error: "session filter exploded",
      },
    });
    expect(infoLog).toHaveBeenCalledWith(
      "stream session filter condition failed; closing connection",
      expect.objectContaining({ connectionKey: "session", error: expect.any(Error) }),
    );
    infoLog.mockRestore();
  });

  it("backs off a hosted processor when its configured event condition throws", async () => {
    const h = harness();
    const calls: DeliveryCall[] = [];
    const disposed = vi.fn();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const connection = h.connections.openHosted({
      connectionKey: "processor",
      expectedHostedDelivery: h.expectedDelivery,
      processEventBatch: retainedProcessEventBatch(calls, disposed),
      replayAfterOffset: 0,
      filter: {
        matches: () => {
          throw new Error("filter exploded");
        },
      },
    });

    connection.sendQueued();
    await flushMicrotasks();

    expect(calls).toHaveLength(0);
    expect(h.deliveryFailures).toHaveBeenCalledOnce();
    expect(h.deliveryFailures).toHaveBeenCalledWith("processor", expect.any(Error));
    expect(h.store.get("processor")).toMatchObject({ attempt: 1, nextAttemptAt: 1_100 });
    expect(connection.isLive()).toBe(false);
    expect(disposed).toHaveBeenCalledOnce();
    expect(h.durableDeliveryWakes).toHaveBeenCalledOnce();
    errorLog.mockRestore();
  });

  it("dispatches one hosted batch at a time and clears the durable marker before the next", async () => {
    const h = harness();
    h.store.nack("processor", {
      attempt: 14,
      nextAttemptAt: 1_100,
      error: "earlier callback failure",
    });
    const calls: DeliveryCall[] = [];
    const disposed = vi.fn();
    const connection = h.connections.openHosted({
      connectionKey: "processor",
      expectedHostedDelivery: h.expectedDelivery,
      processEventBatch: retainedProcessEventBatch(calls, disposed),
      replayAfterOffset: 0,
    });

    connection.sendQueued();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.batch.events.map((event) => event.offset)).toEqual([1]);
    expect(h.store.get("processor")).toMatchObject({
      attempt: 14,
      nextAttemptAt: 1_100,
      lastError: "earlier callback failure",
      inFlightDeadlineAt: 1_000 + DEFAULT_DELIVERY_TIMEOUT_MS,
      inFlightConnectionGeneration: 7,
    });

    connection.sendQueued();
    expect(calls).toHaveLength(1);

    calls[0]!.report("ok");
    await flushMicrotasks();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.batch.events.map((event) => event.offset)).toEqual([2]);
    expect(h.store.get("processor")).toMatchObject({
      attempt: 0,
      nextAttemptAt: null,
      lastError: null,
      inFlightDeadlineAt: 1_000 + DEFAULT_DELIVERY_TIMEOUT_MS,
      inFlightConnectionGeneration: 7,
    });
    expect(disposed).not.toHaveBeenCalled();
  });

  it("turns a live callback timeout into a counted failure and ignores its late result", async () => {
    const h = harness();
    const calls: DeliveryCall[] = [];
    const disposed = vi.fn();
    const connection = h.connections.openHosted({
      connectionKey: "processor",
      expectedHostedDelivery: h.expectedDelivery,
      processEventBatch: retainedProcessEventBatch(calls, disposed),
      replayAfterOffset: 0,
    });
    connection.sendQueued();
    expect(calls).toHaveLength(1);

    h.setNow(1_000 + DEFAULT_DELIVERY_TIMEOUT_MS);
    h.connections.onAlarm();

    expect(h.deliveryFailures).toHaveBeenCalledTimes(1);
    expect(h.store.get("processor")).toMatchObject({
      attempt: 1,
      inFlightDeadlineAt: null,
      inFlightConnectionGeneration: null,
    });
    expect(connection.isLive()).toBe(false);
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(h.durableDeliveryWakes).toHaveBeenCalledTimes(1);

    calls[0]!.report("ok");
    await flushMicrotasks();
    expect(calls).toHaveLength(1);
    expect(h.deliveryFailures).toHaveBeenCalledTimes(1);
  });

  it("idle teardown never acknowledges a batch that has not completed", () => {
    const h = harness();
    const calls: DeliveryCall[] = [];
    const disposed = vi.fn();
    const connection = h.connections.openHosted({
      connectionKey: "processor",
      expectedHostedDelivery: h.expectedDelivery,
      processEventBatch: retainedProcessEventBatch(calls, disposed),
      replayAfterOffset: 0,
    });
    connection.sendQueued();
    const before = h.store.get("processor")!;

    h.connections.runIdleTeardownNow();

    expect(connection.isLive()).toBe(false);
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(h.store.get("processor")).toMatchObject({
      acknowledgedOffset: before.acknowledgedOffset,
      inFlightDeadlineAt: before.inFlightDeadlineAt,
      inFlightConnectionGeneration: before.inFlightConnectionGeneration,
    });
  });

  it("advances a completed hosted cursor through the close fact to avoid a self-wake loop", () => {
    const h = harness({
      onAppend: ({ event, state }) => {
        // Model StreamDurableObject.#append's synchronous core-state fold.
        if (event.type === "events.iterate.com/stream/connection-opened") state.maxOffset = 4;
        if (event.type === "events.iterate.com/stream/connection-closed") state.maxOffset = 5;
      },
    });
    const disposed = vi.fn();
    h.store.ack("processor", 3);
    h.connections.openHosted({
      connectionKey: "processor",
      expectedHostedDelivery: h.expectedDelivery,
      processEventBatch: retainedProcessEventBatch([], disposed),
      replayAfterOffset: 3,
    });

    expect(h.connections.runIdleTeardownNow()).toEqual(["processor"]);

    expect(disposed).toHaveBeenCalledOnce();
    expect(h.state.maxOffset).toBe(5);
    expect(h.store.get("processor")).toMatchObject({ acknowledgedOffset: 5 });
  });
});

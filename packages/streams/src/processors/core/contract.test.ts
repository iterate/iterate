import { describe, expect, it } from "vitest";
import { coreProcessorContract } from "./contract.ts";
import { assertStreamAppendAllowed, getAncestorStreamPaths } from "./implementation.ts";

const reduce = coreProcessorContract.reduce;
if (reduce === undefined) throw new Error("core processor must have a reducer");

describe("core processor contract", () => {
  it("reduces stream identity and ordinary bookkeeping", () => {
    let state = coreProcessorContract.stateSchema.parse(coreProcessorContract.initialState);
    for (const event of [
      {
        offset: 1,
        type: "events.iterate.com/stream/created" as const,
        payload: { namespace: "default", path: "test" },
        createdAt: "2026-06-01T12:00:00.000Z",
      },
      {
        offset: 2,
        type: "events.iterate.com/stream/woken" as const,
        payload: { incarnationId: "incarnation-1" },
        createdAt: "2026-06-01T12:00:00.001Z",
      },
      {
        offset: 3,
        type: "events.iterate.com/stream/configured" as const,
        payload: { config: { simulatedStorageSyncDelayMs: 25 } },
        createdAt: "2026-06-01T12:00:01.000Z",
      },
    ]) {
      state = coreProcessorContract.stateSchema.parse(
        reduce({ contract: coreProcessorContract, state, event }),
      );
    }

    expect(state).toMatchObject({
      namespace: "default",
      path: "test",
      eventCount: 3,
      maxOffset: 3,
      incarnationId: "incarnation-1",
      config: { simulatedStorageSyncDelayMs: 25 },
    });
  });

  it("keeps latest subscription and processor registration events", () => {
    let state = coreProcessorContract.stateSchema.parse(coreProcessorContract.initialState);
    state = coreProcessorContract.stateSchema.parse(
      reduce({
        contract: coreProcessorContract,
        state,
        event: {
          offset: 1,
          type: "events.iterate.com/stream/subscription-configured",
          idempotencyKey: "subscription:echo",
          payload: {
            subscriptionKey: "echo",
            subscriber: {
              type: "built-in",
              transport: "capnweb-websocket",
              processorSlug: "echo-example",
            },
          },
          createdAt: "2026-06-01T12:00:01.000Z",
        },
      }),
    );
    state = coreProcessorContract.stateSchema.parse(
      reduce({
        contract: coreProcessorContract,
        state,
        event: {
          offset: 2,
          createdAt: "2026-06-01T12:00:02.000Z",
          type: "events.iterate.com/stream/processor-registered",
          idempotencyKey: "processor-registered:echo-example:0.1.0",
          payload: {
            slug: "echo-example",
            version: "0.1.0",
            description:
              "Counts received inputs and echoes each back as an output carrying the running count.",
            consumes: ["events.iterate.com/echo-example/input-received"],
            emits: ["events.iterate.com/echo-example/output-echoed"],
            ownedEvents: [
              { type: "events.iterate.com/echo-example/input-received", description: "Input." },
              { type: "events.iterate.com/echo-example/output-echoed", description: "Output." },
            ],
          },
        },
      }),
    );

    expect(state.subscriptionsByKey.echo.latestConfiguredEvent.offset).toBe(1);
    expect(state.processorsBySlug["echo-example"]?.latestRegisteredEvent.payload).toMatchObject({
      slug: "echo-example",
      version: "0.1.0",
      ownedEvents: [
        { type: "events.iterate.com/echo-example/input-received", description: "Input." },
        { type: "events.iterate.com/echo-example/output-echoed", description: "Output." },
      ],
    });
  });

  it("owns pause/resume and beforeAppend door logic", () => {
    let state = coreProcessorContract.stateSchema.parse(coreProcessorContract.initialState);
    state = coreProcessorContract.stateSchema.parse(
      reduce({
        contract: coreProcessorContract,
        state,
        event: {
          offset: 1,
          createdAt: "2026-06-01T12:00:00.000Z",
          type: "events.iterate.com/stream/paused",
          payload: { reason: "circuit breaker tripped" },
        },
      }),
    );

    expect(state.paused).toBe(true);
    expect(() => assertStreamAppendAllowed({ event: { type: "test.event" }, state })).toThrow(
      "stream paused",
    );
    expect(() =>
      assertStreamAppendAllowed({
        event: { type: "events.iterate.com/stream/resumed", payload: { reason: "operator" } },
        state,
      }),
    ).not.toThrow();

    state = coreProcessorContract.stateSchema.parse(
      reduce({
        contract: coreProcessorContract,
        state,
        event: {
          offset: 2,
          createdAt: "2026-06-01T12:00:01.000Z",
          type: "events.iterate.com/stream/resumed",
          payload: { reason: "operator" },
        },
      }),
    );
    expect(state.paused).toBe(false);
  });

  it("reduces stream-owned helper events", () => {
    let state = coreProcessorContract.stateSchema.parse({
      ...coreProcessorContract.initialState,
      path: "/a",
    });
    for (const event of [
      {
        offset: 1,
        createdAt: "2026-06-01T12:00:00.000Z",
        type: "events.iterate.com/stream/child-stream-created" as const,
        idempotencyKey: "child-stream-created:/a:/a/b/c",
        payload: { childPath: "/a/b/c" },
      },
      {
        offset: 2,
        createdAt: "2026-06-01T12:00:01.000Z",
        type: "events.iterate.com/stream/metadata-updated" as const,
        payload: { metadata: { title: "Demo stream" } },
      },
      {
        offset: 3,
        createdAt: "2026-06-01T12:00:02.000Z",
        type: "events.iterate.com/stream/error-occurred" as const,
        payload: { message: "boom" },
      },
    ]) {
      state = coreProcessorContract.stateSchema.parse(
        reduce({ contract: coreProcessorContract, state, event }),
      );
    }

    expect(state.childPaths).toEqual(["/a/b"]);
    expect(state.metadata).toEqual({ title: "Demo stream" });
    expect(state.maxOffset).toBe(3);
    expect(getAncestorStreamPaths("/a/b/c")).toEqual(["/", "/a", "/a/b"]);
  });
});

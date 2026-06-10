import { describe, expect, it } from "vitest";
import type { StreamEvent } from "../../shared/event.ts";
import { durableObjectProcessorSubscriber } from "../../shared/callable-subscriber.ts";
import { CoreProcessorContract, type CoreProcessorState } from "./contract.ts";
import { CoreStreamProcessor } from "./implementation.ts";

const callableSubscriber = (processorName: string) =>
  durableObjectProcessorSubscriber({
    bindingName: "PROCESSOR_HOST",
    durableObjectName: "host-1",
    processorName,
  });

const processor = new CoreStreamProcessor({
  iterateContext: { stream: { append: () => {}, appendBatch: () => {} } },
});

function reduce(args: { contract?: unknown; state: CoreProcessorState; event: StreamEvent }) {
  return processor.reduceEvent(args);
}

function reduceEvents(args: {
  state?: CoreProcessorState;
  events: readonly StreamEvent[];
}): CoreProcessorState {
  let state =
    args.state ?? CoreProcessorContract.stateSchema.parse(CoreProcessorContract.initialState);
  for (const event of args.events) {
    if (event.offset <= state.maxOffset) continue;
    state = processor.reduceEvent({ event, state });
  }
  return state;
}

describe("core processor contract", () => {
  it("reduces stream identity and ordinary bookkeeping", () => {
    let state = CoreProcessorContract.stateSchema.parse(CoreProcessorContract.initialState);
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
      state = CoreProcessorContract.stateSchema.parse(
        reduce({ contract: CoreProcessorContract, state, event }),
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

  it("keeps the latest subscription configuration", () => {
    let state = CoreProcessorContract.stateSchema.parse(CoreProcessorContract.initialState);
    state = CoreProcessorContract.stateSchema.parse(
      reduce({
        contract: CoreProcessorContract,
        state,
        event: {
          offset: 1,
          type: "events.iterate.com/stream/subscription-configured",
          idempotencyKey: "subscription:echo",
          payload: {
            subscriptionKey: "echo",
            subscriber: callableSubscriber("echo-example"),
          },
          createdAt: "2026-06-01T12:00:01.000Z",
        },
      }),
    );

    expect(state.subscriptionsByKey.echo.latestConfiguredEvent.offset).toBe(1);
  });

  it("maintains the presence roster from subscriber connect/disconnect facts", () => {
    const state = reduceEvents({
      events: [
        {
          offset: 1,
          type: "events.iterate.com/stream/subscriber-connected",
          payload: {
            subscriptionKey: "agent-host:agent",
            direction: "outbound",
            subscriber: { incarnationId: "host-incarnation-1" },
          },
          createdAt: "2026-06-01T12:00:00.000Z",
        },
        {
          offset: 2,
          type: "events.iterate.com/stream/subscriber-connected",
          payload: {
            subscriptionKey: "browser-tab",
            direction: "inbound",
            subscriber: { description: "browser" },
          },
          createdAt: "2026-06-01T12:00:01.000Z",
        },
        {
          offset: 3,
          type: "events.iterate.com/stream/subscriber-disconnected",
          payload: { subscriptionKey: "browser-tab", reason: "unsubscribed" },
          createdAt: "2026-06-01T12:00:02.000Z",
        },
      ],
    });

    expect(Object.keys(state.connectionsByKey)).toEqual(["agent-host:agent"]);
    expect(state.connectionsByKey["agent-host:agent"]).toMatchObject({
      direction: "outbound",
      connectedAtOffset: 1,
      subscriber: { incarnationId: "host-incarnation-1" },
    });
  });

  it("re-lands a connection on the roster after a disconnect/reconnect cycle", () => {
    const state = reduceEvents({
      events: [
        {
          offset: 1,
          type: "events.iterate.com/stream/subscriber-connected",
          payload: { subscriptionKey: "echo", direction: "outbound" },
          createdAt: "2026-06-01T12:00:00.000Z",
        },
        {
          offset: 2,
          type: "events.iterate.com/stream/subscriber-disconnected",
          payload: { subscriptionKey: "echo", reason: "rpc-broken" },
          createdAt: "2026-06-01T12:00:01.000Z",
        },
        {
          offset: 3,
          type: "events.iterate.com/stream/subscriber-connected",
          payload: {
            subscriptionKey: "echo",
            direction: "outbound",
            subscriber: { incarnationId: "host-incarnation-2" },
          },
          createdAt: "2026-06-01T12:00:02.000Z",
        },
      ],
    });

    expect(state.connectionsByKey.echo).toMatchObject({
      connectedAtOffset: 3,
      subscriber: { incarnationId: "host-incarnation-2" },
    });
  });

  it("clears the roster when the stream itself re-incarnates", () => {
    const state = reduceEvents({
      events: [
        {
          offset: 1,
          type: "events.iterate.com/stream/subscriber-connected",
          payload: { subscriptionKey: "echo", direction: "outbound" },
          createdAt: "2026-06-01T12:00:00.000Z",
        },
        {
          offset: 2,
          type: "events.iterate.com/stream/woken",
          payload: { incarnationId: "stream-incarnation-2" },
          createdAt: "2026-06-01T12:00:01.000Z",
        },
      ],
    });

    // Every previous connection died with the old stream incarnation; the
    // roster only repopulates from fresh connected events.
    expect(state.connectionsByKey).toEqual({});
    expect(state.incarnationId).toBe("stream-incarnation-2");
  });

  it("folds processor contract announcements from connect events", () => {
    const state = reduceEvents({
      events: [
        {
          offset: 1,
          type: "events.iterate.com/stream/subscriber-connected",
          payload: {
            subscriptionKey: "host:echo-example",
            direction: "outbound",
            subscriber: {
              incarnationId: "host-incarnation-1",
              processor: {
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
          },
          createdAt: "2026-06-01T12:00:00.000Z",
        },
      ],
    });

    expect(state.processorsBySlug["echo-example"]).toMatchObject({
      announcedAtOffset: 1,
      announcement: {
        slug: "echo-example",
        version: "0.1.0",
        ownedEvents: [
          { type: "events.iterate.com/echo-example/input-received", description: "Input." },
          { type: "events.iterate.com/echo-example/output-echoed", description: "Output." },
        ],
      },
    });
    // The announcement registry survives the disconnect: it documents what has
    // run on this stream, not who is currently attached.
    const after = reduceEvents({
      state,
      events: [
        {
          offset: 2,
          type: "events.iterate.com/stream/subscriber-disconnected",
          payload: { subscriptionKey: "host:echo-example", reason: "rpc-broken" },
          createdAt: "2026-06-01T12:00:01.000Z",
        },
      ],
    });
    expect(after.processorsBySlug["echo-example"]).toBeDefined();
    expect(after.connectionsByKey).toEqual({});
  });

  it("owns pause/resume and append validation", () => {
    let state = CoreProcessorContract.stateSchema.parse(CoreProcessorContract.initialState);
    state = CoreProcessorContract.stateSchema.parse(
      reduce({
        contract: CoreProcessorContract,
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
    expect(() => processor.validateAppend({ event: { type: "test.event" }, state })).toThrow(
      "stream paused",
    );
    expect(() =>
      processor.validateAppend({
        event: { type: "events.iterate.com/stream/resumed", payload: { reason: "operator" } },
        state,
      }),
    ).not.toThrow();

    state = CoreProcessorContract.stateSchema.parse(
      reduce({
        contract: CoreProcessorContract,
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
    let state = CoreProcessorContract.stateSchema.parse({
      ...CoreProcessorContract.initialState,
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
      state = CoreProcessorContract.stateSchema.parse(
        reduce({ contract: CoreProcessorContract, state, event }),
      );
    }

    expect(state.childPaths).toEqual(["/a/b"]);
    expect(state.metadata).toEqual({ title: "Demo stream" });
    expect(state.maxOffset).toBe(3);
  });

  it("accumulates immediate child paths from child-stream-created announcements", () => {
    const announcement = (offset: number, childPath: string): StreamEvent => ({
      offset,
      createdAt: `2026-06-01T12:00:0${offset}.000Z`,
      type: "events.iterate.com/stream/child-stream-created",
      idempotencyKey: `child-stream-created:${offset}:${childPath}`,
      payload: { childPath },
    });

    // The root hears every announcement in the namespace, but only keeps the
    // immediate child paths. Callers that need a tree walk each child stream.
    const rootState = reduceEvents({
      state: CoreProcessorContract.stateSchema.parse({
        ...CoreProcessorContract.initialState,
        path: "/",
      }),
      events: [
        announcement(1, "/a"),
        announcement(2, "/a/b"),
        announcement(3, "/c"),
        announcement(4, "/a/b"), // duplicate announcement is ignored
      ],
    });
    expect(rootState.childPaths).toEqual(["/a", "/c"]);

    // An intermediate ancestor keeps only its immediate child paths: not
    // itself, not siblings, and not a path that merely shares a prefix.
    const intermediateState = reduceEvents({
      state: CoreProcessorContract.stateSchema.parse({
        ...CoreProcessorContract.initialState,
        path: "/a",
      }),
      events: [
        announcement(1, "/a"),
        announcement(2, "/a/b"),
        announcement(3, "/a/b/c"),
        announcement(4, "/c"),
        announcement(5, "/ab"),
      ],
    });
    expect(intermediateState.childPaths).toEqual(["/a/b"]);
  });

  it("rebuilds state by replaying committed events", () => {
    const state = reduceEvents({
      events: [
        {
          offset: 1,
          type: "events.iterate.com/stream/created",
          payload: { namespace: "default", path: "/agents" },
          createdAt: "2026-06-01T12:00:00.000Z",
        },
        {
          offset: 2,
          type: "events.iterate.com/stream/woken",
          payload: { incarnationId: "incarnation-1" },
          createdAt: "2026-06-01T12:00:00.001Z",
        },
        {
          offset: 3,
          type: "events.iterate.com/stream/child-stream-created",
          idempotencyKey: "child-stream-created:/agents:/agents/debug",
          payload: { childPath: "/agents/debug" },
          createdAt: "2026-06-01T12:00:01.000Z",
        },
      ],
    });

    expect(state).toMatchObject({
      namespace: "default",
      path: "/agents",
      incarnationId: "incarnation-1",
      eventCount: 3,
      maxOffset: 3,
      childPaths: ["/agents/debug"],
    });
  });

  it("catches up stored state from events after the stored max offset", () => {
    const stored = reduceEvents({
      events: [
        {
          offset: 1,
          type: "events.iterate.com/stream/created",
          payload: { namespace: "default", path: "/agents" },
          createdAt: "2026-06-01T12:00:00.000Z",
        },
        {
          offset: 2,
          type: "events.iterate.com/stream/woken",
          payload: { incarnationId: "incarnation-1" },
          createdAt: "2026-06-01T12:00:00.001Z",
        },
      ],
    });

    const state = reduceEvents({
      state: stored,
      events: [
        {
          offset: 1,
          type: "events.iterate.com/stream/created",
          payload: { namespace: "wrong", path: "/wrong" },
          createdAt: "2026-06-01T12:00:00.000Z",
        },
        {
          offset: 3,
          type: "events.iterate.com/stream/child-stream-created",
          idempotencyKey: "child-stream-created:/agents:/agents/debug",
          payload: { childPath: "/agents/debug" },
          createdAt: "2026-06-01T12:00:01.000Z",
        },
      ],
    });

    expect(state).toMatchObject({
      namespace: "default",
      path: "/agents",
      incarnationId: "incarnation-1",
      eventCount: 3,
      maxOffset: 3,
      childPaths: ["/agents/debug"],
    });
  });
});

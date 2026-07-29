import type { StreamEvent, StreamEventInput } from "iterate/processors";
import { describe, expect, test } from "vitest";
import { isStreamReceiverUnavailableError } from "iterate/processors";
import {
  CoreProcessorContract,
  MAX_SUBSCRIPTIONS_PER_RECEIVING_STREAM,
  type CoreProcessorState,
  type SubscriptionConfiguredPayload,
} from "./core-processor-contract.ts";
import {
  assertCoreProcessorCheckpointGrowthFits,
  compareSourceStamp,
  MAX_CORE_PROCESSOR_STATE_BYTES,
  MAX_INBOUND_SOURCE_RECORDS,
  StreamCoreProcessor,
} from "./core-processor.ts";
import { internalStreamId } from "./stream-delivery-utils.ts";

const PROJECT_ID = "prj_subscriptions_test";
const SOURCE_PATH = "/sources/issues";
const RECEIVER_PATH = "/agents/reviewer";
const SOURCE_CREATED_AT = "2026-07-21T11:00:00.000Z";
const SOURCE_STREAM_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_SOURCE_STREAM_ID = "22222222-2222-4222-8222-222222222222";

function streamSubscription(
  overrides: Partial<SubscriptionConfiguredPayload> = {},
): SubscriptionConfiguredPayload {
  return {
    subscriptionKey: "issues",
    description: "Receive issue events",
    filter: { eventTypes: ["example.com/issue-created"] },
    receiver: {
      action: "copy-to-stream",
      receivingStreamPath: RECEIVER_PATH,
      delivery: {
        start: "now",
        onFailingEvent: "halt",
      },
    },
    ...overrides,
  };
}

function coreState(path = RECEIVER_PATH): CoreProcessorState {
  return CoreProcessorContract.stateSchema.parse({ projectId: PROJECT_ID, path });
}

function committed(
  offset: number,
  type: string,
  payload: Record<string, unknown> = {},
  options: Pick<StreamEvent, "source" | "path"> = { path: RECEIVER_PATH },
): StreamEvent {
  return {
    type,
    payload,
    offset,
    createdAt: `2026-07-21T12:00:${String(offset).padStart(2, "0")}.000Z`,
    path: options.path,
    ...(options.source === undefined ? {} : { source: options.source }),
  };
}

/** A committed event copied from the fixture source with the given stamp. */
function copiedEvent(
  offset: number,
  stamp: {
    streamId?: string;
    streamCreatedAt?: string;
    cursorChangedAtSourceOffset?: number;
    subscriptionKey?: string;
    sourceOffset?: number;
    path?: string;
  } = {},
): StreamEvent {
  return committed(
    offset,
    "example.com/issue-created",
    { issue: offset },
    {
      path: RECEIVER_PATH,
      source: {
        copiedFrom: [
          {
            subscriptionKey: stamp.subscriptionKey ?? "issues",
            streamId: stamp.streamId ?? SOURCE_STREAM_ID,
            streamCreatedAt: stamp.streamCreatedAt ?? SOURCE_CREATED_AT,
            cursorChangedAtSourceOffset: stamp.cursorChangedAtSourceOffset ?? 2,
            createdAt: "2026-07-21T11:30:00.000Z",
            offset: stamp.sourceOffset ?? offset,
            path: stamp.path ?? SOURCE_PATH,
            projectId: PROJECT_ID,
            type: "example.com/issue-created",
          },
        ],
      },
    },
  );
}

function harness(path = RECEIVER_PATH) {
  return {
    processor: new StreamCoreProcessor({ projectId: PROJECT_ID }),
    state: coreState(path),
  };
}

function reduce(
  processor: StreamCoreProcessor,
  state: CoreProcessorState,
  event: StreamEvent,
): CoreProcessorState {
  return processor.reduce({ event, state });
}

describe("StreamCoreProcessor circuit-breaker accounting", () => {
  const at = "2026-07-21T12:00:00.000Z";
  const atMs = Date.parse(at);

  function stateWithBreaker(
    circuitBreaker: Partial<CoreProcessorState["circuitBreaker"]> = {},
  ): CoreProcessorState {
    return CoreProcessorContract.stateSchema.parse({
      ...coreState(),
      circuitBreaker: {
        availableTokens: 2,
        lastRefillAtMs: atMs,
        burstCapacity: 2,
        refillRatePerMinute: 60,
        trippedAtOffset: null,
        ...circuitBreaker,
      },
    });
  }

  test("charges each ordinary event once and preserves the first trip offset", () => {
    const { processor } = harness();
    const first = reduce(processor, stateWithBreaker(), {
      ...committed(1, "example.com/one"),
      createdAt: at,
    });
    const second = reduce(processor, first, {
      ...committed(2, "example.com/two"),
      createdAt: at,
    });
    const tripped = reduce(processor, second, {
      ...committed(3, "example.com/three"),
      createdAt: at,
    });
    const stillTripped = reduce(processor, tripped, {
      ...committed(4, "example.com/four"),
      createdAt: "2026-07-21T12:00:01.000Z",
    });

    expect(first.circuitBreaker.availableTokens).toBe(1);
    expect(second.circuitBreaker.availableTokens).toBe(0);
    expect(tripped.circuitBreaker).toMatchObject({
      availableTokens: -1,
      trippedAtOffset: 3,
    });
    expect(stillTripped.circuitBreaker).toMatchObject({
      availableTokens: -1,
      trippedAtOffset: 3,
    });
  });

  test("does not charge lifecycle/configuration controls and treats received controls as data", () => {
    const { processor } = harness();
    const initial = stateWithBreaker({ availableTokens: 1 });
    const woken = reduce(processor, initial, {
      ...committed(1, "events.iterate.com/stream/woken", { incarnationId: "inc_1" }),
      createdAt: "2026-07-21T12:00:01.000Z",
    });
    const configured = reduce(
      processor,
      woken,
      committed(2, "events.iterate.com/stream/configured", { config: {} }),
    );
    const paused = reduce(
      processor,
      configured,
      committed(3, "events.iterate.com/stream/paused", { reason: "operator" }),
    );
    const resumed = reduce(
      processor,
      paused,
      committed(4, "events.iterate.com/stream/resumed", { reason: "operator" }),
    );
    const reconfigured = reduce(
      processor,
      resumed,
      committed(5, "events.iterate.com/stream/configured", {
        config: { circuitBreaker: { burstCapacity: 5, refillRatePerMinute: 120 } },
      }),
    );
    const receivedWoken = reduce(processor, reconfigured, {
      ...committed(6, "events.iterate.com/stream/woken", { incarnationId: "untrusted-source" }),
      source: {
        copiedFrom: [
          {
            subscriptionKey: "issues",
            streamId: SOURCE_STREAM_ID,
            streamCreatedAt: SOURCE_CREATED_AT,
            cursorChangedAtSourceOffset: 2,
            createdAt: "2026-07-21T12:00:06.000Z",
            offset: 6,
            path: SOURCE_PATH,
            projectId: PROJECT_ID,
            type: "events.iterate.com/stream/woken",
          },
        ],
      },
    });
    const receivedPaused = reduce(processor, receivedWoken, {
      ...committed(7, "events.iterate.com/stream/paused", { reason: "untrusted source" }),
      createdAt: "2026-07-21T12:00:06.000Z",
      source: {
        copiedFrom: [
          {
            subscriptionKey: "issues",
            streamId: SOURCE_STREAM_ID,
            streamCreatedAt: SOURCE_CREATED_AT,
            cursorChangedAtSourceOffset: 2,
            createdAt: "2026-07-21T12:00:07.000Z",
            offset: 7,
            path: SOURCE_PATH,
            projectId: PROJECT_ID,
            type: "events.iterate.com/stream/paused",
          },
        ],
      },
    });

    expect(woken.circuitBreaker).toEqual(initial.circuitBreaker);
    expect(configured.circuitBreaker).toEqual(initial.circuitBreaker);
    expect(paused.circuitBreaker).toMatchObject({ availableTokens: 2, trippedAtOffset: null });
    expect(resumed.circuitBreaker).toMatchObject({ availableTokens: 2, trippedAtOffset: null });
    expect(reconfigured.circuitBreaker).toMatchObject({
      availableTokens: 5,
      burstCapacity: 5,
      refillRatePerMinute: 120,
      trippedAtOffset: null,
    });
    expect(receivedWoken.circuitBreaker.availableTokens).toBe(4);
    expect(receivedPaused.paused).toBe(false);
    expect(receivedPaused.circuitBreaker.availableTokens).toBe(3);
  });
});

describe("StreamCoreProcessor state size", () => {
  test("checks the initial stream identity before its birth event can commit", () => {
    const processor = new StreamCoreProcessor({ projectId: PROJECT_ID });
    const state = CoreProcessorContract.stateSchema.parse({});
    const event = committed(
      1,
      "events.iterate.com/stream/created",
      {
        projectId: PROJECT_ID,
        path: `/${"x".repeat(MAX_CORE_PROCESSOR_STATE_BYTES)}`,
        streamId: SOURCE_STREAM_ID,
      },
      { path: "/" },
    );
    const next = reduce(processor, state, event);

    expect(() =>
      assertCoreProcessorCheckpointGrowthFits({ before: state, events: [event], next }),
    ).toThrow(/core processor state.*checkpoint safety limit/i);
  });

  test("rejects one append batch whose retained state grows beyond checkpoint safety", () => {
    const { processor, state } = harness();
    const oversized = streamSubscription({
      description: "x".repeat(MAX_CORE_PROCESSOR_STATE_BYTES),
    });
    const event = committed(1, "events.iterate.com/stream/subscription-configured", oversized);
    const next = reduce(processor, state, event);

    expect(() =>
      assertCoreProcessorCheckpointGrowthFits({ before: state, events: [event], next }),
    ).toThrow(/core processor state.*checkpoint safety limit/i);
  });

  test("a copied event creating a first-contact inbound record runs the growth scan", () => {
    const { processor, state } = harness();
    const oversized = reduce(
      processor,
      state,
      committed(
        1,
        "events.iterate.com/stream/subscription-configured",
        streamSubscription({ description: "x".repeat(MAX_CORE_PROCESSOR_STATE_BYTES) }),
      ),
    );
    const firstContact = copiedEvent(2);
    const next = reduce(processor, oversized, firstContact);

    expect(() =>
      assertCoreProcessorCheckpointGrowthFits({ before: oversized, events: [firstContact], next }),
    ).toThrow(/core processor state.*checkpoint safety limit/i);

    // A copied event that only counts into the existing record stays
    // scan-free even when the state is already beyond the limit.
    const repeat = copiedEvent(3, { sourceOffset: 43 });
    expect(() =>
      assertCoreProcessorCheckpointGrowthFits({
        before: next,
        events: [repeat],
        next: reduce(processor, next, repeat),
      }),
    ).not.toThrow();
  });

  test("does not make fixed-shape lifecycle events scan or reject an already-large state", () => {
    const { processor, state } = harness();
    const configuredEvent = committed(
      1,
      "events.iterate.com/stream/subscription-configured",
      streamSubscription({ description: "x".repeat(MAX_CORE_PROCESSOR_STATE_BYTES) }),
    );
    const oversized = reduce(processor, state, configuredEvent);
    const wokenEvent = committed(2, "events.iterate.com/stream/woken", {
      incarnationId: "incarnation-2",
    });
    const woken = reduce(processor, oversized, wokenEvent);

    expect(() =>
      assertCoreProcessorCheckpointGrowthFits({
        before: oversized,
        events: [wokenEvent],
        next: woken,
      }),
    ).not.toThrow();
  });
});

describe("source stamp ordering", () => {
  const recorded = {
    streamId: SOURCE_STREAM_ID,
    streamCreatedAt: SOURCE_CREATED_AT,
    cursorChangedAtSourceOffset: 10,
  };

  test("orders by creation time, then random stream ID, then config generation", () => {
    expect(
      compareSourceStamp(
        {
          streamId: SECOND_SOURCE_STREAM_ID,
          streamCreatedAt: "2026-07-21T12:00:00.000Z",
          cursorChangedAtSourceOffset: 1,
        },
        recorded,
      ),
    ).toBeGreaterThan(0);
    expect(
      compareSourceStamp(
        {
          streamId: SECOND_SOURCE_STREAM_ID,
          streamCreatedAt: SOURCE_CREATED_AT,
          cursorChangedAtSourceOffset: 1,
        },
        recorded,
      ),
    ).toBeGreaterThan(0);
    expect(
      compareSourceStamp(
        {
          streamId: SOURCE_STREAM_ID,
          streamCreatedAt: SOURCE_CREATED_AT,
          cursorChangedAtSourceOffset: 11,
        },
        recorded,
      ),
    ).toBeGreaterThan(0);
    expect(compareSourceStamp(recorded, recorded)).toBe(0);
  });

  test("orders a source lifetime whose clock moved backwards as stale", () => {
    expect(
      compareSourceStamp(
        {
          streamId: SECOND_SOURCE_STREAM_ID,
          streamCreatedAt: "2026-07-21T10:59:59.999Z",
          cursorChangedAtSourceOffset: 100,
        },
        recorded,
      ),
    ).toBeLessThan(0);
  });
});

describe("StreamCoreProcessor stream-to-stream subscriptions", () => {
  test("requested removals must come from a public command", () => {
    const { processor } = harness(SOURCE_PATH);
    const state = reduce(
      processor,
      coreState(SOURCE_PATH),
      committed(2, "events.iterate.com/stream/subscription-configured", streamSubscription(), {
        path: SOURCE_PATH,
      }),
    );
    const removal: StreamEventInput = {
      type: "events.iterate.com/stream/subscription-removed",
      payload: { subscriptionKey: "issues", reason: "requested" },
    };

    expect(() => processor.validate({ event: removal, state, authority: "public" })).not.toThrow();
    expect(() => processor.validate({ event: removal, state, authority: "core-event" })).toThrow(
      /public command/,
    );
  });

  test("a paused receiver rejects copied product appends as unavailable", () => {
    const { processor, state } = harness();
    const paused = { ...state, paused: true, pauseReason: "operator boundary" };

    let productAppendError: unknown;
    try {
      processor.validate({
        event: { type: "example.com/product-event", payload: {} },
        state: paused,
        authority: "copy",
      });
    } catch (error) {
      productAppendError = error;
    }
    expect(isStreamReceiverUnavailableError(productAppendError)).toBe(true);
  });

  test("keeps the latest explicit read position in reduced state and clears it on replacement", () => {
    const { processor } = harness(SOURCE_PATH);
    let state = reduce(
      processor,
      coreState(SOURCE_PATH),
      committed(2, "events.iterate.com/stream/subscription-configured", streamSubscription(), {
        path: SOURCE_PATH,
      }),
    );
    state = reduce(
      processor,
      state,
      committed(
        3,
        "events.iterate.com/stream/subscription-cursor-set",
        { subscriptionKey: "issues", afterOffset: 1 },
        { path: SOURCE_PATH },
      ),
    );
    expect(state.subscriptions.outbound.byKey.issues?.cursorSet).toEqual({
      afterOffset: 1,
      setAtSourceOffset: 3,
    });

    state = reduce(
      processor,
      state,
      committed(4, "events.iterate.com/stream/subscription-configured", streamSubscription(), {
        path: SOURCE_PATH,
      }),
    );
    expect(state.subscriptions.outbound.byKey.issues?.cursorSet).toBeUndefined();
  });

  test("generates source-local keys and only lets their returned identity reuse the namespace", () => {
    const { processor } = harness(SOURCE_PATH);
    const { subscriptionKey: _omitted, ...keylessConfiguration } = streamSubscription();

    expect(() =>
      processor.validate({
        authority: "public",
        state: coreState(SOURCE_PATH),
        event: {
          type: "events.iterate.com/stream/subscription-configured",
          payload: {
            ...streamSubscription(),
            subscriptionKey: "subscription:caller-chosen",
          },
        },
      }),
    ).toThrow(/uses the generated-key namespace but does not name an existing/);

    let state = reduce(
      processor,
      coreState(SOURCE_PATH),
      committed(7, "events.iterate.com/stream/subscription-configured", keylessConfiguration, {
        path: SOURCE_PATH,
      }),
    );
    state = reduce(
      processor,
      state,
      committed(8, "events.iterate.com/stream/subscription-configured", keylessConfiguration, {
        path: SOURCE_PATH,
      }),
    );

    expect(Object.keys(state.subscriptions.outbound.byKey)).toEqual([
      "subscription:7",
      "subscription:8",
    ]);
    expect(
      state.subscriptions.outbound.byKey["subscription:7"]?.configuration.subscriptionKey,
    ).toBe("subscription:7");
    expect(
      state.subscriptions.outbound.byKey["subscription:8"]?.configuration.subscriptionKey,
    ).toBe("subscription:8");
    expect(state.subscriptions.outbound.byKey["subscription:7"]?.subscriptionKeyWasGenerated).toBe(
      true,
    );

    const replacementInput: StreamEventInput = {
      type: "events.iterate.com/stream/subscription-configured",
      payload: {
        ...keylessConfiguration,
        subscriptionKey: "subscription:7",
        description: "Move the generated subscription using its returned key",
      },
    };
    expect(() =>
      processor.validate({ authority: "public", state, event: replacementInput }),
    ).not.toThrow();
    const replacement = committed(9, replacementInput.type, replacementInput.payload, {
      path: SOURCE_PATH,
    });
    state = reduce(processor, state, replacement);
    expect(state.subscriptions.outbound.byKey["subscription:7"]).toMatchObject({
      configuredAtOffset: 9,
      subscriptionKeyWasGenerated: true,
      configuration: {
        subscriptionKey: "subscription:7",
        description: "Move the generated subscription using its returned key",
      },
    });
  });

  test("rejects explicit source read positions beyond the current stream head", () => {
    const { processor } = harness(SOURCE_PATH);
    const configured = reduce(
      processor,
      coreState(SOURCE_PATH),
      committed(1, "events.iterate.com/stream/subscription-configured", streamSubscription(), {
        path: SOURCE_PATH,
      }),
    );
    expect(() =>
      processor.validate({
        event: {
          type: "events.iterate.com/stream/subscription-cursor-set",
          payload: { subscriptionKey: "issues", afterOffset: configured.maxOffset + 1 },
        },
        state: configured,
        authority: "public",
      }),
    ).toThrow(/beyond this stream's current maximum offset/);
  });

  test("rejects a 65th subscription for one receiving stream", () => {
    const { processor } = harness(SOURCE_PATH);
    const receiver = streamSubscription().receiver;
    if (receiver.action !== "copy-to-stream") throw new Error("test fixture must target a stream");
    const sending = Object.fromEntries(
      Array.from({ length: MAX_SUBSCRIPTIONS_PER_RECEIVING_STREAM }, (_, index) => [
        `key-${index}`,
        {
          configuration: streamSubscription({
            subscriptionKey: `key-${index}`,
            receiver,
          }),
          configuredAtOffset: index + 1,
          configuredAt: "2026-07-21T12:00:00.000Z",
        },
      ]),
    );
    const full = CoreProcessorContract.stateSchema.parse({
      projectId: PROJECT_ID,
      path: SOURCE_PATH,
      subscriptions: {
        inbound: { bySourcePath: {} },
        outbound: { byKey: sending },
      },
    });

    expect(() =>
      processor.validate({
        event: {
          type: "events.iterate.com/stream/subscription-configured",
          payload: streamSubscription({ subscriptionKey: "one-too-many", receiver }),
        },
        state: full,
        authority: "public",
      }),
    ).toThrow(`at most ${MAX_SUBSCRIPTIONS_PER_RECEIVING_STREAM}`);

    expect(() =>
      processor.validate({
        event: {
          type: "events.iterate.com/stream/subscription-configured",
          payload: streamSubscription({ subscriptionKey: "key-0", receiver }),
        },
        state: full,
        authority: "public",
      }),
    ).not.toThrow();
  });
});

describe("passive inbound records", () => {
  test("the first copied event creates the record; later ones with the same stamp count into it", () => {
    const { processor } = harness();
    let state = reduce(processor, coreState(), copiedEvent(2, { sourceOffset: 41 }));
    expect(state.subscriptions.inbound.bySourcePath[SOURCE_PATH]?.issues).toEqual({
      streamId: SOURCE_STREAM_ID,
      streamCreatedAt: SOURCE_CREATED_AT,
      cursorChangedAtSourceOffset: 2,
      numEventsReceived: 1,
      lastEventReceivedAt: "2026-07-21T12:00:02.000Z",
    });

    state = reduce(processor, state, copiedEvent(3, { sourceOffset: 42 }));
    expect(state.subscriptions.inbound.bySourcePath[SOURCE_PATH]?.issues).toMatchObject({
      numEventsReceived: 2,
      lastEventReceivedAt: "2026-07-21T12:00:03.000Z",
    });
  });

  test("a newer config generation of the same lifetime updates the fence and keeps counting", () => {
    const { processor } = harness();
    let state = reduce(processor, coreState(), copiedEvent(2, { sourceOffset: 41 }));
    state = reduce(
      processor,
      state,
      copiedEvent(3, { cursorChangedAtSourceOffset: 9, sourceOffset: 12 }),
    );

    expect(state.subscriptions.inbound.bySourcePath[SOURCE_PATH]?.issues).toEqual({
      streamId: SOURCE_STREAM_ID,
      streamCreatedAt: SOURCE_CREATED_AT,
      cursorChangedAtSourceOffset: 9,
      numEventsReceived: 2,
      lastEventReceivedAt: "2026-07-21T12:00:03.000Z",
    });
  });

  test("a newer source lifetime replaces the record and restarts its counters", () => {
    const { processor } = harness();
    let state = reduce(processor, coreState(), copiedEvent(2, { sourceOffset: 41 }));
    state = reduce(processor, state, copiedEvent(3, { sourceOffset: 42 }));
    state = reduce(
      processor,
      state,
      copiedEvent(4, {
        streamId: SECOND_SOURCE_STREAM_ID,
        streamCreatedAt: "2026-07-21T12:00:00.000Z",
        cursorChangedAtSourceOffset: 2,
        sourceOffset: 3,
      }),
    );

    expect(state.subscriptions.inbound.bySourcePath[SOURCE_PATH]?.issues).toEqual({
      streamId: SECOND_SOURCE_STREAM_ID,
      streamCreatedAt: "2026-07-21T12:00:00.000Z",
      cursorChangedAtSourceOffset: 2,
      numEventsReceived: 1,
      lastEventReceivedAt: "2026-07-21T12:00:04.000Z",
    });
  });

  test("an older stamp on a replayed row never regresses the record", () => {
    const { processor } = harness();
    let state = reduce(
      processor,
      coreState(),
      copiedEvent(2, {
        streamId: SECOND_SOURCE_STREAM_ID,
        streamCreatedAt: "2026-07-21T12:00:00.000Z",
        sourceOffset: 3,
      }),
    );
    const record = state.subscriptions.inbound.bySourcePath[SOURCE_PATH]?.issues;
    state = reduce(
      processor,
      state,
      copiedEvent(3, {
        streamId: SOURCE_STREAM_ID,
        streamCreatedAt: SOURCE_CREATED_AT,
        sourceOffset: 44,
      }),
    );

    expect(state.subscriptions.inbound.bySourcePath[SOURCE_PATH]?.issues).toEqual(record);
  });

  test("keys from the same source path keep independent records", () => {
    const { processor } = harness();
    let state = reduce(processor, coreState(), copiedEvent(2, { sourceOffset: 41 }));
    state = reduce(
      processor,
      state,
      copiedEvent(3, {
        subscriptionKey: "other",
        cursorChangedAtSourceOffset: 7,
        sourceOffset: 41,
      }),
    );

    expect(state.subscriptions.inbound.bySourcePath[SOURCE_PATH]?.issues).toMatchObject({
      cursorChangedAtSourceOffset: 2,
      numEventsReceived: 1,
    });
    expect(state.subscriptions.inbound.bySourcePath[SOURCE_PATH]?.other).toMatchObject({
      cursorChangedAtSourceOffset: 7,
      numEventsReceived: 1,
    });
  });

  test("a copied stream control event is inert but still counts into the record", () => {
    const { processor } = harness();
    const state = reduce(processor, coreState(), {
      ...committed(2, "events.iterate.com/stream/paused", { reason: "untrusted source" }),
      source: {
        copiedFrom: [
          {
            subscriptionKey: "issues",
            streamId: SOURCE_STREAM_ID,
            streamCreatedAt: SOURCE_CREATED_AT,
            cursorChangedAtSourceOffset: 2,
            createdAt: "2026-07-21T11:30:00.000Z",
            offset: 41,
            path: SOURCE_PATH,
            projectId: PROJECT_ID,
            type: "events.iterate.com/stream/paused",
          },
        ],
      },
    });

    expect(state.paused).toBe(false);
    expect(state.subscriptions.inbound.bySourcePath[SOURCE_PATH]?.issues?.numEventsReceived).toBe(
      1,
    );
  });
});

describe("passive inbound record cap", () => {
  /**
   * A registry already holding MAX_INBOUND_SOURCE_RECORDS records, one per
   * filler source path. Filler 0 and 1 share the oldest receipt time so the
   * (source path, subscription key) tie-break is exercised; every filler is
   * older than the `committed()` fixture timestamps.
   */
  function fullState(): CoreProcessorState {
    return CoreProcessorContract.stateSchema.parse({
      ...coreState(),
      subscriptions: {
        inbound: {
          bySourcePath: Object.fromEntries(
            Array.from({ length: MAX_INBOUND_SOURCE_RECORDS }, (_, index) => [
              `/sources/filler-${String(index).padStart(4, "0")}`,
              {
                issues: {
                  streamId: SOURCE_STREAM_ID,
                  streamCreatedAt: SOURCE_CREATED_AT,
                  cursorChangedAtSourceOffset: 2,
                  numEventsReceived: 1,
                  lastEventReceivedAt: new Date(
                    Date.UTC(2026, 5, 1) + Math.max(0, index - 1) * 60_000,
                  ).toISOString(),
                },
              },
            ]),
          ),
        },
        outbound: { byKey: {} },
      },
    });
  }

  function recordCount(state: CoreProcessorState): number {
    return Object.values(state.subscriptions.inbound.bySourcePath).reduce(
      (sum, byKey) => sum + Object.keys(byKey).length,
      0,
    );
  }

  test("a first-contact record past the cap evicts the oldest record and never exceeds the cap", () => {
    const { processor } = harness();
    const state = reduce(processor, fullState(), copiedEvent(2, { sourceOffset: 41 }));

    expect(recordCount(state)).toBe(MAX_INBOUND_SOURCE_RECORDS);
    expect(state.subscriptions.inbound.bySourcePath[SOURCE_PATH]?.issues).toMatchObject({
      numEventsReceived: 1,
    });
    // Fillers 0 and 1 share the oldest receipt time; the (source path,
    // subscription key) tie-break evicts filler-0000, and deleting its last
    // record deletes the source path entry itself.
    expect(state.subscriptions.inbound.bySourcePath["/sources/filler-0000"]).toBeUndefined();
    expect(state.subscriptions.inbound.bySourcePath["/sources/filler-0001"]?.issues).toBeDefined();
  });

  test("eviction is deterministic under replay", () => {
    const { processor } = harness();
    const overflowing = [
      copiedEvent(2, { path: "/sources/new-a", sourceOffset: 41 }),
      copiedEvent(3, { path: "/sources/new-b", subscriptionKey: "other", sourceOffset: 7 }),
      copiedEvent(4, { path: "/sources/new-a", subscriptionKey: "other", sourceOffset: 9 }),
      copiedEvent(5, { path: "/sources/new-c", sourceOffset: 12 }),
    ];
    const first = overflowing.reduce(
      (state, event) => reduce(processor, state, event),
      fullState(),
    );
    const second = overflowing.reduce(
      (state, event) => reduce(processor, state, event),
      fullState(),
    );

    expect(recordCount(first)).toBe(MAX_INBOUND_SOURCE_RECORDS);
    expect(first).toEqual(second);
  });

  test("an evicted source's next copied event is accepted as first contact, even with an older stamp", () => {
    const { processor } = harness();
    const evictedPath = "/sources/filler-0000";
    let state = reduce(processor, fullState(), copiedEvent(2, { sourceOffset: 41 }));
    expect(state.subscriptions.inbound.bySourcePath[evictedPath]).toBeUndefined();

    // Strictly older than the coordinates the evicted record used to hold —
    // the fold would have skipped this stamp had the record survived. With the
    // record gone the source counts as never seen: graceful first-contact
    // degradation, not an error.
    state = reduce(
      processor,
      state,
      copiedEvent(3, { path: evictedPath, cursorChangedAtSourceOffset: 1, sourceOffset: 40 }),
    );

    expect(state.subscriptions.inbound.bySourcePath[evictedPath]?.issues).toEqual({
      streamId: SOURCE_STREAM_ID,
      streamCreatedAt: SOURCE_CREATED_AT,
      cursorChangedAtSourceOffset: 1,
      numEventsReceived: 1,
      lastEventReceivedAt: "2026-07-21T12:00:03.000Z",
    });
    expect(recordCount(state)).toBe(MAX_INBOUND_SOURCE_RECORDS);
  });
});

describe("StreamCoreProcessor validation and dispatch", () => {
  test.each([
    "copy",
    "copy-drop",
    "stream-paused",
    "child-stream-created",
    "filter-condition-failed",
    "subscription-failing-event-skipped",
    "project-creation-terminal",
    "project-worker-update",
  ])("public appends cannot use the platform-only %s idempotency-key family", (family) => {
    const { processor, state } = harness();
    expect(() =>
      processor.validate({
        event: {
          type: "example.com/issue-created",
          idempotencyKey: internalStreamId(family, "future-coordinate"),
        },
        state,
        authority: "public",
      }),
    ).toThrow("iterate-internal idempotency keys are platform-authored");
  });

  test("only the platform can append source.copiedFrom", () => {
    const { processor, state } = harness();
    const copied: StreamEventInput = {
      type: "example.com/issue-created",
      source: {
        copiedFrom: [
          {
            subscriptionKey: "issues",
            streamId: SOURCE_STREAM_ID,
            streamCreatedAt: SOURCE_CREATED_AT,
            cursorChangedAtSourceOffset: 3,
            createdAt: "2026-07-21T12:00:00.000Z",
            offset: 4,
            path: SOURCE_PATH,
            projectId: PROJECT_ID,
            type: "example.com/issue-created",
          },
        ],
      },
    };
    expect(() => processor.validate({ event: copied, state, authority: "public" })).toThrow(
      "copy source information is platform-authored",
    );
    expect(() => processor.validate({ event: copied, state, authority: "copy" })).not.toThrow();
  });

  test("rejects a subscription key longer than the contract bound", () => {
    const { processor } = harness(SOURCE_PATH);
    expect(() =>
      processor.validate({
        event: {
          type: "events.iterate.com/stream/subscription-configured",
          payload: streamSubscription({ subscriptionKey: "k".repeat(501) }),
        },
        state: coreState(SOURCE_PATH),
        authority: "public",
      }),
    ).toThrow(/500/);
  });

  test("rejects a stream subscribing to itself", () => {
    const { processor, state } = harness();
    expect(() =>
      processor.validate({
        event: {
          type: "events.iterate.com/stream/subscription-configured",
          payload: streamSubscription(),
        },
        state,
        authority: "public",
      }),
    ).toThrow("a stream cannot receive events from itself");
  });

  test("accepts a webhook subscription and folds its configuration", () => {
    const { processor, state } = harness(SOURCE_PATH);
    const payload = {
      subscriptionKey: "ops-webhook",
      receiver: {
        action: "webhook-post",
        url: "https://hooks.example.com/iterate/stream-events",
        delivery: { start: "now", onFailingEvent: "skip" },
      },
    };
    expect(() =>
      processor.validate({
        event: { type: "events.iterate.com/stream/subscription-configured", payload },
        state,
        authority: "public",
      }),
    ).not.toThrow();
    const reduced = reduce(
      processor,
      state,
      committed(1, "events.iterate.com/stream/subscription-configured", payload, {
        path: SOURCE_PATH,
      }),
    );
    expect(reduced.subscriptions.outbound.byKey["ops-webhook"]?.configuration.receiver).toEqual({
      action: "webhook-post",
      url: "https://hooks.example.com/iterate/stream-events",
      delivery: { start: "now", onFailingEvent: "skip" },
    });
  });

  test.each([
    ["not a URL at all", "hooks.example.com/iterate"],
    ["a non-http(s) protocol", "ftp://hooks.example.com/iterate"],
  ])("rejects a webhook subscription whose url is %s", (_case, url) => {
    const { processor, state } = harness(SOURCE_PATH);
    expect(() =>
      processor.validate({
        event: {
          type: "events.iterate.com/stream/subscription-configured",
          payload: {
            subscriptionKey: "ops-webhook",
            receiver: {
              action: "webhook-post",
              url,
              delivery: { start: "now", onFailingEvent: "halt" },
            },
          },
        },
        state,
        authority: "public",
      }),
    ).toThrow(/url/i);
  });

  test("rejects a webhook subscription on a stream without a project", () => {
    const processor = new StreamCoreProcessor({ projectId: null });
    const state = CoreProcessorContract.stateSchema.parse({ projectId: null, path: "/global" });
    expect(() =>
      processor.validate({
        event: {
          type: "events.iterate.com/stream/subscription-configured",
          payload: {
            subscriptionKey: "ops-webhook",
            receiver: {
              action: "webhook-post",
              url: "https://hooks.example.com/iterate",
              delivery: { start: "now", onFailingEvent: "halt" },
            },
          },
        },
        state,
        authority: "public",
      }),
    ).toThrow("webhook subscriptions require a project-scoped stream");
  });

  test.each([
    [
      "copy-to-stream",
      (jsonataTransform: string) => ({
        action: "copy-to-stream",
        receivingStreamPath: "/receivers/summaries",
        jsonataTransform,
        delivery: { start: "now", onFailingEvent: "halt" },
      }),
    ],
    [
      "itx-call",
      (jsonataTransform: string) => ({
        action: "itx-call",
        expression: ["worker", "processEventBatch"],
        jsonataTransform,
        delivery: { start: "now", onFailingEvent: "halt" },
      }),
    ],
    [
      "webhook-post",
      (jsonataTransform: string) => ({
        action: "webhook-post",
        url: "https://hooks.example.com/iterate",
        jsonataTransform,
        delivery: { start: "now", onFailingEvent: "halt" },
      }),
    ],
  ] as const)("parse-validates a %s jsonataTransform at configure time", (_action, receiver) => {
    const { processor, state } = harness(SOURCE_PATH);
    const payload = (jsonataTransform: string) => ({
      subscriptionKey: "transformed",
      receiver: receiver(jsonataTransform),
    });
    expect(() =>
      processor.validate({
        event: {
          type: "events.iterate.com/stream/subscription-configured",
          payload: payload("payload.((("),
        },
        state,
        authority: "public",
      }),
    ).toThrow(/invalid JSONata expression/);
    expect(() =>
      processor.validate({
        event: {
          type: "events.iterate.com/stream/subscription-configured",
          payload: payload('{ "payload": { "issue": payload.issue } }'),
        },
        state,
        authority: "public",
      }),
    ).not.toThrow();
  });

  test("a processor-wake receiver rejects a jsonataTransform outright", () => {
    // Wake delivery must feed the processor its committed log verbatim, or the
    // reduced state stops equaling a fold of the stream's events.
    const { processor, state } = harness(SOURCE_PATH);
    expect(() =>
      processor.validate({
        event: {
          type: "events.iterate.com/stream/subscription-configured",
          payload: {
            subscriptionKey: "wake-transformed",
            receiver: {
              action: "processor-wake",
              expression: [
                "agents",
                ["get", "/agents/reviewer"],
                "processor",
                "wakeStreamProcessor",
              ],
              jsonataTransform: '{ "payload": payload }',
            },
          },
        },
        state,
        authority: "public",
      }),
    ).toThrow(/unrecognized/i);
  });
});

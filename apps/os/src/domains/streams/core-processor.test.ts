import type { StreamEvent, StreamEventInput } from "iterate/processors";
import { describe, expect, test } from "vitest";
import { isStreamReceiverUnavailableError } from "iterate/processors";
import {
  CoreProcessorContract,
  MAX_SOURCE_STREAMS_PER_RECEIVING_STREAM,
  MAX_SUBSCRIPTIONS_PER_RECEIVING_STREAM,
  type CoreProcessorState,
  type CopyListRecordedPayload,
  type SubscriptionConfiguredPayload,
} from "./core-processor-contract.ts";
import {
  assertCoreProcessorCheckpointGrowthFits,
  compareSourceListPosition,
  MAX_CORE_PROCESSOR_STATE_BYTES,
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
        includeEphemeral: false,
      },
    },
    ...overrides,
  };
}

function subscriptionsFromSource(
  sourceOffset: number,
  subscriptionsByKey: CopyListRecordedPayload["subscriptionsByKey"] = {
    issues: {
      configuredAtSourceOffset: sourceOffset,
      configuration: {
        description: "Receive issue events",
        filter: { eventTypes: ["example.com/issue-created"] },
        delivery: {
          start: "now",
          onFailingEvent: "halt",
          includeEphemeral: false,
        },
      },
    },
  },
  streamCreatedAt = SOURCE_CREATED_AT,
  streamId = SOURCE_STREAM_ID,
): CopyListRecordedPayload {
  return {
    source: {
      projectId: PROJECT_ID,
      path: SOURCE_PATH,
      streamId,
      streamCreatedAt,
    },
    sourceOffset,
    subscriptionsByKey,
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

describe("source stream lifetime ordering", () => {
  const recorded = {
    source: {
      streamId: SOURCE_STREAM_ID,
      streamCreatedAt: SOURCE_CREATED_AT,
    },
    sourceOffset: 10,
  };

  test("orders by creation time, then random stream ID, then source offset", () => {
    expect(
      compareSourceListPosition(
        {
          streamId: SECOND_SOURCE_STREAM_ID,
          streamCreatedAt: "2026-07-21T12:00:00.000Z",
          sourceOffset: 1,
        },
        recorded,
      ),
    ).toBeGreaterThan(0);
    expect(
      compareSourceListPosition(
        {
          streamId: SECOND_SOURCE_STREAM_ID,
          streamCreatedAt: SOURCE_CREATED_AT,
          sourceOffset: 1,
        },
        recorded,
      ),
    ).toBeGreaterThan(0);
    expect(
      compareSourceListPosition(
        {
          streamId: SOURCE_STREAM_ID,
          streamCreatedAt: SOURCE_CREATED_AT,
          sourceOffset: 11,
        },
        recorded,
      ),
    ).toBeGreaterThan(0);
  });

  test("rejects a source lifetime whose clock moved backwards", () => {
    expect(
      compareSourceListPosition(
        {
          streamId: SECOND_SOURCE_STREAM_ID,
          streamCreatedAt: "2026-07-21T10:59:59.999Z",
          sourceOffset: 100,
        },
        recorded,
      ),
    ).toBeLessThan(0);
  });
});

describe("StreamCoreProcessor stream-to-stream subscriptions", () => {
  test("keeps requested removals public and automatic removals platform-authored", () => {
    const { processor } = harness(SOURCE_PATH);
    const state = reduce(
      processor,
      coreState(SOURCE_PATH),
      committed(2, "events.iterate.com/stream/subscription-configured", streamSubscription(), {
        path: SOURCE_PATH,
      }),
    );
    const removal = (reason: "requested" | "completed" | "expired"): StreamEventInput => ({
      type: "events.iterate.com/stream/subscription-removed",
      payload: { subscriptionKey: "issues", reason },
    });

    expect(() =>
      processor.validate({ event: removal("requested"), state, authority: "public" }),
    ).not.toThrow();
    expect(() =>
      processor.validate({ event: removal("requested"), state, authority: "core-event" }),
    ).toThrow(/public command/);

    for (const reason of ["completed", "expired"] as const) {
      expect(() =>
        processor.validate({ event: removal(reason), state, authority: "public" }),
      ).toThrow(/platform-authored/);
      expect(() =>
        processor.validate({ event: removal(reason), state, authority: "core-event" }),
      ).not.toThrow();
    }
  });

  test("a paused receiver still records source subscription changes", () => {
    const { processor } = harness();
    const configured = reduce(
      processor,
      coreState(),
      committed(2, "events.iterate.com/stream/copy-list-recorded", subscriptionsFromSource(5)),
    );
    const paused = { ...configured, paused: true, pauseReason: "operator boundary" };

    expect(() =>
      processor.validate({
        event: {
          type: "events.iterate.com/stream/copy-list-recorded",
          payload: subscriptionsFromSource(6, {}),
        },
        state: paused,
        authority: "copy-list",
      }),
    ).not.toThrow();

    expect(() =>
      processor.validate({
        event: {
          type: "events.iterate.com/stream/copy-list-recorded",
          payload: subscriptionsFromSource(6, {
            ...subscriptionsFromSource(5).subscriptionsByKey,
            newKey: subscriptionsFromSource(6).subscriptionsByKey.issues!,
          }),
        },
        state: paused,
        authority: "copy-list",
      }),
    ).not.toThrow();

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

  test("a blocked list is durable by receiving-stream path and only an explicit resend makes a new pending generation", () => {
    const { processor } = harness(SOURCE_PATH);
    let state = reduce(
      processor,
      coreState(SOURCE_PATH),
      committed(2, "events.iterate.com/stream/subscription-configured", streamSubscription(), {
        path: SOURCE_PATH,
      }),
    );
    expect(() =>
      processor.validate({
        event: {
          type: "events.iterate.com/stream/copy-list-resend-requested",
          payload: { receivingStreamPath: RECEIVER_PATH },
        },
        state,
        authority: "public",
      }),
    ).toThrow(/no blocked copy list/);
    state = reduce(
      processor,
      state,
      committed(3, "events.iterate.com/stream/copy-list-delivery-blocked", {
        receivingStreamPath: RECEIVER_PATH,
        sourceOffset: 2,
        attempts: 8,
        error: "receiver unavailable",
      }),
    );

    expect(state.subscriptions.outbound.byKey.issues?.deliveryHalted).toBeUndefined();
    expect(state.copyListDeliveriesByReceivingStream[RECEIVER_PATH]).toEqual({
      sourceOffset: 2,
      status: "blocked",
      attempts: 8,
      error: "receiver unavailable",
      blockedAt: "2026-07-21T12:00:03.000Z",
      subscriptionKeysRecordedByReceiver: [],
    });

    expect(() =>
      processor.validate({
        event: {
          type: "events.iterate.com/stream/subscription-delivery-resumed",
          payload: { subscriptionKey: "issues" },
        },
        state,
        authority: "public",
      }),
    ).toThrow(/not halted/);

    const retryRequest = committed(
      4,
      "events.iterate.com/stream/copy-list-resend-requested",
      { receivingStreamPath: RECEIVER_PATH },
      { path: SOURCE_PATH },
    );
    processor.validate({
      event: { type: retryRequest.type, payload: retryRequest.payload },
      state,
      authority: "public",
    });
    state = reduce(processor, state, retryRequest);
    expect(state.subscriptions.outbound.byKey.issues?.deliveryHalted).toBeUndefined();
    expect(state.copyListDeliveriesByReceivingStream[RECEIVER_PATH]).toEqual({
      sourceOffset: retryRequest.offset,
      status: "pending",
      subscriptionKeysRecordedByReceiver: [],
    });
    expect(() =>
      processor.validate({
        event: {
          type: "events.iterate.com/stream/copy-list-resend-requested",
          payload: { receivingStreamPath: RECEIVER_PATH },
        },
        state,
        authority: "public",
      }),
    ).toThrow(/no blocked copy list/);
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

  test("reduces source configuration and receiver copy into one bounded hierarchy", () => {
    const { processor } = harness(SOURCE_PATH);
    let sourceState = reduce(
      processor,
      coreState(SOURCE_PATH),
      committed(2, "events.iterate.com/stream/subscription-configured", streamSubscription(), {
        path: SOURCE_PATH,
      }),
    );
    expect(sourceState.subscriptions.outbound.byKey.issues).toMatchObject({
      configuredAtOffset: 2,
      configuration: streamSubscription(),
    });
    expect(sourceState.copyListDeliveriesByReceivingStream).toEqual({
      [RECEIVER_PATH]: {
        sourceOffset: 2,
        status: "pending",
        subscriptionKeysRecordedByReceiver: [],
      },
    });

    sourceState = reduce(
      processor,
      sourceState,
      committed(3, "events.iterate.com/stream/copy-list-confirmed", {
        receivingStreamPath: RECEIVER_PATH,
        sourceOffset: 2,
        receivingStreamEvent: committed(
          2,
          "events.iterate.com/stream/copy-list-recorded",
          subscriptionsFromSource(2),
        ),
      }),
    );
    expect(sourceState.copyListDeliveriesByReceivingStream[RECEIVER_PATH]).toEqual({
      sourceOffset: 2,
      status: "confirmed",
      subscriptionKeysRecordedByReceiver: ["issues"],
    });
    expect(() =>
      processor.validate({
        event: {
          type: "events.iterate.com/stream/copy-list-resend-requested",
          payload: { receivingStreamPath: RECEIVER_PATH },
        },
        state: sourceState,
        authority: "public",
      }),
    ).toThrow(/no blocked copy list/);

    const receiverState = reduce(
      processor,
      coreState(),
      committed(2, "events.iterate.com/stream/copy-list-recorded", subscriptionsFromSource(2)),
    );
    expect(receiverState.subscriptions.inbound.bySourcePath[SOURCE_PATH]).toEqual({
      source: {
        projectId: PROJECT_ID,
        path: SOURCE_PATH,
        streamId: SOURCE_STREAM_ID,
        streamCreatedAt: SOURCE_CREATED_AT,
      },
      sourceOffset: 2,
      byKey: {
        issues: {
          ...subscriptionsFromSource(2).subscriptionsByKey.issues,
          numEventsReceived: 0,
          numEventsDropped: 0,
        },
      },
    });
  });

  test("a complete replacement rejects delayed older lists, carries same-offset counters, and removes an empty source from reduced state", () => {
    const { processor } = harness();
    let state = reduce(
      processor,
      coreState(),
      committed(2, "events.iterate.com/stream/copy-list-recorded", subscriptionsFromSource(10)),
    );
    const copiedSource = {
      copiedFrom: [
        {
          subscriptionKey: "issues",
          streamId: SOURCE_STREAM_ID,
          streamCreatedAt: SOURCE_CREATED_AT,
          cursorChangedAtSourceOffset: 3,
          projectId: PROJECT_ID,
          path: SOURCE_PATH,
          offset: 11,
          type: "example.com/issue-created",
          createdAt: "2026-07-21T11:59:00.000Z",
        },
      ],
    };
    state = reduce(
      processor,
      state,
      committed(
        3,
        "example.com/issue-created",
        { issue: 42 },
        { path: RECEIVER_PATH, source: copiedSource },
      ),
    );
    state = reduce(
      processor,
      state,
      committed(4, "events.iterate.com/stream/copied-events-dropped", {
        source: {
          projectId: PROJECT_ID,
          path: SOURCE_PATH,
          streamId: SOURCE_STREAM_ID,
          streamCreatedAt: SOURCE_CREATED_AT,
        },
        subscriptionKey: "issues",
        reason: "cycle",
        count: 2,
        firstOffset: 12,
        lastOffset: 13,
      }),
    );

    state = reduce(
      processor,
      state,
      committed(
        5,
        "events.iterate.com/stream/copy-list-recorded",
        subscriptionsFromSource(12, {
          issues: {
            ...subscriptionsFromSource(10).subscriptionsByKey.issues!,
            configuredAtSourceOffset: 10,
          },
        }),
      ),
    );
    expect(state.subscriptions.inbound.bySourcePath[SOURCE_PATH]?.byKey.issues).toMatchObject({
      configuredAtSourceOffset: 10,
      numEventsReceived: 1,
      numEventsDropped: 2,
    });

    state = reduce(
      processor,
      state,
      committed(6, "events.iterate.com/stream/copy-list-recorded", subscriptionsFromSource(11, {})),
    );
    expect(state.subscriptions.inbound.bySourcePath[SOURCE_PATH]?.sourceOffset).toBe(12);

    state = reduce(
      processor,
      state,
      committed(7, "events.iterate.com/stream/copy-list-recorded", subscriptionsFromSource(13)),
    );
    expect(state.subscriptions.inbound.bySourcePath[SOURCE_PATH]?.byKey.issues).toMatchObject({
      configuredAtSourceOffset: 13,
      numEventsReceived: 0,
      numEventsDropped: 0,
    });

    state = reduce(
      processor,
      state,
      committed(8, "events.iterate.com/stream/copy-list-recorded", subscriptionsFromSource(14, {})),
    );
    expect(state.subscriptions.inbound.bySourcePath[SOURCE_PATH]).toBeUndefined();
  });

  test("a recreated source can restart its offsets, while delayed lists and copied events from the old source stay stale", () => {
    const { processor } = harness();
    const firstCreation = "2026-07-21T11:00:00.000Z";
    const secondCreation = "2026-07-21T12:00:00.000Z";
    let state = reduce(
      processor,
      coreState(),
      committed(
        2,
        "events.iterate.com/stream/copy-list-recorded",
        subscriptionsFromSource(40, undefined, firstCreation),
      ),
    );
    state = reduce(
      processor,
      state,
      committed(
        3,
        "example.com/issue-created",
        {},
        {
          path: RECEIVER_PATH,
          source: {
            copiedFrom: [
              {
                subscriptionKey: "issues",
                streamId: SOURCE_STREAM_ID,
                streamCreatedAt: firstCreation,
                cursorChangedAtSourceOffset: 3,
                projectId: PROJECT_ID,
                path: SOURCE_PATH,
                offset: 41,
                type: "example.com/issue-created",
                createdAt: "2026-07-21T11:30:00.000Z",
              },
            ],
          },
        },
      ),
    );
    expect(
      state.subscriptions.inbound.bySourcePath[SOURCE_PATH]?.byKey.issues?.numEventsReceived,
    ).toBe(1);

    state = reduce(
      processor,
      state,
      committed(
        4,
        "events.iterate.com/stream/copy-list-recorded",
        subscriptionsFromSource(2, undefined, secondCreation, SECOND_SOURCE_STREAM_ID),
      ),
    );
    expect(state.subscriptions.inbound.bySourcePath[SOURCE_PATH]).toMatchObject({
      source: {
        streamId: SECOND_SOURCE_STREAM_ID,
        streamCreatedAt: secondCreation,
      },
      sourceOffset: 2,
      byKey: { issues: { numEventsReceived: 0, numEventsDropped: 0 } },
    });

    state = reduce(
      processor,
      state,
      committed(
        5,
        "events.iterate.com/stream/copy-list-recorded",
        subscriptionsFromSource(50, undefined, firstCreation),
      ),
    );
    state = reduce(
      processor,
      state,
      committed(
        6,
        "example.com/issue-created",
        {},
        {
          path: RECEIVER_PATH,
          source: {
            copiedFrom: [
              {
                subscriptionKey: "issues",
                streamId: SOURCE_STREAM_ID,
                streamCreatedAt: firstCreation,
                cursorChangedAtSourceOffset: 3,
                projectId: PROJECT_ID,
                path: SOURCE_PATH,
                offset: 42,
                type: "example.com/issue-created",
                createdAt: "2026-07-21T11:45:00.000Z",
              },
            ],
          },
        },
      ),
    );
    expect(state.subscriptions.inbound.bySourcePath[SOURCE_PATH]).toMatchObject({
      source: {
        streamId: SECOND_SOURCE_STREAM_ID,
        streamCreatedAt: secondCreation,
      },
      sourceOffset: 2,
      byKey: { issues: { numEventsReceived: 0 } },
    });

    state = reduce(
      processor,
      state,
      committed(
        7,
        "example.com/issue-created",
        {},
        {
          path: RECEIVER_PATH,
          source: {
            copiedFrom: [
              {
                subscriptionKey: "issues",
                streamId: SECOND_SOURCE_STREAM_ID,
                streamCreatedAt: secondCreation,
                cursorChangedAtSourceOffset: 2,
                projectId: PROJECT_ID,
                path: SOURCE_PATH,
                offset: 3,
                type: "example.com/issue-created",
                createdAt: "2026-07-21T12:01:00.000Z",
              },
            ],
          },
        },
      ),
    );
    expect(
      state.subscriptions.inbound.bySourcePath[SOURCE_PATH]?.byKey.issues?.numEventsReceived,
    ).toBe(1);
  });

  test("A→B→C replacement keeps only the latest list to send to each receiver, then drops empty sends", () => {
    const { processor } = harness(SOURCE_PATH);
    const at = (path: string) =>
      streamSubscription({
        receiver: {
          action: "copy-to-stream",
          receivingStreamPath: path,
          delivery: {
            start: "now",
            onFailingEvent: "halt",
            includeEphemeral: false,
          },
        },
      });
    let state = coreState(SOURCE_PATH);
    for (const [offset, path] of [
      [2, "/agents/a"],
      [3, "/agents/b"],
      [4, "/agents/c"],
    ] as const) {
      state = reduce(
        processor,
        state,
        committed(offset, "events.iterate.com/stream/subscription-configured", at(path), {
          path: SOURCE_PATH,
        }),
      );
    }
    expect(state.copyListDeliveriesByReceivingStream).toEqual({
      "/agents/a": { sourceOffset: 3, status: "pending", subscriptionKeysRecordedByReceiver: [] },
      "/agents/b": { sourceOffset: 4, status: "pending", subscriptionKeysRecordedByReceiver: [] },
      "/agents/c": { sourceOffset: 4, status: "pending", subscriptionKeysRecordedByReceiver: [] },
    });

    for (const [offset, receivingStreamPath, sourceOffset] of [
      [5, "/agents/a", 3],
      [6, "/agents/b", 4],
      [7, "/agents/c", 4],
    ] as const) {
      state = reduce(
        processor,
        state,
        committed(offset, "events.iterate.com/stream/copy-list-confirmed", {
          receivingStreamPath,
          sourceOffset,
          receivingStreamEvent: committed(
            offset,
            "events.iterate.com/stream/copy-list-recorded",
            subscriptionsFromSource(
              sourceOffset,
              receivingStreamPath === "/agents/c"
                ? subscriptionsFromSource(sourceOffset).subscriptionsByKey
                : {},
            ),
            { path: receivingStreamPath },
          ),
        }),
      );
    }
    expect(state.copyListDeliveriesByReceivingStream).toEqual({
      "/agents/c": {
        sourceOffset: 4,
        status: "confirmed",
        subscriptionKeysRecordedByReceiver: ["issues"],
      },
    });
  });

  test("moving a recorded subscription waits durably for the old receiver and recovers after an explicit resend", () => {
    const { processor } = harness(SOURCE_PATH);
    const at = (path: string) =>
      streamSubscription({
        receiver: {
          action: "copy-to-stream",
          receivingStreamPath: path,
          delivery: {
            start: "now",
            onFailingEvent: "halt",
            includeEphemeral: false,
          },
        },
      });
    const recorded = (
      offset: number,
      receivingStreamPath: string,
      sourceOffset: number,
      subscriptionsByKey: CopyListRecordedPayload["subscriptionsByKey"],
    ) =>
      committed(
        offset,
        "events.iterate.com/stream/copy-list-confirmed",
        {
          receivingStreamPath,
          sourceOffset,
          receivingStreamEvent: committed(
            offset,
            "events.iterate.com/stream/copy-list-recorded",
            subscriptionsFromSource(sourceOffset, subscriptionsByKey),
            { path: receivingStreamPath },
          ),
        },
        { path: SOURCE_PATH },
      );

    let state = reduce(
      processor,
      coreState(SOURCE_PATH),
      committed(2, "events.iterate.com/stream/subscription-configured", at("/agents/a"), {
        path: SOURCE_PATH,
      }),
    );
    state = reduce(
      processor,
      state,
      recorded(3, "/agents/a", 2, subscriptionsFromSource(2).subscriptionsByKey),
    );
    expect(state.copyListDeliveriesByReceivingStream["/agents/a"]).toEqual({
      sourceOffset: 2,
      status: "confirmed",
      subscriptionKeysRecordedByReceiver: ["issues"],
    });

    state = reduce(
      processor,
      state,
      committed(4, "events.iterate.com/stream/subscription-configured", at("/agents/b"), {
        path: SOURCE_PATH,
      }),
    );
    expect(state.copyListDeliveriesByReceivingStream).toEqual({
      "/agents/a": {
        sourceOffset: 4,
        status: "pending",
        subscriptionKeysRecordedByReceiver: ["issues"],
      },
      "/agents/b": { sourceOffset: 4, status: "pending", subscriptionKeysRecordedByReceiver: [] },
    });

    state = reduce(
      processor,
      state,
      committed(
        5,
        "events.iterate.com/stream/copy-list-delivery-blocked",
        {
          receivingStreamPath: "/agents/a",
          sourceOffset: 4,
          attempts: 8,
          error: "old receiver unavailable",
        },
        { path: SOURCE_PATH },
      ),
    );
    expect(state.copyListDeliveriesByReceivingStream["/agents/a"]).toEqual({
      sourceOffset: 4,
      status: "blocked",
      attempts: 8,
      error: "old receiver unavailable",
      blockedAt: "2026-07-21T12:00:05.000Z",
      subscriptionKeysRecordedByReceiver: ["issues"],
    });

    const beforeStaleBlock = state;
    state = reduce(
      processor,
      state,
      committed(
        6,
        "events.iterate.com/stream/copy-list-delivery-blocked",
        {
          receivingStreamPath: "/agents/a",
          sourceOffset: 3,
          attempts: 8,
          error: "late failure for an older generation",
        },
        { path: SOURCE_PATH },
      ),
    );
    expect(state.copyListDeliveriesByReceivingStream).toEqual(
      beforeStaleBlock.copyListDeliveriesByReceivingStream,
    );

    const resend = committed(
      7,
      "events.iterate.com/stream/copy-list-resend-requested",
      { receivingStreamPath: "/agents/a" },
      { path: SOURCE_PATH },
    );
    processor.validate({
      event: { type: resend.type, payload: resend.payload },
      state,
      authority: "public",
    });
    state = reduce(processor, state, resend);
    expect(state.copyListDeliveriesByReceivingStream["/agents/a"]).toEqual({
      sourceOffset: 7,
      status: "pending",
      subscriptionKeysRecordedByReceiver: ["issues"],
    });

    state = reduce(
      processor,
      state,
      committed(
        8,
        "events.iterate.com/stream/copy-list-delivery-blocked",
        {
          receivingStreamPath: "/agents/a",
          sourceOffset: 4,
          attempts: 8,
          error: "late failure after resend",
        },
        { path: SOURCE_PATH },
      ),
    );
    expect(state.copyListDeliveriesByReceivingStream["/agents/a"]).toEqual({
      sourceOffset: 7,
      status: "pending",
      subscriptionKeysRecordedByReceiver: ["issues"],
    });

    state = reduce(processor, state, recorded(9, "/agents/a", 7, {}));
    expect(state.copyListDeliveriesByReceivingStream["/agents/a"]).toBeUndefined();
    expect(state.copyListDeliveriesByReceivingStream["/agents/b"]).toEqual({
      sourceOffset: 4,
      status: "pending",
      subscriptionKeysRecordedByReceiver: [],
    });

    state = reduce(
      processor,
      state,
      recorded(10, "/agents/b", 4, subscriptionsFromSource(4).subscriptionsByKey),
    );
    expect(state.copyListDeliveriesByReceivingStream).toEqual({
      "/agents/b": {
        sourceOffset: 4,
        status: "confirmed",
        subscriptionKeysRecordedByReceiver: ["issues"],
      },
    });
  });

  test("refreshes every stream whose last recorded list contains a removed or recreated key", () => {
    const { processor } = harness(SOURCE_PATH);
    const at = (path: string) =>
      streamSubscription({
        receiver: {
          action: "copy-to-stream",
          receivingStreamPath: path,
          delivery: {
            start: "now",
            onFailingEvent: "halt",
            includeEphemeral: false,
          },
        },
      });
    const recorded = (
      offset: number,
      receivingStreamPath: string,
      sourceOffset: number,
      subscriptionsByKey: CopyListRecordedPayload["subscriptionsByKey"],
    ) =>
      committed(
        offset,
        "events.iterate.com/stream/copy-list-confirmed",
        {
          receivingStreamPath,
          sourceOffset,
          receivingStreamEvent: committed(
            offset,
            "events.iterate.com/stream/copy-list-recorded",
            subscriptionsFromSource(sourceOffset, subscriptionsByKey),
            { path: receivingStreamPath },
          ),
        },
        { path: SOURCE_PATH },
      );

    let state = reduce(
      processor,
      coreState(SOURCE_PATH),
      committed(2, "events.iterate.com/stream/subscription-configured", at("/agents/a"), {
        path: SOURCE_PATH,
      }),
    );
    state = reduce(
      processor,
      state,
      recorded(3, "/agents/a", 2, subscriptionsFromSource(2).subscriptionsByKey),
    );
    state = reduce(
      processor,
      state,
      committed(4, "events.iterate.com/stream/subscription-configured", at("/agents/b"), {
        path: SOURCE_PATH,
      }),
    );
    state = reduce(
      processor,
      state,
      recorded(5, "/agents/b", 4, subscriptionsFromSource(4).subscriptionsByKey),
    );
    state = reduce(
      processor,
      state,
      committed(
        6,
        "events.iterate.com/stream/copy-list-delivery-blocked",
        {
          receivingStreamPath: "/agents/a",
          sourceOffset: 4,
          attempts: 8,
          error: "old receiver unavailable",
        },
        { path: SOURCE_PATH },
      ),
    );

    state = reduce(
      processor,
      state,
      committed(
        7,
        "events.iterate.com/stream/subscription-removed",
        { subscriptionKey: "issues", reason: "requested" },
        { path: SOURCE_PATH },
      ),
    );
    expect(state.copyListDeliveriesByReceivingStream).toEqual({
      "/agents/a": {
        sourceOffset: 7,
        status: "pending",
        subscriptionKeysRecordedByReceiver: ["issues"],
      },
      "/agents/b": {
        sourceOffset: 7,
        status: "pending",
        subscriptionKeysRecordedByReceiver: ["issues"],
      },
    });

    state = reduce(
      processor,
      state,
      committed(
        8,
        "events.iterate.com/stream/copy-list-delivery-blocked",
        {
          receivingStreamPath: "/agents/a",
          sourceOffset: 7,
          attempts: 8,
          error: "old receiver still unavailable",
        },
        { path: SOURCE_PATH },
      ),
    );
    state = reduce(processor, state, recorded(9, "/agents/b", 7, {}));
    expect(state.subscriptions.outbound.byKey.issues).toBeUndefined();
    expect(state.copyListDeliveriesByReceivingStream["/agents/a"]).toMatchObject({
      sourceOffset: 7,
      status: "blocked",
      subscriptionKeysRecordedByReceiver: ["issues"],
    });

    state = reduce(
      processor,
      state,
      committed(10, "events.iterate.com/stream/subscription-configured", at("/agents/c"), {
        path: SOURCE_PATH,
      }),
    );
    expect(state.copyListDeliveriesByReceivingStream).toEqual({
      "/agents/a": {
        sourceOffset: 10,
        status: "pending",
        subscriptionKeysRecordedByReceiver: ["issues"],
      },
      "/agents/c": {
        sourceOffset: 10,
        status: "pending",
        subscriptionKeysRecordedByReceiver: [],
      },
    });

    state = reduce(
      processor,
      state,
      recorded(11, "/agents/c", 10, subscriptionsFromSource(10).subscriptionsByKey),
    );
    expect(state.copyListDeliveriesByReceivingStream["/agents/c"]).toEqual({
      sourceOffset: 10,
      status: "confirmed",
      subscriptionKeysRecordedByReceiver: ["issues"],
    });
    state = reduce(processor, state, recorded(12, "/agents/a", 10, {}));
    expect(state.copyListDeliveriesByReceivingStream).toEqual({
      "/agents/c": {
        sourceOffset: 10,
        status: "confirmed",
        subscriptionKeysRecordedByReceiver: ["issues"],
      },
    });
  });

  test("bounds nonempty source lists while always allowing an empty cleanup list", () => {
    const { processor } = harness();
    const tooManyRecords = Object.fromEntries(
      Array.from({ length: MAX_SUBSCRIPTIONS_PER_RECEIVING_STREAM + 1 }, (_, index) => [
        `key-${index}`,
        subscriptionsFromSource(5).subscriptionsByKey.issues,
      ]),
    );
    expect(() =>
      processor.validate({
        event: {
          type: "events.iterate.com/stream/copy-list-recorded",
          payload: subscriptionsFromSource(5, tooManyRecords),
        },
        state: coreState(),
        authority: "copy-list",
      }),
    ).toThrow(`at most ${MAX_SUBSCRIPTIONS_PER_RECEIVING_STREAM}`);

    const receiving = Object.fromEntries(
      Array.from({ length: MAX_SOURCE_STREAMS_PER_RECEIVING_STREAM }, (_, index) => [
        `/source-${index}`,
        {
          source: {
            projectId: PROJECT_ID,
            path: `/source-${index}`,
            streamId: SOURCE_STREAM_ID,
            streamCreatedAt: SOURCE_CREATED_AT,
          },
          sourceOffset: 1,
          byKey: {},
        },
      ]),
    );
    const full = CoreProcessorContract.stateSchema.parse({
      projectId: PROJECT_ID,
      path: RECEIVER_PATH,
      subscriptions: {
        inbound: { bySourcePath: receiving },
        outbound: { byKey: {} },
      },
    });
    expect(() =>
      processor.validate({
        event: {
          type: "events.iterate.com/stream/copy-list-recorded",
          payload: {
            source: {
              projectId: PROJECT_ID,
              path: "/one-too-many",
              streamId: SOURCE_STREAM_ID,
              streamCreatedAt: SOURCE_CREATED_AT,
            },
            sourceOffset: 2,
            subscriptionsByKey: {},
          },
        },
        state: full,
        authority: "copy-list",
      }),
    ).not.toThrow();

    expect(() =>
      processor.validate({
        event: {
          type: "events.iterate.com/stream/copy-list-recorded",
          payload: {
            source: {
              projectId: PROJECT_ID,
              path: "/one-too-many",
              streamId: SOURCE_STREAM_ID,
              streamCreatedAt: SOURCE_CREATED_AT,
            },
            sourceOffset: 2,
            subscriptionsByKey: subscriptionsFromSource(2).subscriptionsByKey,
          },
        },
        state: full,
        authority: "copy-list",
      }),
    ).toThrow(`at most ${MAX_SOURCE_STREAMS_PER_RECEIVING_STREAM}`);
  });

  test("rejects explicit source read positions beyond the current stream head", () => {
    const { processor } = harness(SOURCE_PATH);
    const initialState = coreState(SOURCE_PATH);
    const futureStart = streamSubscription({
      receiver: {
        action: "copy-to-stream",
        receivingStreamPath: RECEIVER_PATH,
        delivery: {
          start: { afterOffset: initialState.maxOffset + 1 },
          onFailingEvent: "halt",
          includeEphemeral: false,
        },
      },
    });
    expect(() =>
      processor.validate({
        event: {
          type: "events.iterate.com/stream/subscription-configured",
          payload: futureStart,
        },
        state: initialState,
        authority: "public",
      }),
    ).toThrow(/beyond this stream's current maximum offset/);

    const configured = reduce(
      processor,
      initialState,
      committed(
        1,
        "events.iterate.com/stream/subscription-configured",
        streamSubscription({
          receiver: {
            action: "copy-to-stream",
            receivingStreamPath: RECEIVER_PATH,
            delivery: {
              start: "beginning",
              onFailingEvent: "halt",
              includeEphemeral: false,
            },
          },
        }),
        { path: SOURCE_PATH },
      ),
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

  test("rejects a 65th subscription before it can invalidate the receiver's stored set", () => {
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

describe("StreamCoreProcessor validation and dispatch", () => {
  test.each([
    "copy",
    "stream-paused",
    "child-stream-created",
    "copy-list-recorded",
    "copy-list-confirmed",
    "copy-event-dropped",
    "filter-condition-failed",
    "subscription-failing-event-skipped",
    "subscription-ended",
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

  test("only the platform can append copy lists, dropped-event records, or source.copiedFrom", () => {
    const { processor, state } = harness();
    const replacement: StreamEventInput = {
      type: "events.iterate.com/stream/copy-list-recorded",
      payload: subscriptionsFromSource(4),
    };
    expect(() => processor.validate({ event: replacement, state, authority: "public" })).toThrow(
      "copy lists from source streams are platform-authored",
    );
    expect(() =>
      processor.validate({ event: replacement, state, authority: "copy-list" }),
    ).not.toThrow();

    const stateWithRecordedSubscription = reduce(
      processor,
      state,
      committed(2, "events.iterate.com/stream/copy-list-recorded", subscriptionsFromSource(4)),
    );
    const dropping: StreamEventInput = {
      type: "events.iterate.com/stream/copied-events-dropped",
      payload: {
        source: {
          projectId: PROJECT_ID,
          path: SOURCE_PATH,
          streamId: SOURCE_STREAM_ID,
          streamCreatedAt: SOURCE_CREATED_AT,
        },
        subscriptionKey: "issues",
        reason: "cycle",
        count: 1,
        firstOffset: 4,
        lastOffset: 4,
      },
    };
    expect(() => processor.validate({ event: dropping, state, authority: "public" })).toThrow(
      "copy drop records are platform-authored",
    );
    expect(() =>
      processor.validate({
        event: dropping,
        state: stateWithRecordedSubscription,
        authority: "copy",
      }),
    ).not.toThrow();
    expect(() =>
      processor.validate({
        event: {
          type: "events.iterate.com/stream/copied-events-dropped",
          payload: {
            source: {
              projectId: PROJECT_ID,
              path: SOURCE_PATH,
              streamId: SECOND_SOURCE_STREAM_ID,
              streamCreatedAt: SOURCE_CREATED_AT,
            },
            subscriptionKey: "issues",
            reason: "cycle",
            count: 1,
            firstOffset: 4,
            lastOffset: 4,
          },
        },
        state: stateWithRecordedSubscription,
        authority: "copy",
      }),
    ).toThrow(
      'dropped events do not match the current subscription "issues" from "/sources/issues"',
    );

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
  });

  test("received events must match the receiver's current recorded source and subscription", () => {
    const { processor, state: initialState } = harness();
    const state = reduce(
      processor,
      initialState,
      committed(2, "events.iterate.com/stream/copy-list-recorded", subscriptionsFromSource(4)),
    );
    const copied: StreamEventInput = {
      type: "example.com/issue-created",
      source: {
        copiedFrom: [
          {
            subscriptionKey: "issues",
            streamId: SOURCE_STREAM_ID,
            streamCreatedAt: SOURCE_CREATED_AT,
            cursorChangedAtSourceOffset: 4,
            createdAt: "2026-07-21T12:00:00.000Z",
            offset: 5,
            path: SOURCE_PATH,
            projectId: PROJECT_ID,
            type: "example.com/issue-created",
          },
        ],
      },
    };

    expect(() => processor.validate({ event: copied, state, authority: "copy" })).not.toThrow();
    expect(() =>
      processor.validate({
        event: {
          ...copied,
          source: {
            copiedFrom: [
              {
                ...copied.source!.copiedFrom![0]!,
                streamId: SECOND_SOURCE_STREAM_ID,
              },
            ],
          },
        },
        state,
        authority: "copy",
      }),
    ).toThrow(
      'received event does not match the current subscription "issues" from "/sources/issues"',
    );
    expect(() =>
      processor.validate({
        event: { ...copied, source: { copiedFrom: [] } },
        state,
        authority: "copy",
      }),
    ).toThrow("received event has no source hop");
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

  test("hosted processors own their checkpoints and only allow time-based source completion", () => {
    const { processor, state } = harness(SOURCE_PATH);
    const hosted = streamSubscription({
      receiver: {
        action: "processor-wake",
        expression: ["agents", ["get", "/agent"], "processor", "wakeStreamProcessor"],
      },
      endWhen: { any: [{ kind: "time", at: "2026-07-22T00:00:00.000Z" }] },
    });
    expect(() =>
      processor.validate({
        event: {
          type: "events.iterate.com/stream/subscription-configured",
          payload: hosted,
        },
        state,
        authority: "public",
      }),
    ).not.toThrow();

    expect(() =>
      processor.validate({
        event: {
          type: "events.iterate.com/stream/subscription-configured",
          payload: {
            ...hosted,
            endWhen: { any: [{ kind: "acknowledged-events", count: 1 }] },
          },
        },
        state,
        authority: "public",
      }),
    ).toThrow("hosted processors own their checkpoint");
  });

  test("records every receiver list changed by configure/replace and retries by path", () => {
    const { processor } = harness(SOURCE_PATH);
    const at = (path: string) =>
      streamSubscription({
        receiver: {
          action: "copy-to-stream",
          receivingStreamPath: path,
          delivery: {
            start: "now",
            onFailingEvent: "halt",
            includeEphemeral: false,
          },
        },
      });
    let state = coreState(SOURCE_PATH);
    const first = committed(2, "events.iterate.com/stream/subscription-configured", at("/a"), {
      path: SOURCE_PATH,
    });
    state = reduce(processor, state, first);
    expect(state.copyListDeliveriesByReceivingStream).toMatchObject({
      "/a": { sourceOffset: 2, status: "pending", subscriptionKeysRecordedByReceiver: [] },
    });

    const replacement = committed(
      3,
      "events.iterate.com/stream/subscription-configured",
      at("/b"),
      {
        path: SOURCE_PATH,
      },
    );
    state = reduce(processor, state, replacement);
    expect(state.copyListDeliveriesByReceivingStream).toMatchObject({
      "/a": { sourceOffset: 3, status: "pending", subscriptionKeysRecordedByReceiver: [] },
      "/b": { sourceOffset: 3, status: "pending", subscriptionKeysRecordedByReceiver: [] },
    });

    state = reduce(
      processor,
      state,
      committed(
        4,
        "events.iterate.com/stream/copy-list-delivery-blocked",
        {
          receivingStreamPath: "/b",
          sourceOffset: 3,
          attempts: 8,
          error: "receiver unavailable",
        },
        { path: SOURCE_PATH },
      ),
    );
    const retryRequest = committed(
      5,
      "events.iterate.com/stream/copy-list-resend-requested",
      { receivingStreamPath: "/b" },
      { path: SOURCE_PATH },
    );
    processor.validate({
      event: { type: retryRequest.type, payload: retryRequest.payload },
      state,
      authority: "public",
    });
    state = reduce(processor, state, retryRequest);
    expect(state.copyListDeliveriesByReceivingStream).toMatchObject({
      "/a": { sourceOffset: 3, status: "pending", subscriptionKeysRecordedByReceiver: [] },
      "/b": { sourceOffset: 5, status: "pending", subscriptionKeysRecordedByReceiver: [] },
    });
  });
});

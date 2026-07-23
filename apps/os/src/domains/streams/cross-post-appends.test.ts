import {
  MAX_CROSS_POSTED_FROM_HOPS,
  StreamReceiverUnavailableError,
  type StreamDeliveryBatch,
  type StreamEvent,
} from "iterate/processors";
import { describe, expect, test } from "vitest";
import {
  recordedSubscriptionForCrossPost,
  type CoreProcessorState,
  type SubscriptionConfiguredPayload,
} from "./core-processor-contract.ts";
import { deliveryId } from "./delivery-math.ts";
import { buildCrossPostAppends } from "./cross-post-appends.ts";

const PROJECT_ID = "prj_stream_receiver";
const SOURCE_PATH = "/sources/issues";
const RECEIVER_PATH = "/agents/reviewer";
const FIRST_STREAM_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_STREAM_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_CREATED_AT = "2026-07-21T12:00:00.000Z";
const SELF = { projectId: PROJECT_ID, path: RECEIVER_PATH };

const configuration = {
  subscriptionKey: "issues",
  description: "Receive issue events",
  filter: { eventTypes: ["example.com/issue-created"] },
  receiver: {
    action: "cross-post",
    receivingStreamPath: RECEIVER_PATH,
    delivery: {
      start: "beginning",
      includeEphemeral: false,
      onFailingEvent: "halt",
    },
  },
} satisfies SubscriptionConfiguredPayload;

const sourceEvent = {
  type: "example.com/issue-created",
  payload: { issue: 42 },
  path: SOURCE_PATH,
  offset: 7,
  createdAt: "2026-07-21T12:05:00.000Z",
} satisfies StreamEvent;

type BuildArgs = Parameters<typeof buildCrossPostAppends>[0];

function batch(
  streamId = FIRST_STREAM_ID,
  streamCreatedAt = SOURCE_CREATED_AT,
  configured = configuration,
): StreamDeliveryBatch {
  return {
    projectId: PROJECT_ID,
    path: SOURCE_PATH,
    streamId,
    streamCreatedAt,
    events: [sourceEvent],
    streamMaxOffset: sourceEvent.offset,
    subscriptionKey: configured.subscriptionKey,
    cursorChangedAtSourceOffset: 2,
    deliveryId: deliveryId(
      streamId,
      configured.subscriptionKey,
      2,
      sourceEvent.offset,
      sourceEvent.offset,
    ),
    attempt: 1,
    configuredEvent: {
      type: "events.iterate.com/stream/subscription-configured",
      path: SOURCE_PATH,
      offset: 2,
      createdAt: "2026-07-21T12:01:00.000Z",
      payload: configured,
    },
  };
}

function recordedSource(
  args: {
    streamId?: string;
    streamCreatedAt?: string;
    configured?: SubscriptionConfiguredPayload;
  } = {},
): CoreProcessorState["subscriptions"]["inbound"]["bySourcePath"][string] {
  const configured = args.configured ?? configuration;
  return {
    source: {
      projectId: PROJECT_ID,
      path: SOURCE_PATH,
      streamId: args.streamId ?? FIRST_STREAM_ID,
      streamCreatedAt: args.streamCreatedAt ?? SOURCE_CREATED_AT,
    },
    sourceOffset: 2,
    byKey: {
      [configured.subscriptionKey!]: {
        configuration: recordedSubscriptionForCrossPost(configured),
        configuredAtSourceOffset: 2,
        numEventsReceived: 0,
        numEventsDropped: 0,
      },
    },
  };
}

function validArgs(
  delivery = batch(),
  source = recordedSource({
    streamId: delivery.streamId,
    streamCreatedAt: delivery.streamCreatedAt,
  }),
): BuildArgs {
  return { batch: delivery, self: SELF, source };
}

function caught(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("expected action to throw");
}

describe("cross-post input boundary", () => {
  test("builds accepted appends and a receipt from the receiver's recorded subscription", () => {
    const result = buildCrossPostAppends(validArgs());

    expect(result.receipt).toEqual({ accepted: 1, dropped: [] });
    expect(result.inputs).toHaveLength(1);
    expect(result.inputs[0]).toMatchObject({
      type: sourceEvent.type,
      payload: sourceEvent.payload,
      source: {
        crossPostedFrom: [
          {
            projectId: PROJECT_ID,
            path: SOURCE_PATH,
            streamId: FIRST_STREAM_ID,
            streamCreatedAt: SOURCE_CREATED_AT,
            offset: sourceEvent.offset,
            subscriptionKey: configuration.subscriptionKey,
          },
        ],
      },
    });
  });

  const malformedCases: Array<
    [name: string, mutate: (delivery: StreamDeliveryBatch) => StreamDeliveryBatch, message: RegExp]
  > = [
    ["empty event list", (delivery) => ({ ...delivery, events: [] }), /must contain/],
    ["invalid stream ID", (delivery) => ({ ...delivery, streamId: "not-a-uuid" }), /stream ID/],
    [
      "invalid stream creation time",
      (delivery) => ({ ...delivery, streamCreatedAt: "not-a-time" }),
      /creation time/,
    ],
    [
      "invalid stream maximum offset",
      (delivery) => ({ ...delivery, streamMaxOffset: 0 }),
      /maximum offset/,
    ],
    [
      "cursor before the stream",
      (delivery) => ({ ...delivery, cursorChangedAtSourceOffset: 0 }),
      /cursor-control event offset/,
    ],
    [
      "cursor beyond the stream",
      (delivery) => ({
        ...delivery,
        cursorChangedAtSourceOffset: delivery.streamMaxOffset + 1,
      }),
      /cursor-control event offset/,
    ],
    [
      "event from another path",
      (delivery) => ({
        ...delivery,
        events: [{ ...sourceEvent, path: "/another/source" }],
      }),
      /ordered source-stream events/,
    ],
    [
      "duplicate event offset",
      (delivery) => ({
        ...delivery,
        events: [
          { ...sourceEvent, offset: 6 },
          { ...sourceEvent, offset: 6 },
        ],
      }),
      /ordered source-stream events/,
    ],
    [
      "event beyond the source head",
      (delivery) => ({
        ...delivery,
        events: [{ ...sourceEvent, offset: delivery.streamMaxOffset + 1 }],
      }),
      /ordered source-stream events/,
    ],
  ];

  test.each(malformedCases)("rejects malformed batches: %s", (_name, mutate, message) => {
    const error = caught(() => buildCrossPostAppends(validArgs(mutate(batch()))));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(StreamReceiverUnavailableError);
    expect(error).toMatchObject({ message: expect.stringMatching(message) });
  });

  const unavailableCases: Array<[name: string, build: () => BuildArgs]> = [
    ["the source has no recorded subscriptions", () => ({ ...validArgs(), source: undefined })],
    [
      "the configured event names another source path",
      () => {
        const args = validArgs();
        args.batch.configuredEvent = { ...args.batch.configuredEvent, path: "/another/source" };
        return args;
      },
    ],
    [
      "the configured event offset does not match the recorded subscription",
      () => {
        const args = validArgs();
        args.batch.configuredEvent = { ...args.batch.configuredEvent, offset: 3 };
        return args;
      },
    ],
    [
      "the configured event names another subscription key",
      () => {
        const args = validArgs();
        args.batch.configuredEvent = {
          ...args.batch.configuredEvent,
          payload: { ...configuration, subscriptionKey: "another-subscription" },
        };
        return args;
      },
    ],
    [
      "the committed subscription does not cross-post to a stream",
      () => {
        const args = validArgs();
        args.batch.configuredEvent = {
          ...args.batch.configuredEvent,
          payload: {
            ...configuration,
            receiver: {
              action: "webhook-post",
              url: "https://example.com/events",
              delivery: {
                start: "beginning",
                includeEphemeral: false,
                onFailingEvent: "halt",
              },
            },
          },
        };
        return args;
      },
    ],
    [
      "the committed subscription names another receiving stream",
      () => {
        const args = validArgs();
        args.batch.configuredEvent = {
          ...args.batch.configuredEvent,
          payload: {
            ...configuration,
            receiver: {
              ...configuration.receiver,
              receivingStreamPath: "/agents/another",
            },
          },
        };
        return args;
      },
    ],
    [
      "the source project changed",
      () => ({
        ...validArgs(),
        source: {
          ...recordedSource(),
          source: { ...recordedSource().source, projectId: "prj_other" },
        },
      }),
    ],
    [
      "the source stream ID changed",
      () => ({
        ...validArgs(),
        source: {
          ...recordedSource(),
          source: { ...recordedSource().source, streamId: SECOND_STREAM_ID },
        },
      }),
    ],
    [
      "the source stream creation time changed",
      () => ({
        ...validArgs(),
        source: {
          ...recordedSource(),
          source: {
            ...recordedSource().source,
            streamCreatedAt: "2026-07-21T12:00:01.000Z",
          },
        },
      }),
    ],
    [
      "the cursor predates the configured event",
      () => {
        const args = validArgs();
        args.batch.cursorChangedAtSourceOffset = 1;
        return args;
      },
    ],
    [
      "the source replaced the subscription under the same key",
      () => {
        const args = validArgs();
        if (args.source === undefined) throw new Error("test setup requires a source");
        const recorded = args.source.byKey[configuration.subscriptionKey!];
        if (recorded === undefined) throw new Error("test setup requires a subscription");
        recorded.configuration = { ...recorded.configuration, description: "Replacement" };
        return args;
      },
    ],
  ];

  test.each(unavailableCases)("reports receiver unavailability when %s", (_name, build) => {
    const error = caught(() => buildCrossPostAppends(build()));
    expect(error).toBeInstanceOf(StreamReceiverUnavailableError);
  });
});

describe("cross-post event construction", () => {
  test("transport retries dedupe within one source lifetime, while a recreated source is new", () => {
    const firstBatch = batch(FIRST_STREAM_ID);
    const recreatedBatch = batch(SECOND_STREAM_ID);
    const first = buildCrossPostAppends(validArgs(firstBatch));
    const retry = buildCrossPostAppends(validArgs(firstBatch));
    const recreated = buildCrossPostAppends(validArgs(recreatedBatch));

    expect(first.inputs[0]?.idempotencyKey).toBe(retry.inputs[0]?.idempotencyKey);
    expect(recreated.inputs[0]?.idempotencyKey).not.toBe(first.inputs[0]?.idempotencyKey);
    expect(recreatedBatch.deliveryId).not.toBe(firstBatch.deliveryId);
    expect(recreated.inputs[0]?.source?.crossPostedFrom?.at(-1)).toMatchObject({
      projectId: PROJECT_ID,
      path: SOURCE_PATH,
      streamId: SECOND_STREAM_ID,
      streamCreatedAt: SOURCE_CREATED_AT,
      offset: sourceEvent.offset,
      subscriptionKey: configuration.subscriptionKey,
    });
  });

  test("commits accepted events before deterministic cycle-suppression events", () => {
    const crossPostedFrom = {
      subscriptionKey: "prior-subscription",
      streamId: SECOND_STREAM_ID,
      streamCreatedAt: SOURCE_CREATED_AT,
      cursorChangedAtSourceOffset: 1,
      createdAt: "2026-07-21T12:04:00.000Z",
      offset: 1,
      path: RECEIVER_PATH,
      projectId: PROJECT_ID,
      type: "example.com/prior",
    };
    const delivery = {
      ...batch(),
      events: [
        { ...sourceEvent, offset: 6 },
        { ...sourceEvent, source: { crossPostedFrom: [crossPostedFrom] } },
      ],
    } satisfies StreamDeliveryBatch;

    const first = buildCrossPostAppends(validArgs(delivery));
    const retry = buildCrossPostAppends(validArgs(delivery));

    expect(first.receipt).toEqual({ accepted: 1, dropped: [{ offset: 7, reason: "cycle" }] });
    expect(first.inputs).toHaveLength(2);
    expect(first.inputs[0]?.type).toBe(sourceEvent.type);
    expect(first.inputs[1]).toMatchObject({
      type: "events.iterate.com/stream/cross-posted-events-dropped",
      payload: {
        source: {
          projectId: PROJECT_ID,
          path: SOURCE_PATH,
          streamId: FIRST_STREAM_ID,
          streamCreatedAt: SOURCE_CREATED_AT,
        },
        subscriptionKey: configuration.subscriptionKey,
        reason: "cycle",
        count: 1,
        firstOffset: 7,
        lastOffset: 7,
      },
    });
    expect(first.inputs[1]?.idempotencyKey).toBe(retry.inputs[1]?.idempotencyKey);
  });

  test("durably drops a received-from chain at the hop cap instead of retrying it", () => {
    const crossPostedFrom = Array.from({ length: MAX_CROSS_POSTED_FROM_HOPS }, (_, index) => ({
      subscriptionKey: `subscription-${index}`,
      streamId: SECOND_STREAM_ID,
      streamCreatedAt: SOURCE_CREATED_AT,
      cursorChangedAtSourceOffset: 1,
      createdAt: "2026-07-21T12:04:00.000Z",
      offset: index + 1,
      path: `/intermediate/${index}`,
      projectId: PROJECT_ID,
      type: "example.com/prior",
    }));
    const delivery = {
      ...batch(),
      events: [{ ...sourceEvent, source: { crossPostedFrom } }],
    } satisfies StreamDeliveryBatch;

    const result = buildCrossPostAppends(validArgs(delivery));

    expect(result.receipt).toEqual({
      accepted: 0,
      dropped: [{ offset: sourceEvent.offset, reason: "hop-limit" }],
    });
    expect(result.inputs).toHaveLength(1);
    expect(result.inputs[0]).toMatchObject({
      type: "events.iterate.com/stream/cross-posted-events-dropped",
      payload: {
        subscriptionKey: configuration.subscriptionKey,
        reason: "hop-limit",
        count: 1,
        firstOffset: sourceEvent.offset,
        lastOffset: sourceEvent.offset,
      },
    });
  });

  test("applies the recorded transform and never propagates ephemeral", () => {
    const transformed = {
      ...configuration,
      receiver: {
        ...configuration.receiver,
        transform:
          '{"type":"example.com/transformed","payload":{"issue":payload.issue + 1},"metadata":{"via":"receiver"}}',
      },
    } satisfies SubscriptionConfiguredPayload;
    const delivery = batch(FIRST_STREAM_ID, SOURCE_CREATED_AT, transformed);
    delivery.events = [{ ...sourceEvent, ephemeral: true }];
    const source = recordedSource({ configured: transformed });

    const result = buildCrossPostAppends(validArgs(delivery, source));

    expect(result.inputs[0]).toMatchObject({
      type: "example.com/transformed",
      payload: { issue: 43 },
      metadata: { via: "receiver" },
    });
    expect(result.inputs[0]).not.toHaveProperty("ephemeral");
  });

  test("an omitted transform field keeps the original event field", () => {
    const transformed = {
      ...configuration,
      receiver: {
        ...configuration.receiver,
        transform: '{"payload":{"issue":payload.issue + 1}}',
      },
    } satisfies SubscriptionConfiguredPayload;
    const result = buildCrossPostAppends(
      validArgs(
        batch(FIRST_STREAM_ID, SOURCE_CREATED_AT, transformed),
        recordedSource({ configured: transformed }),
      ),
    );

    expect(result.inputs[0]).toMatchObject({
      type: sourceEvent.type,
      payload: { issue: 43 },
    });
  });

  test.each([
    ["returns an unknown field", '{"unexpected":true}', /unrecognized key/i],
    [
      "throws while evaluating",
      '$error("synthetic transform failure")',
      /synthetic transform failure/,
    ],
  ])("rejects a transform that %s", (_name, transform, expectedError) => {
    const transformed = {
      ...configuration,
      receiver: { ...configuration.receiver, transform },
    } satisfies SubscriptionConfiguredPayload;

    expect(() =>
      buildCrossPostAppends(
        validArgs(
          batch(FIRST_STREAM_ID, SOURCE_CREATED_AT, transformed),
          recordedSource({ configured: transformed }),
        ),
      ),
    ).toThrow(expectedError);
  });
});

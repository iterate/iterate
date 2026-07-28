import {
  MAX_COPIED_FROM_HOPS,
  type StreamDeliveryBatch,
  type StreamEvent,
} from "iterate/processors";
import { describe, expect, test } from "vitest";
import type {
  CoreProcessorState,
  SubscriptionConfiguredPayload,
} from "./core-processor-contract.ts";
import { deliveryId } from "./delivery-math.ts";
import { buildCopyAppends } from "./copy-appends.ts";

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
    action: "copy-to-stream",
    receivingStreamPath: RECEIVER_PATH,
    delivery: {
      start: "beginning",
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

type BuildArgs = Parameters<typeof buildCopyAppends>[0];
type InboundRecords = NonNullable<BuildArgs["inbound"]>;

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

function recordedInbound(
  args: {
    streamId?: string;
    streamCreatedAt?: string;
    cursorChangedAtSourceOffset?: number;
  } = {},
): InboundRecords {
  return {
    [configuration.subscriptionKey]: {
      streamId: args.streamId ?? FIRST_STREAM_ID,
      streamCreatedAt: args.streamCreatedAt ?? SOURCE_CREATED_AT,
      cursorChangedAtSourceOffset: args.cursorChangedAtSourceOffset ?? 2,
      numEventsReceived: 3,
      lastEventReceivedAt: "2026-07-21T12:04:00.000Z",
    },
  } satisfies CoreProcessorState["subscriptions"]["inbound"]["bySourcePath"][string];
}

function validArgs(delivery = batch(), inbound?: InboundRecords): BuildArgs {
  return { batch: delivery, self: SELF, inbound };
}

function caught(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("expected action to throw");
}

describe("copy input boundary", () => {
  test("builds appends and a receipt with no prior inbound record (first contact)", () => {
    const result = buildCopyAppends(validArgs());

    expect(result.receipt).toEqual({ acknowledged: 1 });
    expect(result.inputs).toHaveLength(1);
    expect(result.inputs[0]).toMatchObject({
      type: sourceEvent.type,
      payload: sourceEvent.payload,
      source: {
        copiedFrom: [
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
    const error = caught(() => buildCopyAppends(validArgs(mutate(batch()))));
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: expect.stringMatching(message) });
  });

  const misaddressedCases: Array<[name: string, build: () => BuildArgs]> = [
    [
      "the configured event names another source path",
      () => {
        const args = validArgs();
        args.batch.configuredEvent = { ...args.batch.configuredEvent, path: "/another/source" };
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
      "the cursor predates the configured event",
      () => {
        const args = validArgs();
        args.batch.cursorChangedAtSourceOffset = 1;
        return args;
      },
    ],
  ];

  test.each(misaddressedCases)("rejects a batch when %s", (_name, build) => {
    const error = caught(() => buildCopyAppends(build()));
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: expect.stringMatching(/does not address receiver/) });
  });
});

describe("the inbound stamp fence", () => {
  test("rejects a batch from an older source lifetime than the recorded one", () => {
    const stale = batch(FIRST_STREAM_ID, SOURCE_CREATED_AT);
    const inbound = recordedInbound({
      streamId: SECOND_STREAM_ID,
      streamCreatedAt: "2026-07-21T12:30:00.000Z",
    });

    const error = caught(() => buildCopyAppends(validArgs(stale, inbound)));
    expect(error).toMatchObject({
      message: expect.stringMatching(/already accepted a newer delivery/),
    });
  });

  test("rejects a same-createdAt lifetime whose random stream ID lost the tie", () => {
    const stale = batch(FIRST_STREAM_ID, SOURCE_CREATED_AT);
    const inbound = recordedInbound({ streamId: SECOND_STREAM_ID });

    const error = caught(() => buildCopyAppends(validArgs(stale, inbound)));
    expect(error).toMatchObject({
      message: expect.stringMatching(/already accepted a newer delivery/),
    });
  });

  test("rejects an older config generation of the same lifetime", () => {
    const delivery = batch();
    delivery.cursorChangedAtSourceOffset = 3;
    delivery.configuredEvent = { ...delivery.configuredEvent, offset: 3 };
    const inbound = recordedInbound({ cursorChangedAtSourceOffset: 5 });

    const error = caught(() => buildCopyAppends(validArgs(delivery, inbound)));
    expect(error).toMatchObject({
      message: expect.stringMatching(/already accepted a newer delivery/),
    });
  });

  test("accepts an equal stamp (transport redelivery) and a strictly newer one", () => {
    const equal = buildCopyAppends(validArgs(batch(), recordedInbound()));
    expect(equal.receipt).toEqual({ acknowledged: 1 });

    const newerLifetime = buildCopyAppends(
      validArgs(batch(SECOND_STREAM_ID, "2026-07-21T13:00:00.000Z"), recordedInbound()),
    );
    expect(newerLifetime.receipt).toEqual({ acknowledged: 1 });
    expect(newerLifetime.inputs[0]?.source?.copiedFrom?.at(-1)).toMatchObject({
      streamId: SECOND_STREAM_ID,
      streamCreatedAt: "2026-07-21T13:00:00.000Z",
    });

    const newerGeneration = batch();
    newerGeneration.cursorChangedAtSourceOffset = 6;
    expect(
      buildCopyAppends(
        validArgs(newerGeneration, recordedInbound({ cursorChangedAtSourceOffset: 5 })),
      ).receipt,
    ).toEqual({ acknowledged: 1 });
  });
});

describe("copy event construction", () => {
  test("transport retries dedupe within one source lifetime, while a recreated source is new", () => {
    const firstBatch = batch(FIRST_STREAM_ID);
    const recreatedBatch = batch(SECOND_STREAM_ID);
    const first = buildCopyAppends(validArgs(firstBatch));
    const retry = buildCopyAppends(validArgs(firstBatch));
    const recreated = buildCopyAppends(validArgs(recreatedBatch));

    expect(first.inputs[0]?.idempotencyKey).toBe(retry.inputs[0]?.idempotencyKey);
    expect(recreated.inputs[0]?.idempotencyKey).not.toBe(first.inputs[0]?.idempotencyKey);
    expect(recreatedBatch.deliveryId).not.toBe(firstBatch.deliveryId);
    expect(recreated.inputs[0]?.source?.copiedFrom?.at(-1)).toMatchObject({
      projectId: PROJECT_ID,
      path: SOURCE_PATH,
      streamId: SECOND_STREAM_ID,
      streamCreatedAt: SOURCE_CREATED_AT,
      offset: sourceEvent.offset,
      subscriptionKey: configuration.subscriptionKey,
    });
  });

  test("never propagates ephemeral onto the received copy", () => {
    const delivery = batch();
    delivery.events = [{ ...sourceEvent, ephemeral: true }];

    const result = buildCopyAppends(validArgs(delivery));

    expect(result.inputs[0]).toMatchObject({ type: sourceEvent.type });
    expect(result.inputs[0]).not.toHaveProperty("ephemeral");
  });

  test("a cycle drop acknowledges the whole batch and appends one idempotent error event", () => {
    const copiedFrom = {
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
        { ...sourceEvent, source: { copiedFrom: [copiedFrom] } },
      ],
    } satisfies StreamDeliveryBatch;

    const first = buildCopyAppends(validArgs(delivery));
    const retry = buildCopyAppends(validArgs(delivery));

    // Both events are terminally acknowledged: the accepted copy and the
    // dropped cycle. The sender advances its cursor past the whole batch.
    expect(first.receipt).toEqual({ acknowledged: 2 });
    expect(first.inputs).toHaveLength(2);
    expect(first.inputs[0]?.type).toBe(sourceEvent.type);
    expect(first.inputs[1]).toMatchObject({
      type: "events.iterate.com/stream/error-occurred",
      payload: {
        message: expect.stringContaining(
          `dropped 1 copied event(s) from "${SOURCE_PATH}" subscription "${configuration.subscriptionKey}"`,
        ),
      },
    });
    expect(first.inputs[1]?.payload).toMatchObject({
      message: expect.stringContaining("offsets 7-7"),
    });
    expect(first.inputs[1]?.idempotencyKey).toBe(retry.inputs[1]?.idempotencyKey);
  });

  test("durably drops a received-from chain at the hop cap instead of retrying it", () => {
    const copiedFrom = Array.from({ length: MAX_COPIED_FROM_HOPS }, (_, index) => ({
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
      events: [{ ...sourceEvent, source: { copiedFrom } }],
    } satisfies StreamDeliveryBatch;

    const result = buildCopyAppends(validArgs(delivery));

    expect(result.receipt).toEqual({ acknowledged: 1 });
    expect(result.inputs).toHaveLength(1);
    expect(result.inputs[0]).toMatchObject({
      type: "events.iterate.com/stream/error-occurred",
      payload: {
        message: expect.stringContaining(`reached ${MAX_COPIED_FROM_HOPS} hops`),
      },
    });
  });
});

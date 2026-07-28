import { STREAM_PROCESSOR_REVIVED_EVENT_TYPE, type StreamEvent } from "iterate/processors";
import { describe, expect, test } from "vitest";
import {
  CORE_STATE_VERSION,
  CoreProcessorContract,
  type CoreProcessorState,
} from "./core-processor-contract.ts";
import { StreamCoreProcessor } from "./core-processor.ts";

const PROJECT_ID = "prj_core_replay";
const STREAM_PATH = "/";
const RECEIVING_STREAM_PATH = "/agents/reviewer";
const SOURCE_PATH = "/sources/issues";
const STREAM_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_STREAM_ID = "22222222-2222-4222-8222-222222222222";
const STREAM_CREATED_AT = "2026-07-21T12:00:00.000Z";
const SOURCE_STREAM_CREATED_AT = "2026-07-21T11:00:00.000Z";
const SUBSCRIPTION_KEY = "issues";

function committed(offset: number, type: string, payload: Record<string, unknown>): StreamEvent {
  return {
    type,
    payload,
    offset,
    createdAt: `2026-07-21T12:00:${String(offset).padStart(2, "0")}.000Z`,
    path: STREAM_PATH,
  };
}

const recordedSubscriptions = {
  [SUBSCRIPTION_KEY]: {
    configuredAtSourceOffset: 5,
    configuration: {
      description: "Receive issue events",
      filter: {
        eventTypes: ["example.com/issue-created"],
        condition: "payload.issue != null",
      },
      endWhen: { any: [{ kind: "acknowledged-events" as const, count: 10 }] },
      delivery: {
        start: "beginning" as const,
        onFailingEvent: "halt" as const,
        includeEphemeral: false,
      },
      transform: "$",
    },
  },
};

/**
 * One literal committed event for every event type owned by the version-27
 * core contract. These are deliberately not produced from the schemas: a
 * schema edit must either keep this exact event history replayable or require
 * an intentional state-version/cutover decision and fixture update.
 */
const VERSION_27_COMMITTED_EVENTS: StreamEvent[] = [
  committed(1, "events.iterate.com/stream/created", {
    projectId: PROJECT_ID,
    path: STREAM_PATH,
    streamId: STREAM_ID,
  }),
  committed(2, "events.iterate.com/stream/woken", { incarnationId: "incarnation-1" }),
  committed(3, "events.iterate.com/stream/configured", {
    config: { circuitBreaker: { burstCapacity: 1_000, refillRatePerMinute: 60_000 } },
  }),
  committed(4, "events.iterate.com/stream/child-stream-created", {
    childPath: "/children/one",
  }),
  committed(5, "events.iterate.com/stream/subscription-configured", {
    subscriptionKey: SUBSCRIPTION_KEY,
    description: "Receive issue events",
    filter: {
      eventTypes: ["example.com/issue-created"],
      condition: "payload.issue != null",
    },
    endWhen: { any: [{ kind: "acknowledged-events", count: 10 }] },
    receiver: {
      action: "copy-to-stream",
      receivingStreamPath: RECEIVING_STREAM_PATH,
      transform: "$",
      delivery: {
        start: "beginning",
        onFailingEvent: "halt",
        includeEphemeral: false,
      },
    },
  }),
  committed(6, "events.iterate.com/stream/copy-list-recorded", {
    source: {
      projectId: PROJECT_ID,
      path: SOURCE_PATH,
      streamId: SOURCE_STREAM_ID,
      streamCreatedAt: SOURCE_STREAM_CREATED_AT,
    },
    sourceOffset: 6,
    subscriptionsByKey: recordedSubscriptions,
  }),
  committed(7, "events.iterate.com/stream/copied-events-dropped", {
    source: {
      projectId: PROJECT_ID,
      path: SOURCE_PATH,
      streamId: SOURCE_STREAM_ID,
      streamCreatedAt: SOURCE_STREAM_CREATED_AT,
    },
    subscriptionKey: SUBSCRIPTION_KEY,
    reason: "cycle",
    count: 1,
    firstOffset: 6,
    lastOffset: 6,
  }),
  committed(8, "events.iterate.com/stream/copy-list-delivery-blocked", {
    receivingStreamPath: RECEIVING_STREAM_PATH,
    sourceOffset: 5,
    attempts: 8,
    error: "receiver unavailable",
  }),
  committed(9, "events.iterate.com/stream/copy-list-resend-requested", {
    receivingStreamPath: RECEIVING_STREAM_PATH,
  }),
  committed(10, "events.iterate.com/stream/copy-list-confirmed", {
    receivingStreamPath: RECEIVING_STREAM_PATH,
    sourceOffset: 9,
    receivingStreamEvent: {
      type: "events.iterate.com/stream/copy-list-recorded",
      payload: {
        source: {
          projectId: PROJECT_ID,
          path: STREAM_PATH,
          streamId: STREAM_ID,
          streamCreatedAt: STREAM_CREATED_AT,
        },
        sourceOffset: 9,
        subscriptionsByKey: recordedSubscriptions,
      },
      offset: 3,
      createdAt: "2026-07-21T12:00:09.500Z",
      path: RECEIVING_STREAM_PATH,
    },
  }),
  committed(11, "events.iterate.com/stream/subscription-delivery-halted", {
    subscriptionKey: SUBSCRIPTION_KEY,
    reason: "delivery-failed",
    afterOffset: 4,
    attempts: 15,
    error: "receiver unavailable",
  }),
  committed(12, "events.iterate.com/stream/subscription-delivery-resumed", {
    subscriptionKey: SUBSCRIPTION_KEY,
  }),
  committed(13, "events.iterate.com/stream/subscription-cursor-set", {
    subscriptionKey: SUBSCRIPTION_KEY,
    afterOffset: 0,
  }),
  committed(14, "events.iterate.com/stream/connection-opened", {
    connectionKey: "browser-1",
    kind: "session",
    openedBy: { description: "browser" },
  }),
  committed(15, "events.iterate.com/stream/connection-closed", {
    connectionKey: "browser-1",
    reason: "closed-by-owner",
  }),
  committed(16, STREAM_PROCESSOR_REVIVED_EVENT_TYPE, {
    processorSlug: "agent",
    revivals: 1,
    version: "1.0.0",
  }),
  committed(17, "events.iterate.com/stream/error-occurred", {
    message: "processor failed once",
    error: { name: "Error", message: "synthetic failure", code: "E_SYNTHETIC" },
  }),
  committed(18, "events.iterate.com/stream/paused", { reason: "operator" }),
  committed(19, "events.iterate.com/stream/resumed", { reason: "operator" }),
  committed(20, "events.iterate.com/stream/subscription-removed", {
    subscriptionKey: SUBSCRIPTION_KEY,
    reason: "requested",
  }),
  committed(21, "events.iterate.com/stream/subscription-configured", {
    subscriptionKey: "hosted-agent",
    description: "Wake the reviewer agent",
    filter: {
      eventTypes: ["*"],
      condition: "payload.ready = true",
    },
    endWhen: { any: [{ kind: "time", at: "2026-07-22T00:00:00.000Z" }] },
    receiver: {
      action: "processor-wake",
      expression: ["agents", ["get", "/agents/reviewer"], "processor", "wakeStreamProcessor"],
      processorSlug: "agent",
    },
  }),
  committed(22, "events.iterate.com/stream/subscription-configured", {
    subscriptionKey: "itx-sink",
    description: "Call a durable ITX receiver",
    endWhen: { any: [{ kind: "acknowledged-events", count: 25 }] },
    receiver: {
      action: "itx-call",
      expression: ["eventSinks", ["get", "audit"], "processEventBatch"],
      delivery: {
        start: "now",
        onFailingEvent: "skip",
        includeEphemeral: true,
      },
    },
  }),
  committed(23, "events.iterate.com/stream/subscription-configured", {
    subscriptionKey: "audit-webhook",
    description: "Post every audited event",
    endWhen: { any: [{ kind: "source-offset-acknowledged", offset: 500 }] },
    receiver: {
      action: "webhook-post",
      url: "https://example.com/hooks/audit",
      delivery: {
        start: { afterOffset: 0 },
        onFailingEvent: "skip",
        includeEphemeral: false,
      },
    },
  }),
  {
    ...committed(24, "events.iterate.com/stream/configured", {
      // A copied control event is historical product data on this stream. Its
      // source payload may predate the receiver's current control-event schema
      // and must remain replayable without being interpreted.
      retiredShape: true,
    }),
    source: {
      copiedFrom: [
        {
          subscriptionKey: SUBSCRIPTION_KEY,
          streamId: SOURCE_STREAM_ID,
          streamCreatedAt: SOURCE_STREAM_CREATED_AT,
          cursorChangedAtSourceOffset: 5,
          createdAt: "2026-07-21T11:00:08.000Z",
          offset: 8,
          path: SOURCE_PATH,
          projectId: PROJECT_ID,
          type: "events.iterate.com/stream/configured",
        },
      ],
    },
  },
  committed(25, "events.iterate.com/stream/copy-list-recorded", {
    source: {
      projectId: PROJECT_ID,
      path: SOURCE_PATH,
      streamId: SOURCE_STREAM_ID,
      streamCreatedAt: SOURCE_STREAM_CREATED_AT,
    },
    sourceOffset: 7,
    subscriptionsByKey: {},
  }),
  committed(26, "events.iterate.com/stream/connection-opened", {
    connectionKey: "hosted-agent",
    kind: "hosted",
    openedBy: {
      processor: {
        announcement: {
          slug: "agent",
          version: "5.0.0",
          description: "Reviews changes when matching events arrive.",
          consumes: ["example.com/issue-created"],
          emits: ["example.com/review-completed"],
          ownedEvents: [
            {
              type: "example.com/review-completed",
              description: "The requested review completed.",
            },
          ],
        },
      },
    },
  }),
];

describe("core processor version 27 committed-event replay", () => {
  test("version 27 parses and reduces one frozen event of every owned type", () => {
    expect(CORE_STATE_VERSION).toBe(27);
    expect(new Set(VERSION_27_COMMITTED_EVENTS.map((event) => event.type))).toEqual(
      new Set(Object.keys(CoreProcessorContract.events)),
    );

    const processor = new StreamCoreProcessor({ projectId: PROJECT_ID });
    let state: CoreProcessorState = CoreProcessorContract.stateSchema.parse({});
    const states = new Map<number, CoreProcessorState>();
    for (const fixture of VERSION_27_COMMITTED_EVENTS) {
      // First-hand control events must still parse under this reducer version.
      // Received copies deliberately bypass that parse, exactly as the replay
      // reducer does, because their payload belongs to the source lifetime.
      const event =
        fixture.source?.copiedFrom === undefined
          ? (CoreProcessorContract.parseEvent(fixture as never) as StreamEvent)
          : fixture;
      state = processor.reduce({ event, state });
      expect(() => CoreProcessorContract.stateSchema.parse(state)).not.toThrow();
      states.set(fixture.offset, state);
    }

    expect(
      states.get(7)?.subscriptions.inbound.bySourcePath[SOURCE_PATH]?.byKey[SUBSCRIPTION_KEY],
    ).toMatchObject({
      configuredAtSourceOffset: 5,
      numEventsReceived: 0,
      numEventsDropped: 1,
    });
    expect(states.get(8)?.copyListDeliveriesByReceivingStream[RECEIVING_STREAM_PATH]).toEqual({
      sourceOffset: 5,
      status: "blocked",
      attempts: 8,
      error: "receiver unavailable",
      blockedAt: "2026-07-21T12:00:08.000Z",
      subscriptionKeysRecordedByReceiver: [],
    });
    expect(states.get(9)?.copyListDeliveriesByReceivingStream[RECEIVING_STREAM_PATH]).toEqual({
      sourceOffset: 9,
      status: "pending",
      subscriptionKeysRecordedByReceiver: [],
    });
    expect(states.get(10)?.copyListDeliveriesByReceivingStream[RECEIVING_STREAM_PATH]).toEqual({
      sourceOffset: 9,
      status: "confirmed",
      subscriptionKeysRecordedByReceiver: [SUBSCRIPTION_KEY],
    });
    expect(states.get(11)?.subscriptions.outbound.byKey[SUBSCRIPTION_KEY]?.deliveryHalted).toEqual({
      reason: "delivery-failed",
      afterOffset: 4,
      attempts: 15,
      error: "receiver unavailable",
    });
    expect(
      states.get(12)?.subscriptions.outbound.byKey[SUBSCRIPTION_KEY]?.deliveryHalted,
    ).toBeUndefined();
    expect(states.get(13)?.subscriptions.outbound.byKey[SUBSCRIPTION_KEY]?.cursorSet).toEqual({
      afterOffset: 0,
      setAtSourceOffset: 13,
    });
    expect(states.get(20)?.subscriptions.outbound.byKey[SUBSCRIPTION_KEY]).toBeUndefined();
    expect(states.get(20)?.copyListDeliveriesByReceivingStream[RECEIVING_STREAM_PATH]).toEqual({
      sourceOffset: 20,
      status: "pending",
      subscriptionKeysRecordedByReceiver: [SUBSCRIPTION_KEY],
    });
    expect(
      states.get(24)?.subscriptions.inbound.bySourcePath[SOURCE_PATH]?.byKey[SUBSCRIPTION_KEY],
    ).toMatchObject({
      numEventsReceived: 1,
      lastEventReceivedAt: "2026-07-21T12:00:24.000Z",
    });
    expect(states.get(24)?.circuitBreaker.burstCapacity).toBe(1_000);
    expect(states.get(25)?.subscriptions.inbound.bySourcePath[SOURCE_PATH]).toBeUndefined();

    expect(state).toMatchObject({
      projectId: PROJECT_ID,
      path: STREAM_PATH,
      streamId: STREAM_ID,
      createdAt: "2026-07-21T12:00:01.000Z",
      incarnationId: "incarnation-1",
      maxOffset: VERSION_27_COMMITTED_EVENTS.at(-1)?.offset,
      eventCount: VERSION_27_COMMITTED_EVENTS.length,
      childPaths: ["/children"],
      paused: false,
      pauseReason: null,
    });
    expect(state.subscriptions).toEqual({
      inbound: { bySourcePath: {} },
      outbound: {
        byKey: {
          "hosted-agent": {
            configuration: {
              subscriptionKey: "hosted-agent",
              description: "Wake the reviewer agent",
              filter: {
                eventTypes: ["*"],
                condition: "payload.ready = true",
              },
              endWhen: {
                any: [{ kind: "time", at: "2026-07-22T00:00:00.000Z" }],
              },
              receiver: {
                action: "processor-wake",
                expression: [
                  "agents",
                  ["get", "/agents/reviewer"],
                  "processor",
                  "wakeStreamProcessor",
                ],
                processorSlug: "agent",
              },
            },
            configuredAtOffset: 21,
            configuredAt: "2026-07-21T12:00:21.000Z",
          },
          "itx-sink": {
            configuration: {
              subscriptionKey: "itx-sink",
              description: "Call a durable ITX receiver",
              endWhen: { any: [{ kind: "acknowledged-events", count: 25 }] },
              receiver: {
                action: "itx-call",
                expression: ["eventSinks", ["get", "audit"], "processEventBatch"],
                delivery: {
                  start: "now",
                  onFailingEvent: "skip",
                  includeEphemeral: true,
                },
              },
            },
            configuredAtOffset: 22,
            configuredAt: "2026-07-21T12:00:22.000Z",
          },
          "audit-webhook": {
            configuration: {
              subscriptionKey: "audit-webhook",
              description: "Post every audited event",
              endWhen: {
                any: [{ kind: "source-offset-acknowledged", offset: 500 }],
              },
              receiver: {
                action: "webhook-post",
                url: "https://example.com/hooks/audit",
                delivery: {
                  start: { afterOffset: 0 },
                  onFailingEvent: "skip",
                  includeEphemeral: false,
                },
              },
            },
            configuredAtOffset: 23,
            configuredAt: "2026-07-21T12:00:23.000Z",
          },
        },
      },
    });
    expect(state.copyListDeliveriesByReceivingStream).toEqual({
      [RECEIVING_STREAM_PATH]: {
        sourceOffset: 20,
        status: "pending",
        subscriptionKeysRecordedByReceiver: [SUBSCRIPTION_KEY],
      },
    });
  });
});

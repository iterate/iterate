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
const SOURCE_STREAM_CREATED_AT = "2026-07-21T11:00:00.000Z";
const SUBSCRIPTION_NAME = "issues";

function committed(offset: number, type: string, payload: Record<string, unknown>): StreamEvent {
  return {
    type,
    payload,
    offset,
    createdAt: `2026-07-21T12:00:${String(offset).padStart(2, "0")}.000Z`,
    path: STREAM_PATH,
  };
}

/**
 * One literal committed event for every event type owned by the version-31
 * core contract. These are deliberately not produced from the schemas: a
 * schema edit must either keep this exact event history replayable or require
 * an intentional state-version/cutover decision and fixture update.
 */
const VERSION_31_COMMITTED_EVENTS: StreamEvent[] = [
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
    name: SUBSCRIPTION_NAME,
    description: "Copy issue events to the reviewer",
    filter: {
      eventTypes: ["example.com/issue-created"],
      jsonataCondition: "payload.issue != null",
    },
    receiver: {
      action: "copy-to-stream",
      receivingStreamPath: RECEIVING_STREAM_PATH,
      delivery: {
        start: "beginning",
        onFailingEvent: "halt",
      },
    },
  }),
  committed(6, "events.iterate.com/stream/subscription-delivery-halted", {
    name: SUBSCRIPTION_NAME,
    reason: "delivery-failed",
    afterOffset: 4,
    attempts: 15,
    error: "receiver unavailable",
  }),
  committed(7, "events.iterate.com/stream/subscription-delivery-resumed", {
    name: SUBSCRIPTION_NAME,
  }),
  committed(8, "events.iterate.com/stream/subscription-cursor-set", {
    name: SUBSCRIPTION_NAME,
    afterOffset: 0,
  }),
  committed(9, "events.iterate.com/stream/connection-opened", {
    connectionKey: "browser-1",
    kind: "session",
    openedBy: { description: "browser" },
  }),
  committed(10, "events.iterate.com/stream/connection-closed", {
    connectionKey: "browser-1",
    reason: "closed-by-owner",
  }),
  committed(11, STREAM_PROCESSOR_REVIVED_EVENT_TYPE, {
    processorSlug: "agent",
    revivals: 1,
    version: "1.0.0",
  }),
  committed(12, "events.iterate.com/stream/error-occurred", {
    message: "processor failed once",
    error: { name: "Error", message: "synthetic failure", code: "E_SYNTHETIC" },
  }),
  committed(13, "events.iterate.com/stream/paused", { reason: "operator" }),
  committed(14, "events.iterate.com/stream/resumed", { reason: "operator" }),
  committed(15, "events.iterate.com/stream/subscription-removed", {
    name: SUBSCRIPTION_NAME,
    reason: "requested",
  }),
  committed(16, "events.iterate.com/stream/subscription-configured", {
    // Name = slug: one identity for hosted processors.
    name: "agent",
    description: "Wake the reviewer agent",
    filter: {
      eventTypes: ["*"],
      jsonataCondition: "payload.ready = true",
    },
    receiver: {
      action: "wake-processor",
      expression: ["agents", ["get", "/agents/reviewer"], "processor", "wakeStreamProcessor"],
    },
  }),
  committed(17, "events.iterate.com/stream/subscription-configured", {
    name: "device",
    description: "Run the device processor as a facet of this stream",
    receiver: {
      action: "facet-processor",
      source: { kind: "builtin" },
    },
  }),
  committed(18, "events.iterate.com/stream/subscription-configured", {
    name: "itx-sink",
    description: "Call a durable ITX receiver",
    receiver: {
      action: "itx-call",
      expression: ["eventSinks", ["get", "audit"], "processEventBatch"],
      delivery: {
        start: "now",
        onFailingEvent: "skip",
      },
    },
  }),
  {
    ...committed(19, "events.iterate.com/stream/configured", {
      // A copied control event is historical product data on this stream. Its
      // source payload may predate the receiver's current control-event schema
      // and must remain replayable without being interpreted.
      retiredShape: true,
    }),
    source: {
      copiedFrom: [
        {
          name: SUBSCRIPTION_NAME,
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
];

describe("core processor version 31 committed-event replay", () => {
  test("version 31 parses and reduces one frozen event of every owned type", () => {
    expect(CORE_STATE_VERSION).toBe(31);
    expect(new Set(VERSION_31_COMMITTED_EVENTS.map((event) => event.type))).toEqual(
      new Set(Object.keys(CoreProcessorContract.events)),
    );

    const processor = new StreamCoreProcessor({ projectId: PROJECT_ID });
    let state: CoreProcessorState = CoreProcessorContract.stateSchema.parse({});
    const states = new Map<number, CoreProcessorState>();
    for (const fixture of VERSION_31_COMMITTED_EVENTS) {
      // First-hand control events must still parse under this reducer version.
      // Received copies deliberately bypass that parse, exactly as the replay
      // reducer does, because their payload belongs to the source lifetime.
      const event = !fixture.source?.copiedFrom
        ? (CoreProcessorContract.parseEvent(fixture as never) as StreamEvent)
        : fixture;
      state = processor.reduce({ event, state });
      expect(() => CoreProcessorContract.stateSchema.parse(state)).not.toThrow();
      states.set(fixture.offset, state);
    }

    expect(states.get(6)?.subscriptions.outbound.byName[SUBSCRIPTION_NAME]?.deliveryHalted).toEqual(
      {
        reason: "delivery-failed",
        afterOffset: 4,
        attempts: 15,
        error: "receiver unavailable",
      },
    );
    expect(
      states.get(7)?.subscriptions.outbound.byName[SUBSCRIPTION_NAME]?.deliveryHalted,
    ).toBeUndefined();
    expect(states.get(8)?.subscriptions.outbound.byName[SUBSCRIPTION_NAME]?.cursorSet).toEqual({
      afterOffset: 0,
      setAtSourceOffset: 8,
    });
    expect(states.get(15)?.subscriptions.outbound.byName[SUBSCRIPTION_NAME]).toBeUndefined();

    expect(state).toMatchObject({
      projectId: PROJECT_ID,
      path: STREAM_PATH,
      streamId: STREAM_ID,
      createdAt: "2026-07-21T12:00:01.000Z",
      incarnationId: "incarnation-1",
      maxOffset: VERSION_31_COMMITTED_EVENTS.at(-1)?.offset,
      eventCount: VERSION_31_COMMITTED_EVENTS.length,
      childPaths: ["/children"],
      paused: false,
      pauseReason: null,
    });
    expect(state.circuitBreaker.burstCapacity).toBe(1_000);
    expect(state.subscriptions).toEqual({
      // The copied control event's stamp created this passive inbound record.
      inbound: {
        bySourcePath: {
          [SOURCE_PATH]: {
            [SUBSCRIPTION_NAME]: {
              streamId: SOURCE_STREAM_ID,
              streamCreatedAt: SOURCE_STREAM_CREATED_AT,
              cursorChangedAtSourceOffset: 5,
              numEventsReceived: 1,
              lastEventReceivedAt: "2026-07-21T12:00:19.000Z",
            },
          },
        },
      },
      outbound: {
        byName: {
          agent: {
            configuration: {
              name: "agent",
              description: "Wake the reviewer agent",
              filter: {
                eventTypes: ["*"],
                jsonataCondition: "payload.ready = true",
              },
              receiver: {
                action: "wake-processor",
                expression: [
                  "agents",
                  ["get", "/agents/reviewer"],
                  "processor",
                  "wakeStreamProcessor",
                ],
              },
            },
            configuredAtOffset: 16,
            configuredAt: "2026-07-21T12:00:16.000Z",
          },
          device: {
            configuration: {
              name: "device",
              description: "Run the device processor as a facet of this stream",
              receiver: {
                action: "facet-processor",
                source: { kind: "builtin" },
              },
            },
            configuredAtOffset: 17,
            configuredAt: "2026-07-21T12:00:17.000Z",
          },
          "itx-sink": {
            configuration: {
              name: "itx-sink",
              description: "Call a durable ITX receiver",
              receiver: {
                action: "itx-call",
                expression: ["eventSinks", ["get", "audit"], "processEventBatch"],
                delivery: {
                  start: "now",
                  onFailingEvent: "skip",
                },
              },
            },
            configuredAtOffset: 18,
            configuredAt: "2026-07-21T12:00:18.000Z",
          },
        },
      },
    });
  });
});

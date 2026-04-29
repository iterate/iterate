import {
  STREAM_ERROR_OCCURRED_TYPE,
  STREAM_METADATA_UPDATED_TYPE,
  type Event,
  type StreamPath,
} from "@iterate-com/events-contract";
import {
  processEventsWithViewReducer,
  rawJsonDumpEventsStreamViewReducer,
  rawPrettyEventsStreamViewReducer,
} from "@iterate-com/ui/components/events/feed-processors";
import { describe, expect, test } from "vitest";

describe("clean stream view reducers", () => {
  test("raw-pretty emits one raw summary plus one semantic item for semantic events", () => {
    const viewState = processEventsWithViewReducer({
      reducer: rawPrettyEventsStreamViewReducer,
      events: [
        event({
          offset: 1,
          type: "events.iterate.com/agent/webchat-message-received",
          payload: { content: "hello" },
        }),
      ],
    });

    expect(viewState.slots.feed).toMatchObject([
      {
        type: "raw-event",
        id: "raw-event-1",
        props: {
          offset: 1,
          eventType: "events.iterate.com/agent/webchat-message-received",
        },
      },
      {
        type: "message",
        id: "message-user-1",
        props: {
          role: "user",
          text: "hello",
        },
      },
    ]);
  });

  test("raw-pretty keeps one raw summary row per event instead of grouping consecutive event types", () => {
    const viewState = processEventsWithViewReducer({
      reducer: rawPrettyEventsStreamViewReducer,
      events: [
        event({ offset: 1, type: STREAM_METADATA_UPDATED_TYPE, payload: { metadata: { a: 1 } } }),
        event({ offset: 2, type: STREAM_METADATA_UPDATED_TYPE, payload: { metadata: { b: 2 } } }),
      ],
    });

    expect(viewState.slots.feed.map((item) => item.type)).toEqual([
      "raw-event",
      "metadata-updated",
      "raw-event",
      "metadata-updated",
    ]);
  });

  test("raw-pretty projects stream errors into feed and input slots", () => {
    const viewState = processEventsWithViewReducer({
      reducer: rawPrettyEventsStreamViewReducer,
      events: [
        event({
          offset: 1,
          type: STREAM_ERROR_OCCURRED_TYPE,
          payload: { message: "boom" },
        }),
      ],
    });

    expect(viewState.slots.feed.map((item) => item.type)).toEqual(["raw-event", "error"]);
    expect(viewState.slots.input).toMatchObject([
      {
        type: "composer-suggestion",
        id: "composer-suggestion-stream-error-1",
        props: {
          label: "Ask agent to debug this error",
          action: {
            type: "prefill-agent-message",
            text: "Can you help debug this stream error?\n\nboom",
          },
          sourceOffset: 1,
        },
      },
    ]);
  });

  test("raw single JSON keeps the full event array in one feed element", () => {
    const events = [
      event({ offset: 1, type: "example.one" }),
      event({ offset: 2, type: "example.two" }),
    ];

    const viewState = processEventsWithViewReducer({
      reducer: rawJsonDumpEventsStreamViewReducer,
      events,
    });

    expect(viewState.slots.feed).toMatchObject([
      {
        type: "raw-json-dump",
        id: "raw-json-dump",
        props: { events },
      },
    ]);
  });
});

function event(args: {
  offset: number;
  type: string;
  payload?: Record<string, unknown>;
  streamPath?: StreamPath;
}): Event {
  return {
    streamPath: args.streamPath ?? "/",
    type: args.type,
    payload: args.payload ?? {},
    offset: args.offset,
    createdAt: new Date(1_700_000_000_000 + args.offset).toISOString(),
  };
}

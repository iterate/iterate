import {
  STREAM_ERROR_OCCURRED_TYPE,
  STREAM_METADATA_UPDATED_TYPE,
  type Event,
  type StreamPath,
} from "@iterate-com/events-contract";
import { getAdjacentEventOffset } from "@iterate-com/ui/components/events/event-inspector-sheet";
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

  test("raw-pretty projects webchat responses as assistant messages", () => {
    const viewState = processEventsWithViewReducer({
      reducer: rawPrettyEventsStreamViewReducer,
      events: [
        event({
          offset: 1,
          type: "events.iterate.com/agent/webchat-response-added",
          payload: { message: "hi from codemode" },
        }),
      ],
    });

    expect(viewState.slots.feed).toMatchObject([
      {
        type: "raw-event",
        props: {
          eventType: "events.iterate.com/agent/webchat-response-added",
        },
      },
      {
        type: "message",
        props: {
          role: "assistant",
          text: "hi from codemode",
        },
      },
    ]);
  });

  test("raw-pretty keeps semantic events adjacent to their raw summaries", () => {
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

  test("raw-pretty groups consecutive raw-only summaries without dropping source events", () => {
    const viewState = processEventsWithViewReducer({
      reducer: rawPrettyEventsStreamViewReducer,
      events: [
        event({ offset: 1, type: "events.iterate.com/example/no-renderer" }),
        event({ offset: 2, type: "events.iterate.com/example/no-renderer" }),
      ],
    });

    expect(viewState.slots.feed).toMatchObject([
      {
        type: "grouped-raw-event",
        props: {
          eventType: "events.iterate.com/example/no-renderer",
          count: 2,
          events: [{ props: { offset: 1 } }, { props: { offset: 2 } }],
        },
      },
    ]);
  });

  test("raw-pretty does not group a raw summary when that event also emits a semantic item", () => {
    const viewState = processEventsWithViewReducer({
      reducer: rawPrettyEventsStreamViewReducer,
      events: [
        event({
          offset: 1,
          type: "events.iterate.com/agent/webchat-message-received",
          payload: {},
        }),
        event({
          offset: 2,
          type: "events.iterate.com/agent/webchat-message-received",
          payload: { content: "hello" },
        }),
      ],
    });

    expect(viewState.slots.feed.map((item) => item.type)).toEqual([
      "raw-event",
      "raw-event",
      "message",
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

  test("raw-pretty projects canonical codemode events into dedicated cards", () => {
    const viewState = processEventsWithViewReducer({
      reducer: rawPrettyEventsStreamViewReducer,
      events: [
        event({
          offset: 1,
          type: "events.iterate.com/codemode/block-added",
          payload: { script: "async () => ({ ok: true })" },
        }),
        event({
          offset: 2,
          type: "events.iterate.com/codemode/result-added",
          payload: {
            result: { ok: true },
            durationMs: 17,
            logs: ["ran"],
          },
        }),
        event({
          offset: 3,
          type: "events.iterate.com/codemode/tool-provider-config-updated",
          payload: {
            slug: "github",
            executeCallable: { name: "github.exec" },
            getTypesCallable: { name: "github.types" },
          },
        }),
      ],
    });

    expect(viewState.slots.feed.map((item) => item.type)).toEqual([
      "raw-event",
      "codemode-block",
      "raw-event",
      "codemode-result",
      "raw-event",
      "codemode-tool-provider",
    ]);
    expect(viewState.slots.feed).toMatchObject([
      {},
      {
        type: "codemode-block",
        props: {
          script: "async () => ({ ok: true })",
          language: "javascript",
        },
      },
      {},
      {
        type: "codemode-result",
        props: {
          success: true,
          result: { ok: true },
          logs: ["ran"],
          durationMs: 17,
        },
      },
      {},
      {
        type: "codemode-tool-provider",
        props: {
          slug: "github",
          operation: "configured",
          hasTypesCallable: true,
        },
      },
    ]);
  });

  test("raw-pretty leaves legacy codemode event names as raw-only summaries", () => {
    const viewState = processEventsWithViewReducer({
      reducer: rawPrettyEventsStreamViewReducer,
      events: [
        event({
          offset: 1,
          type: "codemode-block-added",
          payload: { script: "async () => null" },
        }),
      ],
    });

    expect(viewState.slots.feed.map((item) => item.type)).toEqual(["raw-event"]);
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

  test("event inspector navigation walks the raw wire event list by offset", () => {
    const events = [
      event({ offset: 1, type: "example.one" }),
      event({ offset: 2, type: "example.two" }),
      event({ offset: 3, type: "example.three" }),
    ];

    expect(getAdjacentEventOffset(events, 2, "previous")).toBe(1);
    expect(getAdjacentEventOffset(events, 2, "next")).toBe(3);
    expect(getAdjacentEventOffset(events, 1, "previous")).toBeUndefined();
    expect(getAdjacentEventOffset(events, 3, "next")).toBeUndefined();
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

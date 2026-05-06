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

const SLACK_AGENT_INPUT_CONTENT = [
  "```yaml",
  "event:",
  "  type: events.iterate.com/slack/webhook-received",
  "  idempotencyKey: slack-webhook:Ev0B09JZ1SF9",
  "  filtered: true",
  "  payload:",
  "    channel: C08R1SMTZGD",
  '    text: "<@U08T48230AD> reply exactly slack-filtered-original-type-1777497600"',
  "```",
].join("\n");

describe("clean stream view reducers", () => {
  test("raw-pretty emits one raw summary plus one semantic item for semantic events", () => {
    const viewState = processEventsWithViewReducer({
      reducer: rawPrettyEventsStreamViewReducer,
      events: [
        event({
          offset: 1,
          type: "events.iterate.com/webchat/user-message-added",
          payload: { content: "hello" },
        }),
      ],
    });

    expect(viewState.slots.feed).toMatchObject([
      {
        type: "grouped-raw-event",
        id: "grouped-raw-event-events.iterate.com/webchat/user-message-added-1-1",
        props: {
          eventType: "events.iterate.com/webchat/user-message-added",
          count: 1,
          events: [{ offset: 1 }],
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
    expect(viewState.slots.header).toMatchObject([
      {
        type: "event-counter",
        props: {
          count: 1,
        },
      },
    ]);
  });

  test("raw-pretty projects webchat responses as assistant messages", () => {
    const message = ["Here is code:", "", "```typescript", "const ok: boolean = true;", "```"].join(
      "\n",
    );
    const viewState = processEventsWithViewReducer({
      reducer: rawPrettyEventsStreamViewReducer,
      events: [
        event({
          offset: 1,
          type: "events.iterate.com/webchat/agent-response-added",
          payload: { message },
        }),
      ],
    });

    expect(viewState.slots.feed).toMatchObject([
      {
        type: "grouped-raw-event",
        props: {
          eventType: "events.iterate.com/webchat/agent-response-added",
          count: 1,
        },
      },
      {
        type: "message",
        props: {
          role: "assistant",
          text: message,
          format: "markdown",
        },
      },
    ]);
  });

  test("raw-pretty projects canonical agent input-added events as prompt context", () => {
    const viewState = processEventsWithViewReducer({
      reducer: rawPrettyEventsStreamViewReducer,
      events: [
        event({
          offset: 7,
          type: "events.iterate.com/agent/input-added",
          payload: {
            source: "slack",
            content: SLACK_AGENT_INPUT_CONTENT,
          },
        }),
      ],
    });

    expect(viewState.slots.feed).toMatchObject([
      {
        type: "grouped-raw-event",
        id: "grouped-raw-event-events.iterate.com/agent/input-added-7-7",
        props: {
          eventType: "events.iterate.com/agent/input-added",
          count: 1,
          events: [{ offset: 7 }],
        },
      },
      {
        type: "prompt-context",
        id: "prompt-context-7",
        props: {
          source: "slack",
          text: SLACK_AGENT_INPUT_CONTENT,
        },
      },
    ]);
  });

  test("raw-pretty projects canonical system prompt updates", () => {
    const viewState = processEventsWithViewReducer({
      reducer: rawPrettyEventsStreamViewReducer,
      events: [
        event({
          offset: 8,
          type: "events.iterate.com/agent/system-prompt-updated",
          payload: { systemPrompt: "You are careful and terse." },
        }),
      ],
    });

    expect(viewState.slots.feed).toMatchObject([
      {
        type: "grouped-raw-event",
        id: "grouped-raw-event-events.iterate.com/agent/system-prompt-updated-8-8",
        props: {
          eventType: "events.iterate.com/agent/system-prompt-updated",
          count: 1,
          events: [{ offset: 8 }],
        },
      },
      {
        type: "system-prompt",
        id: "system-prompt-8",
        props: {
          text: "You are careful and terse.",
        },
      },
    ]);
  });

  test("raw-pretty projects LLM request start and end as boundary lines", () => {
    const viewState = processEventsWithViewReducer({
      reducer: rawPrettyEventsStreamViewReducer,
      events: [
        event({
          offset: 9,
          type: "events.iterate.com/agent/llm-request-requested",
          payload: {
            requestId: "req_1",
            model: "test-model",
            runOpts: {},
          },
        }),
        event({
          offset: 10,
          type: "events.iterate.com/agent/llm-request-completed",
          payload: {
            requestId: "req_1",
            rawResponse: "ok",
            durationMs: 123,
          },
        }),
      ],
    });

    expect(viewState.slots.feed).toMatchObject([
      {
        type: "grouped-raw-event",
        props: {
          eventType: "events.iterate.com/agent/llm-request-requested",
          count: 1,
        },
      },
      {
        type: "llm-request-boundary",
        id: "llm-request-requested-9",
        props: {
          phase: "started",
          requestId: "req_1",
        },
      },
      {
        type: "grouped-raw-event",
        props: {
          eventType: "events.iterate.com/agent/llm-request-completed",
          count: 1,
        },
      },
      {
        type: "llm-request-boundary",
        id: "llm-request-ended-10",
        props: {
          phase: "ended",
          outcome: "completed",
          requestId: "req_1",
        },
      },
    ]);
    expect(viewState.slots.feed).not.toContainEqual(
      expect.objectContaining({ type: "prompt-context" }),
    );
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
      "grouped-raw-event",
      "metadata-updated",
      "grouped-raw-event",
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
          events: [{ offset: 1 }, { offset: 2 }],
        },
      },
    ]);
    expect(viewState.slots.header).toMatchObject([
      {
        type: "event-counter",
        props: {
          count: 2,
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
          type: "events.iterate.com/webchat/user-message-added",
          payload: {},
        }),
        event({
          offset: 2,
          type: "events.iterate.com/webchat/user-message-added",
          payload: { content: "hello" },
        }),
      ],
    });

    expect(viewState.slots.feed.map((item) => item.type)).toEqual([
      "grouped-raw-event",
      "grouped-raw-event",
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

    expect(viewState.slots.feed.map((item) => item.type)).toEqual(["grouped-raw-event", "error"]);
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

  test("raw-pretty projects canonical codemode execution events into dedicated renderers", () => {
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
      "grouped-raw-event",
      "codemode-block",
      "grouped-raw-event",
      "codemode-result",
      "grouped-raw-event",
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
    ]);
  });

  test("raw-pretty leaves unknown codemode-like event names as raw-only summaries", () => {
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

    expect(viewState.slots.feed.map((item) => item.type)).toEqual(["grouped-raw-event"]);
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

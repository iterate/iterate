import { describe, expect, test } from "vitest";
import { type Event } from "@iterate-com/events-contract";
import {
  buildDisplayFeed,
  createGroupedOrSingleEvent,
  getAdjacentEventOffset,
  getEventFeedItems,
  projectEventToFeed,
  projectWireToFeed,
  toEventFeedItem,
  toSemanticFeedItem,
} from "~/lib/stream-feed-projection.ts";
import type { EventFeedItem, StreamFeedItem } from "~/lib/stream-feed-types.ts";

describe("toEventFeedItem", () => {
  test("maps contract events to feed events", () => {
    const event = createEvent({
      streamPath: "/demo",
      type: "https://events.iterate.com/demo/created",
      offset: 5,
      createdAt: "2026-03-30T12:34:56.000Z",
      payload: { ok: true },
    });

    expect(toEventFeedItem(event)).toEqual({
      kind: "event",
      streamPath: "/demo",
      offset: 5,
      createdAt: "2026-03-30T12:34:56.000Z",
      eventType: "https://events.iterate.com/demo/created",
      timestamp: Date.parse("2026-03-30T12:34:56.000Z"),
      raw: event,
    });
  });
});

describe("projectWireToFeed", () => {
  test("projects every event into the feed timeline", () => {
    const events = [
      createEvent({ offset: 1, type: "https://events.iterate.com/demo/one" }),
      createEvent({ offset: 2, type: "https://events.iterate.com/demo/two" }),
    ];

    expect(projectWireToFeed(events).map((item) => item.kind)).toEqual(["event", "event"]);
  });

  test("adds a semantic child-stream item after child-stream-created events", () => {
    const feed = projectEventToFeed(
      createEvent({
        streamPath: "/",
        type: "https://events.iterate.com/events/stream/child-stream-created",
        payload: { childPath: "/child-stream" },
      }),
    );

    expect(feed.map((item) => item.kind)).toEqual(["event", "child-stream-created"]);
    expect(feed[1]).toMatchObject({
      kind: "child-stream-created",
      parentPath: "/",
      createdPath: "/child-stream",
    });
  });

  test("adds a semantic metadata item after metadata-updated events", () => {
    const feed = projectEventToFeed(
      createEvent({
        streamPath: "/demo",
        type: "https://events.iterate.com/events/stream/metadata-updated",
        payload: { metadata: { owner: "jonas" } },
      }),
    );

    expect(feed.map((item) => item.kind)).toEqual(["event", "stream-metadata-updated"]);
    expect(feed[1]).toMatchObject({
      kind: "stream-metadata-updated",
      path: "/demo",
      metadata: { owner: "jonas" },
    });
  });

  test("extracts only raw event rows from a mixed feed", () => {
    const feed = projectWireToFeed([
      createEvent({
        streamPath: "/",
        type: "https://events.iterate.com/events/stream/child-stream-created",
        payload: { childPath: "/child-stream" },
      }),
    ]);

    expect(getEventFeedItems(feed).map((item) => item.kind)).toEqual(["event"]);
  });

  test("projects agent input and output events into a chat-style timeline", () => {
    const feed = projectWireToFeed([
      createEvent({
        offset: 1,
        type: "https://events.iterate.com/agent/input-item-added",
        payload: {
          item: {
            role: "user",
            content: "Hello there",
          },
        },
      }),
      createEvent({
        offset: 2,
        type: "https://events.iterate.com/agent/output-item-added",
        payload: {
          chunk: {
            type: "content",
            id: "chunk-1",
            model: "gpt-4o-mini",
            timestamp: 1,
            delta: "Hello",
            content: "Hello",
            role: "assistant",
          },
        },
      }),
      createEvent({
        offset: 3,
        type: "https://events.iterate.com/agent/output-item-added",
        payload: {
          chunk: {
            type: "content",
            id: "chunk-2",
            model: "gpt-4o-mini",
            timestamp: 2,
            delta: " back",
            content: "Hello back",
            role: "assistant",
          },
        },
      }),
      createEvent({
        offset: 4,
        type: "https://events.iterate.com/agent/output-item-added",
        payload: {
          chunk: {
            type: "done",
            id: "chunk-3",
            model: "gpt-4o-mini",
            timestamp: 3,
            finishReason: "stop",
          },
        },
      }),
    ]);

    expect(feed.map((item) => item.kind)).toEqual([
      "event",
      "message",
      "event",
      "event",
      "event",
      "message",
    ]);
    expect(feed[1]).toMatchObject({
      kind: "message",
      role: "user",
      content: [{ type: "text", text: "Hello there" }],
    });
    expect(feed[5]).toMatchObject({
      kind: "message",
      role: "assistant",
      content: [{ type: "text", text: "Hello back" }],
      streamStatus: "complete",
    });
  });

  test("marks assistant replies as streaming until a done chunk arrives", () => {
    const feed = projectWireToFeed([
      createEvent({
        offset: 1,
        type: "https://events.iterate.com/agent/input-item-added",
        payload: {
          item: {
            role: "user",
            content: "Hi",
          },
        },
      }),
      createEvent({
        offset: 2,
        type: "https://events.iterate.com/agent/output-item-added",
        payload: {
          chunk: {
            type: "content",
            id: "chunk-1",
            model: "gpt-4o-mini",
            timestamp: 1,
            delta: "Partial",
            content: "Partial",
            role: "assistant",
          },
        },
      }),
    ]);

    const assistant = feed.find(
      (item): item is Extract<StreamFeedItem, { kind: "message" }> =>
        item.kind === "message" && item.role === "assistant",
    );
    expect(assistant).toMatchObject({
      kind: "message",
      role: "assistant",
      content: [{ type: "text", text: "Partial" }],
      streamStatus: "streaming",
    });
  });

  test("prefers finalized assistant messages over reconstructed chunk text", () => {
    const feed = projectWireToFeed([
      createEvent({
        offset: 1,
        type: "https://events.iterate.com/agent/input-item-added",
        payload: {
          item: {
            role: "user",
            content: "Hi",
          },
        },
      }),
      createEvent({
        offset: 2,
        type: "https://events.iterate.com/agent/output-item-added",
        payload: {
          chunk: {
            type: "content",
            id: "chunk-1",
            model: "gpt-4o-mini",
            timestamp: 1,
            delta: "Hello",
            content: "Hello",
            role: "assistant",
          },
        },
      }),
      createEvent({
        offset: 3,
        type: "https://events.iterate.com/agent/output-item-added",
        payload: {
          chunk: {
            type: "done",
            id: "chunk-2",
            model: "gpt-4o-mini",
            timestamp: 2,
            finishReason: "stop",
          },
        },
      }),
      createEvent({
        offset: 4,
        type: "https://events.iterate.com/agent/input-item-added",
        payload: {
          item: {
            role: "assistant",
            content: "Hello",
          },
        },
      }),
    ]);

    const assistantMessages = feed.filter(
      (item): item is Extract<StreamFeedItem, { kind: "message"; role: "assistant" }> =>
        item.kind === "message" && item.role === "assistant",
    );

    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]).toMatchObject({
      kind: "message",
      role: "assistant",
      content: [{ type: "text", text: "Hello" }],
    });
    expect("streamStatus" in assistantMessages[0]).toBe(false);
  });

  test("projects tool_call and tool_result chunks into tool feed items", () => {
    const feed = projectWireToFeed([
      createEvent({
        offset: 1,
        type: "https://events.iterate.com/agent/input-item-added",
        payload: {
          item: {
            role: "user",
            content: "Use a tool",
          },
        },
      }),
      createEvent({
        offset: 2,
        type: "https://events.iterate.com/agent/output-item-added",
        payload: {
          chunk: {
            type: "tool_call",
            id: "c1",
            model: "gpt-4o-mini",
            timestamp: 1,
            index: 0,
            toolCall: {
              id: "call_1",
              type: "function",
              function: { name: "demo_tool", arguments: '{"x":1}' },
            },
          },
        },
      }),
      createEvent({
        offset: 3,
        type: "https://events.iterate.com/agent/output-item-added",
        payload: {
          chunk: {
            type: "tool_result",
            id: "c2",
            model: "gpt-4o-mini",
            timestamp: 2,
            toolCallId: "call_1",
            content: '{"ok":true}',
          },
        },
      }),
      createEvent({
        offset: 4,
        type: "https://events.iterate.com/agent/output-item-added",
        payload: {
          chunk: {
            type: "done",
            id: "c3",
            model: "gpt-4o-mini",
            timestamp: 3,
            finishReason: "stop",
          },
        },
      }),
    ]);

    const toolItem = feed.find((item) => item.kind === "tool");
    expect(toolItem).toMatchObject({
      kind: "tool",
      toolName: "demo_tool",
      toolCallId: "call_1",
      state: "completed",
    });
  });

  test("adds an error item for failed agent output events", () => {
    const feed = projectWireToFeed([
      createEvent({
        offset: 1,
        type: "https://events.iterate.com/agent/input-item-added",
        payload: {
          item: {
            role: "user",
            content: "Break please",
          },
        },
      }),
      createEvent({
        offset: 2,
        type: "https://events.iterate.com/agent/output-item-added",
        payload: {
          chunk: {
            type: "RUN_ERROR",
            error: "boom",
          },
        },
      }),
    ]);

    expect(feed.map((item) => item.kind)).toEqual(["event", "message", "event", "error"]);
    expect(feed[3]).toMatchObject({
      kind: "error",
      message: "Agent run failed",
      context: "boom",
    });
  });

  test("projects workshop llm events into a user and assistant message timeline", () => {
    const feed = projectWireToFeed([
      createEvent({
        offset: 1,
        type: "llm-input-added",
        payload: {
          content: "Write a tiny hello world",
          source: "user",
        },
      }),
      createEvent({
        offset: 2,
        type: "llm-request-started",
        payload: {
          requestId: "req_1",
          inputOffset: 1,
          inputSource: "user",
        },
      }),
      createEvent({
        offset: 3,
        type: "openai-response-event-added",
        payload: {
          requestId: "req_1",
          event: {
            type: "response.output_text.delta",
            item_id: "msg_1",
            content_index: 0,
            delta: "hello",
          },
        },
      }),
      createEvent({
        offset: 4,
        type: "openai-response-event-added",
        payload: {
          requestId: "req_1",
          event: {
            type: "response.output_text.delta",
            item_id: "msg_1",
            content_index: 0,
            delta: " world",
          },
        },
      }),
      createEvent({
        offset: 5,
        type: "llm-request-completed",
        payload: {
          requestId: "req_1",
          outputText: "hello world",
        },
      }),
    ]);

    const messages = feed.filter(
      (item): item is Extract<StreamFeedItem, { kind: "message" }> => item.kind === "message",
    );

    expect(messages).toEqual([
      {
        kind: "message",
        role: "user",
        content: [{ type: "text", text: "Write a tiny hello world" }],
        timestamp: messages[0]!.timestamp,
      },
      {
        kind: "message",
        role: "assistant",
        content: [{ type: "text", text: "hello world" }],
        timestamp: messages[1]!.timestamp,
        streamStatus: "complete",
      },
    ]);
  });

  test("marks workshop assistant output as streaming until the request completes", () => {
    const feed = projectWireToFeed([
      createEvent({
        offset: 1,
        type: "llm-input-added",
        payload: {
          content: "Keep streaming",
          source: "user",
        },
      }),
      createEvent({
        offset: 2,
        type: "llm-request-started",
        payload: {
          requestId: "req_stream",
          inputOffset: 1,
          inputSource: "user",
        },
      }),
      createEvent({
        offset: 3,
        type: "openai-response-event-added",
        payload: {
          requestId: "req_stream",
          event: {
            type: "response.output_text.delta",
            item_id: "msg_stream",
            content_index: 0,
            delta: "Partial output",
          },
        },
      }),
    ]);

    const assistant = feed.find(
      (item): item is Extract<StreamFeedItem, { kind: "message"; role: "assistant" }> =>
        item.kind === "message" && item.role === "assistant",
    );

    expect(assistant).toMatchObject({
      kind: "message",
      role: "assistant",
      content: [{ type: "text", text: "Partial output" }],
      streamStatus: "streaming",
    });
  });

  test("projects actual OpenAI assistant output items as separate streamed messages", () => {
    const feed = projectWireToFeed([
      createEvent({
        offset: 1,
        type: "llm-input-added",
        payload: {
          content: "Write two short replies",
          source: "user",
        },
      }),
      createEvent({
        offset: 2,
        type: "llm-request-started",
        payload: {
          requestId: "req_items",
          inputOffset: 1,
          inputSource: "user",
        },
      }),
      createEvent({
        offset: 3,
        type: "openai-response-event-added",
        payload: {
          requestId: "req_items",
          event: {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              id: "msg_a",
              type: "message",
              role: "assistant",
              content: [],
            },
          },
        },
      }),
      createEvent({
        offset: 4,
        type: "openai-response-event-added",
        payload: {
          requestId: "req_items",
          event: {
            type: "response.output_text.delta",
            item_id: "msg_a",
            content_index: 0,
            delta: "First reply",
            output_index: 0,
          },
        },
      }),
      createEvent({
        offset: 5,
        type: "openai-response-event-added",
        payload: {
          requestId: "req_items",
          event: {
            type: "response.output_item.added",
            output_index: 1,
            item: {
              id: "msg_b",
              type: "message",
              role: "assistant",
              content: [],
            },
          },
        },
      }),
      createEvent({
        offset: 6,
        type: "openai-response-event-added",
        payload: {
          requestId: "req_items",
          event: {
            type: "response.output_text.delta",
            item_id: "msg_b",
            content_index: 0,
            delta: "Second reply",
            output_index: 1,
          },
        },
      }),
    ]);

    const assistants = feed.filter(
      (item): item is Extract<StreamFeedItem, { kind: "message"; role: "assistant" }> =>
        item.kind === "message" && item.role === "assistant",
    );

    expect(assistants).toMatchObject([
      {
        kind: "message",
        role: "assistant",
        content: [{ type: "text", text: "First reply" }],
        streamStatus: "streaming",
      },
      {
        kind: "message",
        role: "assistant",
        content: [{ type: "text", text: "Second reply" }],
        streamStatus: "streaming",
      },
    ]);
  });

  test("projects codemode block and result events into dedicated cards", () => {
    const feed = projectWireToFeed([
      createEvent({
        offset: 1,
        type: "codemode-block-added",
        payload: {
          requestId: "req_1",
          blockId: "ts-block-1",
          language: "ts",
          code: 'console.log("hello");',
        },
      }),
      createEvent({
        offset: 2,
        type: "codemode-result-added",
        payload: {
          requestId: "req_1",
          blockId: "ts-block-1",
          blockCount: 1,
          success: true,
          exitCode: 0,
          stdout: "hello",
          stderr: "",
          durationMs: 42,
          codePath: "/tmp/1/code.ts",
          outputPath: "/tmp/1/out.txt",
        },
      }),
    ]);

    expect(feed.map((item) => item.kind)).toEqual([
      "event",
      "codemode-block",
      "event",
      "codemode-result",
    ]);
    expect(feed[1]).toMatchObject({
      kind: "codemode-block",
      blockId: "ts-block-1",
      language: "ts",
      code: 'console.log("hello");',
    });
    expect(feed[3]).toMatchObject({
      kind: "codemode-result",
      blockId: "ts-block-1",
      success: true,
      stdout: "hello",
      codePath: "/tmp/1/code.ts",
    });
  });

  test("projects failed workshop requests into error feed items", () => {
    const feed = projectWireToFeed([
      createEvent({
        offset: 1,
        type: "llm-input-added",
        payload: {
          content: "Break",
          source: "user",
        },
      }),
      createEvent({
        offset: 2,
        type: "llm-request-started",
        payload: {
          requestId: "req_fail",
          inputOffset: 1,
          inputSource: "user",
        },
      }),
      createEvent({
        offset: 3,
        type: "llm-request-failed",
        payload: {
          requestId: "req_fail",
          message: "model overloaded",
        },
      }),
    ]);

    expect(feed.find((item) => item.kind === "error")).toMatchObject({
      kind: "error",
      message: "LLM request failed",
      context: "model overloaded",
    });
  });
});

describe("toSemanticFeedItem", () => {
  test("returns null for unknown events", () => {
    expect(toSemanticFeedItem(createEvent())).toBeNull();
  });
});

describe("buildDisplayFeed", () => {
  test("groups consecutive events of the same type in raw-pretty mode", () => {
    const feed = projectWireToFeed([
      createEvent({ offset: 1, type: "https://events.iterate.com/demo/a" }),
      createEvent({ offset: 2, type: "https://events.iterate.com/demo/a" }),
      createEvent({ offset: 3, type: "https://events.iterate.com/demo/b" }),
    ]);
    const eventFeed = feed.filter((item): item is EventFeedItem => item.kind === "event");

    expect(buildDisplayFeed(feed, "raw-pretty")).toEqual([
      createGroupedOrSingleEvent(eventFeed.slice(0, 2)),
      eventFeed[2],
    ]);
  });

  test("flushes an event group when a non-event item appears", () => {
    const eventFeed = projectWireToFeed([
      createEvent({ offset: 1, type: "https://events.iterate.com/demo/a" }),
      createEvent({ offset: 2, type: "https://events.iterate.com/demo/a" }),
      createEvent({ offset: 3, type: "https://events.iterate.com/demo/b" }),
    ]).filter((item): item is EventFeedItem => item.kind === "event");

    const message: StreamFeedItem = {
      kind: "message",
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      timestamp: 123,
    };

    const feed: StreamFeedItem[] = [eventFeed[0], eventFeed[1], message, eventFeed[2]];

    expect(buildDisplayFeed(feed, "raw-pretty")).toEqual([
      createGroupedOrSingleEvent(eventFeed.slice(0, 2)),
      message,
      eventFeed[2],
    ]);
  });

  test("drops raw event rows in pretty mode", () => {
    const feed = projectWireToFeed([
      createEvent({ offset: 1, type: "https://events.iterate.com/demo/a" }),
    ]);

    const message: StreamFeedItem = {
      kind: "message",
      role: "assistant",
      content: [{ type: "text", text: "semantic" }],
      timestamp: 123,
    };

    expect(buildDisplayFeed([...feed, message], "pretty")).toEqual([message]);
  });

  test("keeps semantic stream lifecycle rows in pretty mode", () => {
    const feed = projectWireToFeed([
      createEvent({
        streamPath: "/",
        offset: 1,
        type: "https://events.iterate.com/events/stream/child-stream-created",
        payload: { childPath: "/created" },
      }),
      createEvent({
        streamPath: "/created",
        offset: 2,
        type: "https://events.iterate.com/events/stream/metadata-updated",
        payload: { metadata: { color: "blue" } },
      }),
    ]);

    expect(buildDisplayFeed(feed, "pretty")?.map((item) => item.kind)).toEqual([
      "child-stream-created",
      "stream-metadata-updated",
    ]);
  });

  test("returns null in raw mode", () => {
    const feed = projectWireToFeed([
      createEvent({ offset: 1, type: "https://events.iterate.com/demo/a" }),
    ]);

    expect(buildDisplayFeed(feed, "raw")).toBeNull();
  });
});

describe("getAdjacentEventOffset", () => {
  test("returns previous and next offsets within the raw event list", () => {
    const events = getEventFeedItems(
      projectWireToFeed([
        createEvent({ offset: 1, type: "https://events.iterate.com/demo/a" }),
        createEvent({ offset: 2, type: "https://events.iterate.com/demo/b" }),
        createEvent({
          offset: 3,
          type: "https://events.iterate.com/events/stream/child-stream-created",
          payload: { childPath: "/child" },
        }),
      ]),
    );

    expect(getAdjacentEventOffset(events, 2, "previous")).toBe(1);
    expect(getAdjacentEventOffset(events, 2, "next")).toBe(3);
    expect(getAdjacentEventOffset(events, 1, "previous")).toBeUndefined();
    expect(getAdjacentEventOffset(events, 3, "next")).toBeUndefined();
  });
});

function createEvent(overrides: Partial<Event> = {}): Event {
  return {
    streamPath: "/demo",
    type: "https://events.iterate.com/manual-event-appended",
    payload: {},
    offset: 1,
    createdAt: "2026-03-30T00:00:00.000Z",
    ...overrides,
  };
}

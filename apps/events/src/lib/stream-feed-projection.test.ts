import { describe, expect, test } from "vitest";
import { type Event } from "@iterate-com/events-contract";
import {
  buildDisplayFeed,
  createGroupedOrSingleEvent,
  getAdjacentEventOffset,
  getEventFeedItems,
  projectWireToFeed,
  toEventFeedItem,
  toSemanticFeedItem,
} from "~/lib/stream-feed-projection.ts";
import {
  buildCustomHtmlRendererInsertions,
  buildCustomHtmlRendererProjection,
} from "~/lib/custom-html-renderers.ts";
import type { StreamFeedItem } from "~/lib/stream-feed-types.ts";

describe("toEventFeedItem", () => {
  test("maps contract events to feed events", () => {
    const event = createEvent({
      streamPath: "/demo",
      type: "events.iterate.com/demo/created",
      offset: 5,
      createdAt: "2026-03-30T12:34:56.000Z",
      payload: { ok: true },
    });

    expect(toEventFeedItem(event)).toEqual({
      kind: "event",
      streamPath: "/demo",
      offset: 5,
      createdAt: "2026-03-30T12:34:56.000Z",
      eventType: "events.iterate.com/demo/created",
      timestamp: Date.parse("2026-03-30T12:34:56.000Z"),
      raw: event,
    });
  });
});

describe("projectWireToFeed", () => {
  test("projects every wire event into the feed timeline", () => {
    const events = [
      createEvent({ offset: 1, type: "events.iterate.com/demo/one" }),
      createEvent({ offset: 2, type: "events.iterate.com/demo/two" }),
    ];

    expect(projectWireToFeed(events).map((item) => item.kind)).toEqual(["event", "event"]);
  });

  test("adds semantic rows for core stream events", () => {
    const feed = projectWireToFeed([
      createEvent({
        streamPath: "/",
        offset: 1,
        type: "events.iterate.com/core/child-stream-created",
        payload: { childPath: "/child-stream" },
      }),
      createEvent({
        streamPath: "/demo",
        offset: 2,
        type: "events.iterate.com/core/metadata-updated",
        payload: { metadata: { owner: "jonas" } },
      }),
    ]);

    expect(feed.map((item) => item.kind)).toEqual([
      "event",
      "child-stream-created",
      "event",
      "stream-metadata-updated",
    ]);
    expect(feed[1]).toMatchObject({
      kind: "child-stream-created",
      parentPath: "/",
      createdPath: "/child-stream",
    });
    expect(feed[3]).toMatchObject({
      kind: "stream-metadata-updated",
      path: "/demo",
      metadata: { owner: "jonas" },
    });
  });

  test("projects callable subscription events for the feed", () => {
    const feed = projectWireToFeed([
      createEvent({
        offset: 1,
        type: "events.iterate.com/core/subscription-configured",
        payload: {
          slug: "agent",
          type: "websocket",
          callable: {
            type: "fetch",
            via: {
              type: "url",
              url: "https://agents.example.com/socket",
            },
          },
        },
      }),
    ]);

    expect(feed).toMatchObject([
      {
        kind: "event",
      },
      {
        kind: "external-subscriber-configured",
        subscriber: {
          slug: "agent",
          type: "websocket",
          callable: {
            type: "fetch",
            via: {
              type: "url",
              url: "https://agents.example.com/socket",
            },
          },
        },
      },
    ]);
  });

  test("projects canonical agent, agent-chat, and codemode events", () => {
    const assistantMessage = [
      "Working on it.",
      "",
      "```typescript",
      "const ok: boolean = true;",
      "```",
    ].join("\n");
    const feed = projectWireToFeed([
      createEvent({
        offset: 1,
        type: "events.iterate.com/agent/input-added",
        payload: { content: "Run code" },
      }),
      createEvent({
        offset: 2,
        type: "events.iterate.com/agent-chat/agent-response-added",
        payload: { channel: "web", message: assistantMessage },
      }),
      createEvent({
        offset: 3,
        type: "events.iterate.com/agent/status-updated",
        payload: { status: "working", reason: "llm-request-started", requestId: "req_1" },
      }),
      createEvent({
        offset: 4,
        type: "events.iterate.com/codemode/block-added",
        payload: { script: "return await tools.echo({ text: 'hello' });" },
      }),
      createEvent({
        offset: 5,
        type: "events.iterate.com/codemode/result-added",
        payload: { result: { ok: true }, logs: ["hello"], durationMs: 12 },
      }),
    ]);

    expect(feed.map((item) => item.kind)).toEqual([
      "event",
      "message",
      "event",
      "message",
      "event",
      "agent-status",
      "event",
      "codemode-block",
      "event",
      "codemode-result",
    ]);
    expect(feed[1]).toMatchObject({ kind: "message", role: "user" });
    expect(feed[3]).toMatchObject({
      kind: "message",
      role: "assistant",
      content: [{ type: "markdown", text: assistantMessage }],
    });
    expect(feed[5]).toMatchObject({ kind: "agent-status", requestId: "req_1" });
    expect(feed[7]).toMatchObject({
      kind: "codemode-block",
      blockId: "codemode",
      code: expect.stringContaining("tools.echo"),
    });
    expect(feed[9]).toMatchObject({
      kind: "codemode-result",
      success: true,
      stdout: expect.stringContaining("hello"),
    });
  });

  test("extracts only raw event rows from a mixed feed", () => {
    const feed = projectWireToFeed([
      createEvent({
        streamPath: "/",
        type: "events.iterate.com/core/child-stream-created",
        payload: { childPath: "/child-stream" },
      }),
    ]);

    expect(getEventFeedItems(feed).map((item) => item.kind)).toEqual(["event"]);
  });
});

describe("toSemanticFeedItem", () => {
  test("returns null for unknown events", () => {
    expect(toSemanticFeedItem(createEvent())).toBeNull();
  });
});

describe("buildCustomHtmlRendererInsertions", () => {
  test("applies final slug-keyed renderers retroactively to matching events", async () => {
    const events = [
      createEvent({
        offset: 1,
        type: "demo.message",
        payload: { title: "Before", body: "Rendered before config" },
      }),
      createEvent({
        offset: 2,
        type: "events.iterate.com/core/html-renderer-configured",
        payload: {
          slug: "demo-card",
          matcher: "type = 'demo.message'",
          template: "<h3>{{payload.title}}</h3><p>{{payload.body}}</p>",
        },
      }),
      createEvent({
        offset: 3,
        type: "demo.message",
        payload: { title: "After", body: "Rendered after config" },
      }),
    ];

    const insertions = await buildCustomHtmlRendererInsertions(events);
    const feed = projectWireToFeed(events, { customInsertionsByOffset: insertions });

    expect(feed.map((item) => item.kind)).toEqual([
      "event",
      "custom-html-rendered-event",
      "event",
      "event",
      "custom-html-rendered-event",
    ]);
    expect(feed[1]).toMatchObject({
      kind: "custom-html-rendered-event",
      slug: "demo-card",
      html: "<h3>Before</h3><p>Rendered before config</p>",
    });
    expect(feed[4]).toMatchObject({
      kind: "custom-html-rendered-event",
      slug: "demo-card",
      html: "<h3>After</h3><p>Rendered after config</p>",
    });
  });

  test("renders once per matching renderer slug and latest config wins", async () => {
    const events = [
      createEvent({
        offset: 1,
        type: "events.iterate.com/core/html-renderer-configured",
        payload: {
          slug: "summary",
          matcher: "type = 'demo.message'",
          template: "old {{payload.title}}",
        },
      }),
      createEvent({
        offset: 2,
        type: "events.iterate.com/core/html-renderer-configured",
        payload: {
          slug: "detail",
          matcher: "payload.title = 'Hello'",
          template: "detail {{payload.body}}",
        },
      }),
      createEvent({
        offset: 3,
        type: "events.iterate.com/core/html-renderer-configured",
        payload: {
          slug: "summary",
          matcher: "type = 'demo.message'",
          template: "new {{payload.title}}",
        },
      }),
      createEvent({
        offset: 4,
        type: "demo.message",
        payload: { title: "Hello", body: "World" },
      }),
    ];

    const insertions = await buildCustomHtmlRendererInsertions(events);

    expect(insertions.get(4)).toEqual([
      expect.objectContaining({
        kind: "custom-html-rendered-event",
        slug: "summary",
        html: "new Hello",
      }),
      expect.objectContaining({
        kind: "custom-html-rendered-event",
        slug: "detail",
        html: "detail World",
      }),
    ]);
  });

  test("emits a render error item when a matcher fails", async () => {
    const insertions = await buildCustomHtmlRendererInsertions([
      createEvent({
        offset: 1,
        type: "events.iterate.com/core/html-renderer-configured",
        payload: {
          slug: "bad-card",
          matcher: "$error('boom')",
          template: "{{payload.title}}",
        },
      }),
      createEvent({ offset: 2, type: "demo.message", payload: { title: "Hello" } }),
    ]);

    expect(insertions.get(2)).toEqual([
      expect.objectContaining({
        kind: "custom-html-render-error",
        slug: "bad-card",
        eventType: "demo.message",
      }),
    ]);
  });

  test("projects appended events incrementally until renderer config changes", async () => {
    const firstEvents = [
      createEvent({
        offset: 1,
        type: "events.iterate.com/core/html-renderer-configured",
        payload: {
          slug: "demo-card",
          matcher: "type = 'demo.message'",
          template: "one {{payload.title}}",
        },
      }),
      createEvent({ offset: 2, type: "demo.message", payload: { title: "First" } }),
    ];
    const firstProjection = await buildCustomHtmlRendererProjection({ events: firstEvents });
    const appendedProjection = await buildCustomHtmlRendererProjection({
      events: [
        ...firstEvents,
        createEvent({ offset: 3, type: "demo.message", payload: { title: "Second" } }),
      ],
      previousProjection: firstProjection,
    });

    expect(appendedProjection.insertionsByOffset.get(2)).toBe(
      firstProjection.insertionsByOffset.get(2),
    );
    expect(appendedProjection.insertionsByOffset.get(3)).toEqual([
      expect.objectContaining({ html: "one Second" }),
    ]);
  });
});

describe("buildDisplayFeed", () => {
  test("keeps only raw events, ungrouped, in raw mode", () => {
    const feed = projectWireToFeed([
      createEvent({ offset: 1, type: "events.iterate.com/demo/a" }),
      createEvent({ offset: 2, type: "events.iterate.com/demo/a" }),
    ]);

    expect(buildDisplayFeed(feed, "raw")?.map((item) => item.kind)).toEqual(["event", "event"]);
  });

  test("groups consecutive events of the same type in raw-pretty mode", () => {
    const grouped = createGroupedOrSingleEvent([
      toEventFeedItem(createEvent({ offset: 1, type: "events.iterate.com/demo/a" })),
      toEventFeedItem(createEvent({ offset: 2, type: "events.iterate.com/demo/a" })),
    ]);

    expect(grouped).toMatchObject({
      kind: "grouped-event",
      eventType: "events.iterate.com/demo/a",
      count: 2,
    });
  });

  test("drops raw event rows in pretty mode", () => {
    const message: StreamFeedItem = {
      kind: "message",
      role: "assistant",
      content: [{ type: "text", text: "semantic" }],
      timestamp: 123,
    };

    expect(
      buildDisplayFeed(
        [toEventFeedItem(createEvent({ type: "events.iterate.com/demo/a" })), message],
        "pretty",
      ),
    ).toEqual([message]);
  });

  test("returns null in raw-single-json mode", () => {
    expect(
      buildDisplayFeed(
        [toEventFeedItem(createEvent({ type: "events.iterate.com/demo/a" }))],
        "raw-single-json",
      ),
    ).toBeNull();
  });
});

describe("getAdjacentEventOffset", () => {
  test("returns previous and next offsets within the raw event list", () => {
    const events = getEventFeedItems(
      projectWireToFeed([
        createEvent({ offset: 1, type: "events.iterate.com/demo/a" }),
        createEvent({ offset: 2, type: "events.iterate.com/demo/b" }),
        createEvent({
          offset: 3,
          type: "events.iterate.com/core/child-stream-created",
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
    type: "events.iterate.com/manual-event-appended",
    payload: {},
    offset: 1,
    createdAt: "2026-03-30T00:00:00.000Z",
    ...overrides,
  };
}

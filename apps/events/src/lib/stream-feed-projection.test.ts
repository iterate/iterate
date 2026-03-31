import { describe, expect, test } from "vitest";
import {
  STREAM_CREATED_TYPE,
  STREAM_METADATA_UPDATED_TYPE,
  type Event,
} from "@iterate-com/events-contract";
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
      path: "/demo",
      type: "https://events.iterate.com/demo/created",
      offset: "5",
      createdAt: "2026-03-30T12:34:56.000Z",
      payload: { ok: true },
    });

    expect(toEventFeedItem(event)).toEqual({
      kind: "event",
      path: "/demo",
      offset: "5",
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
      createEvent({ offset: "1", type: "https://events.iterate.com/demo/one" }),
      createEvent({ offset: "2", type: "https://events.iterate.com/demo/two" }),
    ];

    expect(projectWireToFeed(events).map((item) => item.kind)).toEqual(["event", "event"]);
  });

  test("adds a semantic child-stream item after stream-created events", () => {
    const feed = projectEventToFeed(
      createEvent({
        path: "/",
        type: STREAM_CREATED_TYPE,
        payload: { path: "/child-stream" },
      }),
    );

    expect(feed.map((item) => item.kind)).toEqual(["event", "stream-created"]);
    expect(feed[1]).toMatchObject({
      kind: "stream-created",
      parentPath: "/",
      createdPath: "/child-stream",
    });
  });

  test("adds a semantic metadata item after metadata-updated events", () => {
    const feed = projectEventToFeed(
      createEvent({
        path: "/demo",
        type: STREAM_METADATA_UPDATED_TYPE,
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
        path: "/",
        type: STREAM_CREATED_TYPE,
        payload: { path: "/child-stream" },
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

describe("buildDisplayFeed", () => {
  test("groups consecutive events of the same type in raw-pretty mode", () => {
    const feed = projectWireToFeed([
      createEvent({ offset: "1", type: "https://events.iterate.com/demo/a" }),
      createEvent({ offset: "2", type: "https://events.iterate.com/demo/a" }),
      createEvent({ offset: "3", type: "https://events.iterate.com/demo/b" }),
    ]);
    const eventFeed = feed.filter((item): item is EventFeedItem => item.kind === "event");

    expect(buildDisplayFeed(feed, "raw-pretty")).toEqual([
      createGroupedOrSingleEvent(eventFeed.slice(0, 2)),
      eventFeed[2],
    ]);
  });

  test("flushes an event group when a non-event item appears", () => {
    const eventFeed = projectWireToFeed([
      createEvent({ offset: "1", type: "https://events.iterate.com/demo/a" }),
      createEvent({ offset: "2", type: "https://events.iterate.com/demo/a" }),
      createEvent({ offset: "3", type: "https://events.iterate.com/demo/b" }),
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
      createEvent({ offset: "1", type: "https://events.iterate.com/demo/a" }),
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
        path: "/",
        offset: "1",
        type: STREAM_CREATED_TYPE,
        payload: { path: "/created" },
      }),
      createEvent({
        path: "/created",
        offset: "2",
        type: STREAM_METADATA_UPDATED_TYPE,
        payload: { metadata: { color: "blue" } },
      }),
    ]);

    expect(buildDisplayFeed(feed, "pretty")?.map((item) => item.kind)).toEqual([
      "stream-created",
      "stream-metadata-updated",
    ]);
  });

  test("returns null in raw mode", () => {
    const feed = projectWireToFeed([
      createEvent({ offset: "1", type: "https://events.iterate.com/demo/a" }),
    ]);

    expect(buildDisplayFeed(feed, "raw")).toBeNull();
  });
});

describe("getAdjacentEventOffset", () => {
  test("returns previous and next offsets within the raw event list", () => {
    const events = getEventFeedItems(
      projectWireToFeed([
        createEvent({ offset: "1", type: "https://events.iterate.com/demo/a" }),
        createEvent({ offset: "2", type: "https://events.iterate.com/demo/b" }),
        createEvent({ offset: "3", type: STREAM_CREATED_TYPE, payload: { path: "/child" } }),
      ]),
    );

    expect(getAdjacentEventOffset(events, "2", "previous")).toBe("1");
    expect(getAdjacentEventOffset(events, "2", "next")).toBe("3");
    expect(getAdjacentEventOffset(events, "1", "previous")).toBeUndefined();
    expect(getAdjacentEventOffset(events, "3", "next")).toBeUndefined();
  });
});

function createEvent(overrides: Partial<Event> = {}): Event {
  return {
    path: "/demo",
    type: "https://events.iterate.com/manual-event-appended",
    payload: {},
    offset: "1",
    createdAt: "2026-03-30T00:00:00.000Z",
    ...overrides,
  };
}

import { describe, expect, test } from "vitest";
import { summarizeStreamFeed } from "~/lib/stream-feed-summary.ts";
import type { StreamFeedItem } from "~/lib/stream-feed-types.ts";

describe("summarizeStreamFeed", () => {
  test("counts raw event rows vs semantic insertions", () => {
    const feed: StreamFeedItem[] = [
      {
        kind: "event",
        streamPath: "/",
        offset: 1,
        createdAt: "2026-03-30T00:00:00.000Z",
        eventType: "https://events.iterate.com/demo/a",
        timestamp: 1,
        raw: {} as never,
      },
      {
        kind: "message",
        role: "user",
        content: [{ type: "text", text: "hi" }],
        timestamp: 2,
      },
    ];

    expect(summarizeStreamFeed(feed)).toEqual({ rawEvents: 1, semanticItems: 1 });
  });
});

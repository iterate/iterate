import { describe, expect, test } from "vitest";
import { FEED_ITEM_PUBLISHED } from "@iterate-com/ui/components/events/feed-publication";
import { foldFeedPublications, type FeedStreamEvent } from "./agent-feed.ts";

function published(
  offset: number,
  item: { id: string; text: string },
  revision: { firstOffset: number; ordinal?: number; revisionOffset: number },
): FeedStreamEvent {
  return {
    offset,
    type: FEED_ITEM_PUBLISHED,
    payload: {
      item: { kind: "assistant", id: item.id, text: item.text, timestampMs: 1 },
      firstOffset: revision.firstOffset,
      ordinal: revision.ordinal ?? 0,
      revisionOffset: revision.revisionOffset,
    },
  };
}

describe("foldFeedPublications", () => {
  test.each<{ name: string; events: FeedStreamEvent[]; becomes: string[] }>([
    {
      name: "publications in order",
      events: [
        published(10, { id: "a", text: "one" }, { firstOffset: 5, revisionOffset: 5 }),
        published(20, { id: "b", text: "two" }, { firstOffset: 15, revisionOffset: 15 }),
      ],
      becomes: ["a:one", "b:two"],
    },
    {
      name: "a late correction keeps its row",
      events: [
        published(10, { id: "a", text: "draft" }, { firstOffset: 5, revisionOffset: 5 }),
        published(20, { id: "b", text: "two" }, { firstOffset: 15, revisionOffset: 15 }),
        published(30, { id: "a", text: "final" }, { firstOffset: 5, revisionOffset: 25 }),
      ],
      becomes: ["a:final", "b:two"],
    },
    {
      name: "an older revision arriving later is ignored",
      events: [
        published(30, { id: "a", text: "final" }, { firstOffset: 5, revisionOffset: 25 }),
        published(10, { id: "a", text: "draft" }, { firstOffset: 5, revisionOffset: 5 }),
      ],
      becomes: ["a:final"],
    },
    {
      name: "a duplicate delivery changes nothing",
      events: [
        published(10, { id: "a", text: "one" }, { firstOffset: 5, revisionOffset: 5 }),
        published(10, { id: "a", text: "one" }, { firstOffset: 5, revisionOffset: 5 }),
      ],
      becomes: ["a:one"],
    },
    {
      name: "a delayed first publication appends after existing rows",
      events: [
        published(10, { id: "a", text: "one" }, { firstOffset: 5, revisionOffset: 5 }),
        published(
          20,
          { id: "b", text: "older source, later publication" },
          { firstOffset: 3, revisionOffset: 3 },
        ),
      ],
      becomes: ["a:one", "b:older source, later publication"],
    },
    {
      name: "other event types are skipped",
      events: [
        { offset: 1, type: "events.iterate.com/stream/created", payload: {} },
        published(10, { id: "a", text: "one" }, { firstOffset: 5, revisionOffset: 5 }),
      ],
      becomes: ["a:one"],
    },
  ])("$name", ({ events, becomes }) => {
    const fold = foldFeedPublications(events);
    expect(
      fold.items.map((item) => `${item.id}:${item.kind === "assistant" ? item.text : ""}`),
    ).toEqual(becomes);
  });

  test("cursors: the newest publication event and the newest event overall", () => {
    const fold = foldFeedPublications([
      published(10, { id: "a", text: "one" }, { firstOffset: 5, revisionOffset: 5 }),
      { offset: 12, type: "events.iterate.com/stream/created", payload: {} },
    ]);
    expect(fold.latestPublicationOffset).toBe(10);
    expect(fold.lastOffset).toBe(12);
    expect([...fold.publishedIds]).toEqual(["a"]);
  });
});

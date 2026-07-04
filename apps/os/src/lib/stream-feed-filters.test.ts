import { describe, expect, it } from "vitest";
import {
  buildFeedItemsFilter,
  feedFiltersActive,
  presetsForStream,
  shortEventType,
} from "./stream-feed-filters.ts";

describe("presetsForStream", () => {
  it("puts the domain default first and Everything last", () => {
    expect(presetsForStream("/agents/slack/general").map((preset) => preset.id)).toEqual([
      "agent-chat",
      "agent-events",
      "everything",
    ]);
    expect(presetsForStream("/secrets/OPENAI_API_KEY").map((preset) => preset.id)).toEqual([
      "secret-events",
      "everything",
    ]);
  });

  it("offers only the unfiltered feed on undomained streams", () => {
    expect(presetsForStream("/sandboxes").map((preset) => preset.id)).toEqual(["everything"]);
  });
});

describe("buildFeedItemsFilter", () => {
  it("returns null when nothing narrows the feed", () => {
    expect(
      buildFeedItemsFilter({
        eventTypes: null,
        eventTypePrefix: null,
        searchQuery: null,
        offsetFrom: null,
        offsetTo: null,
      }),
    ).toBeNull();
  });

  it("composes prefix, any-of types, search, and offset bounds into one WHERE", () => {
    const filter = buildFeedItemsFilter({
      eventTypes: ["events.iterate.com/agent/input-added", "events.iterate.com/agent/turn-ended"],
      eventTypePrefix: "events.iterate.com/agent/",
      searchQuery: "hello",
      offsetFrom: 10,
      offsetTo: 99,
    });
    expect(filter?.whereSql).toMatchInlineSnapshot(
      `"COALESCE(json_extract(data, '$.eventType'), json_extract(data, '$.events[0].type')) LIKE ? AND COALESCE(json_extract(data, '$.eventType'), json_extract(data, '$.events[0].type')) IN (?, ?) AND json(data) LIKE ? AND last_offset >= ? AND first_offset <= ?"`,
    );
    expect(filter?.params).toEqual([
      "events.iterate.com/agent/%",
      "events.iterate.com/agent/input-added",
      "events.iterate.com/agent/turn-ended",
      "%hello%",
      10,
      99,
    ]);
  });

  it("matches groups that only OVERLAP the offset bounds", () => {
    // A group row spanning #5–#15 must survive from=10: its last_offset (15)
    // is past the lower bound even though its first_offset (5) is not.
    const filter = buildFeedItemsFilter({
      eventTypes: null,
      eventTypePrefix: null,
      searchQuery: null,
      offsetFrom: 10,
      offsetTo: null,
    });
    expect(filter?.whereSql).toBe("last_offset >= ?");
  });
});

describe("feedFiltersActive", () => {
  const agentPath = "/agents/slack/general";
  const secretPath = "/secrets/OPENAI_API_KEY";

  it("is inactive on the stream's defaults", () => {
    expect(feedFiltersActive({}, agentPath)).toBe(false);
    expect(feedFiltersActive({ preset: "agent-chat" }, agentPath)).toBe(false);
  });

  it("signals any deviation, including while the row is closed", () => {
    expect(feedFiltersActive({ preset: "everything" }, agentPath)).toBe(true);
    expect(feedFiltersActive({ q: "boom" }, agentPath)).toBe(true);
    expect(feedFiltersActive({ types: ["a"] }, secretPath)).toBe(true);
    expect(feedFiltersActive({ from: 1 }, secretPath)).toBe(true);
    expect(feedFiltersActive({ to: 9 }, secretPath)).toBe(true);
  });

  it("judges what the feed renders, not the raw URL", () => {
    // A stale/unknown preset id falls back to the default preset in the view.
    expect(feedFiltersActive({ preset: "no-such-preset" }, agentPath)).toBe(false);
    // Another stream's preset id also resolves to this stream's default.
    expect(feedFiltersActive({ preset: "secret-events" }, agentPath)).toBe(false);
    // An empty types array applies no constraint in buildFeedItemsFilter.
    expect(feedFiltersActive({ types: [] }, secretPath)).toBe(false);
    // The agent-chat view honors only text search — feed-items-only filters
    // left in the URL don't light the dot while chat ignores them.
    expect(feedFiltersActive({ types: ["a"], from: 1, to: 9 }, agentPath)).toBe(false);
    expect(feedFiltersActive({ preset: "agent-events", types: ["a"] }, agentPath)).toBe(true);
  });
});

describe("shortEventType", () => {
  it("drops the events.iterate.com/ prefix and leaves foreign types alone", () => {
    expect(shortEventType("events.iterate.com/agent/input-added")).toBe("agent/input-added");
    expect(shortEventType("com.example/custom")).toBe("com.example/custom");
  });
});

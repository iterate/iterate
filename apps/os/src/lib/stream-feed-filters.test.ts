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
    expect(feedFiltersActive({ mode: "pretty" }, agentPath)).toBe(false);
    expect(feedFiltersActive({}, secretPath)).toBe(false);
  });

  it("signals search on pretty modes", () => {
    expect(feedFiltersActive({ q: "boom" }, agentPath)).toBe(true);
    expect(feedFiltersActive({ mode: "pretty-debug", q: "x" }, agentPath)).toBe(true);
  });

  it("ignores feed-items-only filters while in pretty mode", () => {
    expect(feedFiltersActive({ types: ["a"], from: 1, to: 9 }, agentPath)).toBe(false);
  });

  it("signals raw/feed-items filter deviations", () => {
    expect(feedFiltersActive({ mode: "raw", preset: "everything" }, agentPath)).toBe(true);
    expect(feedFiltersActive({ mode: "raw", q: "boom" }, agentPath)).toBe(true);
    expect(feedFiltersActive({ types: ["a"] }, secretPath)).toBe(true);
    expect(feedFiltersActive({ from: 1 }, secretPath)).toBe(true);
    expect(feedFiltersActive({ to: 9 }, secretPath)).toBe(true);
  });

  it("judges what the feed renders, not the raw URL", () => {
    expect(feedFiltersActive({ preset: "no-such-preset" }, secretPath)).toBe(false);
    expect(feedFiltersActive({ types: [] }, secretPath)).toBe(false);
  });
});

describe("shortEventType", () => {
  it("drops the events.iterate.com/ prefix and leaves foreign types alone", () => {
    expect(shortEventType("events.iterate.com/agent/input-added")).toBe("agent/input-added");
    expect(shortEventType("com.example/custom")).toBe("com.example/custom");
  });
});

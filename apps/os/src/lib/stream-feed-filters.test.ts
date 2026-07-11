import { describe, expect, it } from "vitest";
import {
  buildFeedItemsFilter,
  buildStreamFeedWhere,
  defaultPresetForMode,
  feedFiltersActive,
  feedItemsFilterFromSearch,
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

describe("defaultPresetForMode", () => {
  it("uses Everything for pretty-raw so the raw rail is unscoped", () => {
    expect(defaultPresetForMode("/agents/x", "pretty-raw").id).toBe("everything");
  });

  it("uses the domain family for raw", () => {
    expect(defaultPresetForMode("/agents/x", "raw").id).toBe("agent-events");
  });
});

describe("buildFeedItemsFilter", () => {
  it("returns null when nothing narrows the feed", () => {
    expect(
      buildFeedItemsFilter({
        eventTypes: null,
        components: null,
        eventTypePrefix: null,
        searchQuery: null,
        offsetFrom: null,
        offsetTo: null,
      }),
    ).toBeNull();
  });

  it("composes prefix, event types, raw kinds, search, and offset bounds", () => {
    const filter = buildFeedItemsFilter({
      eventTypes: ["events.iterate.com/agent/input-added", "events.iterate.com/agent/turn-ended"],
      components: ["raw.group", "raw.stream.woken"],
      eventTypePrefix: "events.iterate.com/agent/",
      searchQuery: "hello",
      offsetFrom: 10,
      offsetTo: 99,
    });
    expect(filter?.whereSql).toMatchInlineSnapshot(
      `"COALESCE(json_extract(data, '$.eventType'), json_extract(data, '$.events[0].type')) LIKE ? AND COALESCE(json_extract(data, '$.eventType'), json_extract(data, '$.events[0].type')) IN (?, ?) AND kind IN (?, ?) AND json(data) LIKE ? AND last_offset >= ? AND first_offset <= ?"`,
    );
    expect(filter?.params).toEqual([
      "events.iterate.com/agent/%",
      "events.iterate.com/agent/input-added",
      "events.iterate.com/agent/turn-ended",
      "raw.group",
      "raw.stream.woken",
      "%hello%",
      10,
      99,
    ]);
  });

  it("matches groups that only OVERLAP the offset bounds", () => {
    const filter = buildFeedItemsFilter({
      eventTypes: null,
      components: null,
      eventTypePrefix: null,
      searchQuery: null,
      offsetFrom: 10,
      offsetTo: null,
    });
    expect(filter?.whereSql).toBe("last_offset >= ?");
  });
});

describe("feedItemsFilterFromSearch", () => {
  it("encodes pretty-raw defaults as unscoped everything", () => {
    expect(feedItemsFilterFromSearch({ mode: "pretty-raw" }, "/agents/x")).toMatchObject({
      eventTypePrefix: null,
      eventTypes: null,
      components: null,
    });
  });

  it("honors raw group type filters in pretty-raw without applying pretty search", () => {
    expect(
      feedItemsFilterFromSearch(
        {
          mode: "pretty-raw",
          components: ["raw.stream.woken"],
          types: ["events.iterate.com/stream/woken"],
          q: "only-pretty",
          from: 10,
        },
        "/agents/x",
      ),
    ).toEqual({
      eventTypes: ["events.iterate.com/stream/woken"],
      components: ["raw.stream.woken"],
      eventTypePrefix: null,
      searchQuery: null,
      offsetFrom: null,
      offsetTo: null,
    });
  });

  it("honors components + types from the URL in raw mode", () => {
    expect(
      feedItemsFilterFromSearch(
        {
          mode: "raw",
          components: ["raw.stream.woken"],
          types: ["events.iterate.com/stream/woken"],
        },
        "/agents/x",
      ),
    ).toMatchObject({
      components: ["raw.stream.woken"],
      eventTypes: ["events.iterate.com/stream/woken"],
      eventTypePrefix: "events.iterate.com/agent/",
    });
  });
});

describe("buildStreamFeedWhere", () => {
  const unscopedRaw = {
    eventTypes: null,
    components: null,
    eventTypePrefix: null,
    searchQuery: null,
    offsetFrom: null,
    offsetTo: null,
  };

  it("shows only agent rows in Pretty (minus debug kinds)", () => {
    const { whereSql, params } = buildStreamFeedWhere({
      agent: { showDebug: false, searchQuery: null },
      raw: null,
    });
    expect(whereSql).toBe(`kind LIKE 'agent.%' AND kind NOT IN (?)`);
    expect(params).toEqual(["agent.stream-woken"]);
  });

  it("shows only raw rows in Raw", () => {
    const { whereSql } = buildStreamFeedWhere({ agent: null, raw: unscopedRaw });
    expect(whereSql).toBe(`kind LIKE 'raw.%'`);
  });

  it("ORs the two kind families in Pretty+raw so raw filters never hide agent rows", () => {
    const { whereSql, params } = buildStreamFeedWhere({
      agent: { showDebug: true, searchQuery: "hello" },
      raw: { ...unscopedRaw, components: ["raw.group"] },
    });
    expect(whereSql).toBe(
      `(kind LIKE 'agent.%' AND json(data) LIKE ?) OR (kind LIKE 'raw.%' AND kind IN (?))`,
    );
    expect(params).toEqual(["%hello%", "raw.group"]);
  });

  it("matches nothing when both sides are hidden", () => {
    expect(buildStreamFeedWhere({ agent: null, raw: null }).whereSql).toBe("0");
  });
});

describe("feedFiltersActive", () => {
  const agentPath = "/agents/slack/general";
  const secretPath = "/secrets/OPENAI_API_KEY";

  it("is inactive on the stream's defaults", () => {
    expect(feedFiltersActive({}, agentPath)).toBe(false);
    expect(feedFiltersActive({ mode: "pretty" }, agentPath)).toBe(false);
    expect(feedFiltersActive({ mode: "pretty-raw" }, agentPath)).toBe(false);
    expect(feedFiltersActive({}, secretPath)).toBe(false);
  });

  it("signals search on pretty modes", () => {
    expect(feedFiltersActive({ q: "boom" }, agentPath)).toBe(true);
    expect(feedFiltersActive({ mode: "pretty-raw", q: "x" }, agentPath)).toBe(true);
  });

  it("ignores feed-items-only filters while in pure pretty mode", () => {
    expect(feedFiltersActive({ types: ["a"], from: 1, to: 9 }, agentPath)).toBe(false);
  });

  it("signals raw filter deviations including components", () => {
    expect(feedFiltersActive({ mode: "raw", preset: "everything" }, agentPath)).toBe(true);
    expect(feedFiltersActive({ mode: "raw", q: "boom" }, agentPath)).toBe(true);
    expect(feedFiltersActive({ mode: "pretty-raw", components: ["raw.group"] }, agentPath)).toBe(
      true,
    );
    expect(feedFiltersActive({ types: ["a"] }, secretPath)).toBe(true);
    expect(feedFiltersActive({ from: 1 }, secretPath)).toBe(true);
  });

  it("does not treat pretty mode on non-agent paths as pretty (clamped to raw)", () => {
    // Hand-edited ?mode=pretty on a secret stream must not hide raw filters.
    expect(feedFiltersActive({ mode: "pretty", types: ["a"] }, secretPath)).toBe(true);
  });
});

describe("shortEventType", () => {
  it("drops the events.iterate.com/ prefix and leaves foreign types alone", () => {
    expect(shortEventType("events.iterate.com/agent/input-added")).toBe("agent/input-added");
    expect(shortEventType("com.example/custom")).toBe("com.example/custom");
  });
});

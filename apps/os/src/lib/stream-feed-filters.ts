// Pure logic for stream feed filter surfaces: feed-items presets, how
// URL-backed filters compile to SQL over the local feed_items mirror, and how
// event types / components render. Mode selection lives in stream-view-search.ts.
//
// Filter model (URL + mode presets):
//   - `types`      — primary event types inside a feed item (group eventType
//                    or singleton events[0].type)
//   - `components` — feed_items.component values (group, stream.woken, …)
//   - `q`/`from`/`to`/`preset` as before
// A row matches when it satisfies ALL active constraints. Modes decide which
// of these controls are shown (Pretty: search only; Pretty+raw / Raw: full).

import type { SqlValue } from "~/domains/streams/client-libraries/browser/stream-browser-db.ts";
import {
  modeCapabilities,
  streamViewMode,
  type StreamViewSearch,
} from "~/lib/stream-view-search.ts";

/**
 * One named configuration of the feed-items collection. Modes that show raw
 * feed_items pick a default; Pretty ignores these.
 */
export type StreamFeedPreset = { id: string; label: string } & {
  kind: "feed-items";
  eventTypePrefix?: string;
  /** Optional default component allowlist encoded by this preset. */
  components?: readonly string[];
};

const EVERYTHING_PRESET: StreamFeedPreset = {
  id: "everything",
  label: "Everything",
  kind: "feed-items",
};

/** Domain-specific event-type prefix presets, keyed by stream-path prefix. */
const DOMAIN_PRESETS: { pathPrefix: string; preset: StreamFeedPreset }[] = [
  {
    pathPrefix: "/agents/",
    preset: {
      id: "agent-events",
      label: "Agent events",
      kind: "feed-items",
      eventTypePrefix: "events.iterate.com/agent/",
    },
  },
  {
    pathPrefix: "/secrets/",
    preset: {
      id: "secret-events",
      label: "Secret events",
      kind: "feed-items",
      eventTypePrefix: "events.iterate.com/secret/",
    },
  },
  {
    pathPrefix: "/repos/",
    preset: {
      id: "repo-events",
      label: "Repo events",
      kind: "feed-items",
      eventTypePrefix: "events.iterate.com/repo/",
    },
  },
  {
    pathPrefix: "/integrations/slack",
    preset: {
      id: "slack-events",
      label: "Slack events",
      kind: "feed-items",
      eventTypePrefix: "events.iterate.com/slack/",
    },
  },
];

/**
 * Feed-items presets for Raw. FIRST is the domain default. Pretty+raw renders
 * the raw grouped rail unfiltered, regardless of URL filter params.
 */
export function presetsForStream(streamPath: string): StreamFeedPreset[] {
  const presets: StreamFeedPreset[] = [];
  for (const { pathPrefix, preset } of DOMAIN_PRESETS) {
    if (streamPath.startsWith(pathPrefix)) presets.push(preset);
  }
  presets.push(EVERYTHING_PRESET);
  return presets;
}

/**
 * Default feed-items preset for a mode. Pretty+raw is unscoped (Everything)
 * because its raw rail always shows the full stream; Raw uses the domain default.
 */
export function defaultPresetForMode(
  streamPath: string,
  mode: ReturnType<typeof streamViewMode>,
): StreamFeedPreset {
  const presets = presetsForStream(streamPath);
  if (mode === "pretty-raw") {
    return presets.find((preset) => preset.id === "everything") ?? presets[presets.length - 1]!;
  }
  return presets[0]!;
}

/**
 * Whether any feed filter deviates from the stream/mode defaults — drives the
 * header filter-toggle dot.
 */
export function feedFiltersActive(search: StreamViewSearch, streamPath: string): boolean {
  const mode = streamViewMode(search, streamPath);
  const caps = modeCapabilities(search, streamPath);
  const hasQuery = (search.q ?? "") !== "";
  if (!caps.rawFeed) {
    return caps.search && hasQuery;
  }

  if (mode === "pretty-raw") {
    return caps.search && hasQuery;
  }

  const defaultPreset = defaultPresetForMode(streamPath, mode);
  const activePreset =
    presetsForStream(streamPath).find((preset) => preset.id === search.preset) ?? defaultPreset;

  return (
    (caps.search && hasQuery) ||
    activePreset.id !== defaultPreset.id ||
    (caps.rawEventTypes && (search.types?.length ?? 0) > 0) ||
    (caps.rawComponents && (search.components?.length ?? 0) > 0) ||
    (caps.rawOffsets && (search.from != null || search.to != null))
  );
}

/**
 * Primary event type of a feed_items row — group `data.eventType` or a
 * singleton's first event type.
 */
export const FEED_TYPE_EXPRESSION = `COALESCE(json_extract(data, '$.eventType'), json_extract(data, '$.events[0].type'))`;

/**
 * How the feed_items (Raw) collection is narrowed. Modes and URL params map
 * into this; `eventTypePrefix` comes from the active preset, `components` and
 * `eventTypes` from the filter panel.
 */
export type FeedItemsFilterInput = {
  /** Exact primary event types (any-of); null = all. */
  eventTypes: readonly string[] | null;
  /** feed_items.component values (any-of); null = all. */
  components: readonly string[] | null;
  /** Active preset's event-type family; null = unscoped. */
  eventTypePrefix: string | null;
  searchQuery: string | null;
  offsetFrom: number | null;
  offsetTo: number | null;
};

type FeedItemsFilter = { whereSql: string; params: SqlValue[] } | null;

export function buildFeedItemsFilter(input: FeedItemsFilterInput): FeedItemsFilter {
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  if (input.eventTypePrefix != null) {
    clauses.push(`${FEED_TYPE_EXPRESSION} LIKE ?`);
    params.push(`${input.eventTypePrefix}%`);
  }
  if (input.eventTypes != null && input.eventTypes.length > 0) {
    clauses.push(`${FEED_TYPE_EXPRESSION} IN (${input.eventTypes.map(() => "?").join(", ")})`);
    params.push(...input.eventTypes);
  }
  if (input.components != null && input.components.length > 0) {
    clauses.push(`component IN (${input.components.map(() => "?").join(", ")})`);
    params.push(...input.components);
  }
  if (input.searchQuery != null) {
    clauses.push(`json(data) LIKE ?`);
    params.push(`%${input.searchQuery}%`);
  }
  if (input.offsetFrom != null) {
    clauses.push(`last_offset >= ?`);
    params.push(input.offsetFrom);
  }
  if (input.offsetTo != null) {
    clauses.push(`first_offset <= ?`);
    params.push(input.offsetTo);
  }
  if (clauses.length === 0) return null;
  return { whereSql: clauses.join(" AND "), params };
}

/** Resolve the effective feed_items filter from URL search + stream path + mode. */
export function feedItemsFilterFromSearch(
  search: StreamViewSearch,
  streamPath: string,
): FeedItemsFilterInput {
  const mode = streamViewMode(search, streamPath);
  if (mode === "pretty-raw") {
    return {
      eventTypes: null,
      components: null,
      eventTypePrefix: null,
      searchQuery: null,
      offsetFrom: null,
      offsetTo: null,
    };
  }
  const defaultPreset = defaultPresetForMode(streamPath, mode);
  const activePreset =
    presetsForStream(streamPath).find((preset) => preset.id === search.preset) ?? defaultPreset;
  return {
    eventTypes: search.types ?? null,
    components: search.components ?? activePreset.components ?? null,
    eventTypePrefix: activePreset.eventTypePrefix ?? null,
    searchQuery: (search.q ?? "") === "" ? null : (search.q ?? null),
    offsetFrom: search.from ?? null,
    offsetTo: search.to ?? null,
  };
}

/** `events.iterate.com/agent/input-added` → `agent/input-added` */
export function shortEventType(type: string): string {
  return type.startsWith("events.iterate.com/") ? type.slice("events.iterate.com/".length) : type;
}

/** Shorten a feed_items.component for display. */
export function shortComponent(component: string): string {
  return component.startsWith("stream.") ? component.slice("stream.".length) : component;
}

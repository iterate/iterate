// Pure logic for stream feed filter surfaces: feed-items presets, how
// URL-backed filters compile to SQL over the local feed_items mirror, and how
// event types / kinds render. Mode selection lives in stream-view-search.ts.
//
// feed_items is ONE table holding both pretty agent rows (kind `agent.*`) and
// raw rows (kind `raw.group` / `raw.<component>`), interleaved in local_index
// order. Modes are filters over it:
//   - Pretty        — agent rows only (minus debug kinds), search over them.
//   - Pretty + raw  — agent rows PLUS the raw rows the raw filters select,
//                     one list; search narrows only the agent rows.
//   - Raw           — raw rows only, with presets/types/offsets/search.
//
// Filter model (URL + mode presets):
//   - `types`      — primary event types inside a raw feed item (group
//                    eventType or singleton events[0].type)
//   - `components` — raw feed_items.kind values (raw.group, raw.stream.woken, …)
//   - `q`/`from`/`to`/`preset` as before
// A raw row matches when it satisfies ALL active constraints. Modes decide
// which of these controls are shown (Pretty: search only; Pretty+raw / Raw:
// full).

import type { SqlValue } from "~/domains/streams/client-libraries/browser/stream-browser-db.ts";
import {
  AGENT_KIND_PREFIX,
  RAW_KIND_PREFIX,
} from "~/domains/streams/client-libraries/processors/browser-feed/projector.ts";
import {
  modeCapabilities,
  streamViewMode,
  type StreamViewSearch,
} from "~/lib/stream-view-search.ts";

/**
 * One named configuration of the raw side of the feed. Modes that show raw
 * feed_items pick a default; Pretty ignores these.
 */
export type StreamFeedPreset = { id: string; label: string } & {
  kind: "feed-items";
  eventTypePrefix?: string;
  /** Optional default raw-kind allowlist encoded by this preset. */
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
 * Feed-items presets for Raw. FIRST is the domain default. Pretty+raw starts
 * from Everything, then applies explicit kind/event-type selections.
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
 * Default feed-items preset for a mode. Pretty+raw is unscoped (Everything) so
 * its raw rows start from the full stream; Raw uses the domain default.
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

  const defaultPreset = defaultPresetForMode(streamPath, mode);
  const activePreset =
    presetsForStream(streamPath).find((preset) => preset.id === search.preset) ?? defaultPreset;

  return (
    (caps.search && hasQuery) ||
    (caps.rawPresets && activePreset.id !== defaultPreset.id) ||
    (caps.rawEventTypes && (search.types?.length ?? 0) > 0) ||
    (caps.rawComponents && (search.components?.length ?? 0) > 0) ||
    (caps.rawOffsets && (search.from != null || search.to != null))
  );
}

/**
 * Primary event type of a raw feed_items row — group `data.eventType` or a
 * singleton's first event type.
 */
export const FEED_TYPE_EXPRESSION = `COALESCE(json_extract(data, '$.eventType'), json_extract(data, '$.events[0].type'))`;

/**
 * How the raw side of the feed is narrowed. Modes and URL params map into
 * this; `eventTypePrefix` comes from the active preset, `components` (raw
 * kinds) and `eventTypes` from the filter panel.
 */
export type FeedItemsFilterInput = {
  /** Exact primary event types (any-of); null = all. */
  eventTypes: readonly string[] | null;
  /** Raw feed_items.kind values (any-of); null = all. */
  components: readonly string[] | null;
  /** Active preset's event-type family; null = unscoped. */
  eventTypePrefix: string | null;
  searchQuery: string | null;
  offsetFrom: number | null;
  offsetTo: number | null;
};

type SqlFilter = { whereSql: string; params: SqlValue[] };

/** Constraints narrowing raw rows (WITHIN `kind LIKE 'raw.%'`), or null for all of them. */
export function buildFeedItemsFilter(input: FeedItemsFilterInput): SqlFilter | null {
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
    clauses.push(`kind IN (${input.components.map(() => "?").join(", ")})`);
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

/** Agent-row kinds hidden in Pretty (shown when showDebug is true). */
const AGENT_DEBUG_KINDS = ["agent.stream-woken"] as const;

/** How the mode narrows the ONE feed_items list. Null side = those rows are hidden. */
export type StreamFeedQueryInput = {
  /** Show agent rows: debug kinds included? search query over them? */
  agent: { showDebug: boolean; searchQuery: string | null } | null;
  /** Show raw rows narrowed by these constraints. */
  raw: FeedItemsFilterInput | null;
};

/**
 * Compile a mode's view of feed_items to one WHERE. Each side constrains only
 * its own kind family — narrowing raw rows never hides agent rows and vice
 * versa — and the two sides OR together over the shared local_index order.
 */
export function buildStreamFeedWhere(input: StreamFeedQueryInput): SqlFilter {
  const sides: SqlFilter[] = [];
  if (input.agent != null) {
    const clauses = [`kind LIKE '${AGENT_KIND_PREFIX}%'`];
    const params: SqlValue[] = [];
    if (!input.agent.showDebug) {
      clauses.push(`kind NOT IN (${AGENT_DEBUG_KINDS.map(() => "?").join(", ")})`);
      params.push(...AGENT_DEBUG_KINDS);
    }
    if (input.agent.searchQuery != null && input.agent.searchQuery !== "") {
      clauses.push(`json(data) LIKE ?`);
      params.push(`%${input.agent.searchQuery}%`);
    }
    sides.push({ whereSql: clauses.join(" AND "), params });
  }
  if (input.raw != null) {
    const rawFilter = buildFeedItemsFilter(input.raw);
    const clauses = [`kind LIKE '${RAW_KIND_PREFIX}%'`];
    const params: SqlValue[] = [];
    if (rawFilter != null) {
      clauses.push(rawFilter.whereSql);
      params.push(...rawFilter.params);
    }
    sides.push({ whereSql: clauses.join(" AND "), params });
  }
  if (sides.length === 0) return { whereSql: "0", params: [] };
  if (sides.length === 1) return sides[0]!;
  return {
    whereSql: sides.map((side) => `(${side.whereSql})`).join(" OR "),
    params: sides.flatMap((side) => side.params),
  };
}

/** Resolve the effective raw-row filter from URL search + stream path + mode. */
export function feedItemsFilterFromSearch(
  search: StreamViewSearch,
  streamPath: string,
): FeedItemsFilterInput {
  const mode = streamViewMode(search, streamPath);
  if (mode === "pretty-raw") {
    // Search is for the pretty rows in this mode; raw rows are controlled by
    // the explicit type/kind selections only.
    return {
      eventTypes: search.types ?? null,
      components: search.components ?? null,
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
    searchQuery: (search.q ?? "").trim() === "" ? null : (search.q ?? "").trim(),
    offsetFrom: search.from ?? null,
    offsetTo: search.to ?? null,
  };
}

/** `events.iterate.com/agent/input-added` → `agent/input-added` */
export function shortEventType(type: string): string {
  return type.startsWith("events.iterate.com/") ? type.slice("events.iterate.com/".length) : type;
}

/** Shorten a raw feed_items.kind for display: `raw.stream.woken` → `stream.woken`. */
export function shortComponent(component: string): string {
  return component.startsWith(RAW_KIND_PREFIX)
    ? component.slice(RAW_KIND_PREFIX.length)
    : component;
}

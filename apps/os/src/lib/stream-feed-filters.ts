// Pure logic for stream feed filter surfaces: which feed-items presets a
// stream offers, how URL-backed filters compile to SQL over the local
// feed_items mirror, and how event types render. Mode selection (Pretty /
// Raw) lives in stream-view-search.ts; this module is the feed-items filter
// core plus "are filters active?" for the header dot.

import type { SqlValue } from "~/domains/streams/client-libraries/browser/stream-browser-db.ts";
import { streamViewMode, type StreamViewSearch } from "~/lib/stream-view-search.ts";

/**
 * One named configuration of the feed-items (Raw) collection. Agent Pretty
 * modes use agent_feed_items instead and ignore these presets.
 */
export type StreamFeedPreset = { id: string; label: string } & {
  kind: "feed-items";
  eventTypePrefix?: string;
};

const EVERYTHING_PRESET: StreamFeedPreset = {
  id: "everything",
  label: "Everything",
  kind: "feed-items",
};

/** The domain-specific event-type prefix presets, keyed by stream-path prefix. */
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
 * Feed-items presets for Raw mode (and non-agent streams). The FIRST one is
 * the domain default when rendering feed_items.
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
 * Whether any feed filter deviates from the stream's defaults — drives the
 * "filters are hiding things" dot on the header's filter toggle.
 */
export function feedFiltersActive(search: StreamViewSearch, streamPath: string): boolean {
  const mode = streamViewMode(search, streamPath);
  const hasQuery = (search.q ?? "") !== "";

  if (mode === "pretty" || mode === "pretty-debug") {
    // Pretty modes only honor text search.
    return hasQuery;
  }

  // Raw / non-agent feed-items: preset deviation, search, types, offsets.
  const presets = presetsForStream(streamPath);
  const defaultPreset = presets[0]!;
  const activePreset = presets.find((preset) => preset.id === search.preset) ?? defaultPreset;
  return (
    activePreset.id !== defaultPreset.id ||
    hasQuery ||
    (search.types?.length ?? 0) > 0 ||
    search.from != null ||
    search.to != null
  );
}

/**
 * The primary event type of a feed_items row — a group row's `data.eventType`,
 * a singleton's first event type.
 */
export const FEED_TYPE_EXPRESSION = `COALESCE(json_extract(data, '$.eventType'), json_extract(data, '$.events[0].type'))`;

export type FeedItemsFilterInput = {
  eventTypes: readonly string[] | null;
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

/** `events.iterate.com/agent/input-added` → `agent/input-added` */
export function shortEventType(type: string): string {
  return type.startsWith("events.iterate.com/") ? type.slice("events.iterate.com/".length) : type;
}

/** Agent-ui feed kinds treated as debug-only (hidden in Pretty, shown in Pretty+debug). */
export const AGENT_FEED_DEBUG_KINDS = ["stream-woken"] as const;

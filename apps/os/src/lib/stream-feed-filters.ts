// Pure logic for the stream Feed tab's filter surface: which presets a stream
// offers, how the URL-backed filters compile to SQL over the local feed_items
// mirror, and how event types render. The React filter row lives in
// ~/components/stream-feed-filters.tsx; this module is its testable core.

import type { SqlValue } from "~/domains/streams/client-libraries/browser/stream-browser-db.ts";
import type { StreamViewSearch } from "~/lib/stream-view-search.ts";

/**
 * One named configuration of the Feed tab. The feed always renders a feed-item
 * collection from the local SQLite mirror — never the raw events table — and a
 * preset picks WHICH collection and how it is filtered:
 *   - `agent-chat` renders the agent_feed_items collection (the chat view);
 *   - `feed-items` renders the grouped feed_items collection, optionally
 *     filtered to one event-type prefix (the domain presets).
 * Presets are quick starts, not the whole filter surface: the filter row adds
 * free-form narrowing (text search, any-of event types, offset bounds).
 */
export type StreamFeedPreset = { id: string; label: string } & (
  | { kind: "agent-chat" }
  | { kind: "feed-items"; eventTypePrefix?: string }
);

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
 * The presets available on a stream, in order — the FIRST one is the domain's
 * default. Agent streams default to the chat view; other domains default to
 * their own event family; everything else defaults to the unfiltered feed.
 */
export function presetsForStream(streamPath: string): StreamFeedPreset[] {
  const presets: StreamFeedPreset[] = [];
  if (streamPath.startsWith("/agents/")) {
    presets.push({ id: "agent-chat", label: "Agent chat", kind: "agent-chat" });
  }
  for (const { pathPrefix, preset } of DOMAIN_PRESETS) {
    if (streamPath.startsWith(pathPrefix)) presets.push(preset);
  }
  presets.push(EVERYTHING_PRESET);
  return presets;
}

/**
 * Whether any feed filter deviates from the stream's defaults — drives the
 * "filters are hiding things" dot on the header's filter toggle, which must
 * signal even while the row itself is closed.
 */
export function feedFiltersActive(search: StreamViewSearch, defaultPresetId: string): boolean {
  return (
    (search.preset != null && search.preset !== defaultPresetId) ||
    (search.q ?? "") !== "" ||
    search.types != null ||
    search.from != null ||
    search.to != null
  );
}

/**
 * The primary event type of a feed_items row — a group row's `data.eventType`,
 * a singleton's first event type. Every feed filter (preset prefix, exact
 * type) matches against this expression, entirely in SQL over the local mirror.
 */
export const FEED_TYPE_EXPRESSION = `COALESCE(json_extract(data, '$.eventType'), json_extract(data, '$.events[0].type'))`;

/**
 * All the ways the Feed tab narrows the feed_items collection. Every field is
 * URL-backed (see stream-view-search.ts) except `eventTypePrefix`, which comes
 * from the active preset.
 */
export type FeedItemsFilterInput = {
  /** Exact primary event types (any-of); null = all types. */
  eventTypes: readonly string[] | null;
  /** The active preset's event-type family; null = unscoped. */
  eventTypePrefix: string | null;
  /** Substring match over the serialized feed-item payload. */
  searchQuery: string | null;
  /** Inclusive raw-event offset bounds; a group matches when its range overlaps. */
  offsetFrom: number | null;
  offsetTo: number | null;
};

/** Composed WHERE fragment + params for the feed filters; null when unfiltered. */
export type FeedItemsFilter = { whereSql: string; params: SqlValue[] } | null;

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
  // A group row spans [first_offset, last_offset]; it matches when that range
  // overlaps the requested bounds so a partially-in-range group still shows.
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

/** `events.iterate.com/agent/input-added` → `agent/input-added` — the domain part carries the signal. */
export function shortEventType(type: string): string {
  return type.startsWith("events.iterate.com/") ? type.slice("events.iterate.com/".length) : type;
}

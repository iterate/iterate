// Filtering the log, as pure functions: by type (the set left ticked), by a text query over the
// type and the payload's JSON, by the actor who appended. Plus the two short forms every row uses.
import type { ContextViewEvent } from "./types.tsx";

export type ContextViewFilter = {
  query: string;
  /** Event types to show; empty = all. */
  types: ReadonlySet<string>;
  /** An actor id to narrow to (their events only). */
  actor?: string;
};

export const EMPTY_FILTER: ContextViewFilter = { query: "", types: new Set() };

export function filterEvents(
  events: readonly ContextViewEvent[],
  filter: ContextViewFilter,
): ContextViewEvent[] {
  const query = filter.query.trim().toLowerCase();
  return events.filter((event) => {
    if (filter.types.size > 0 && !filter.types.has(event.type)) return false;
    if (filter.actor && event.source?.principal?.actor !== filter.actor) return false;
    if (!query) return true;
    return (
      event.type.toLowerCase().includes(query) ||
      JSON.stringify(event.payload ?? null)
        .toLowerCase()
        .includes(query)
    );
  });
}

/** Every type in the log with how often it occurs, most frequent first. */
export function typeCounts(events: readonly ContextViewEvent[]): [type: string, count: number][] {
  const counts = new Map<string, number>();
  for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** The event type without its `events.iterate.com/` prefix. */
export const shortEventType = (type: string): string => type.replace(/^events\.iterate\.com\//, "");

/** The payload as one line, cut to `max` characters — the row's glance at the body. */
export function payloadPreview(payload: unknown, max = 140): string {
  if (payload === undefined) return "";
  const text = JSON.stringify(payload);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Who appended: the email when the stamp has one, else the actor id; "" for the platform's own. */
export const actorLabel = (event: ContextViewEvent): string =>
  event.source?.principal?.email ?? event.source?.principal?.actor ?? "";

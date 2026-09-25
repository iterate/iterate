// Filtering the log, as pure functions: by type (the set left ticked), by a text query over the
// type and the payload's JSON, by the actor who appended, by an offset range (the old platform's
// `from`/`to`). Plus the two short forms every row uses.
// `refilter` and `recount` follow a log that grows at either end without passing over all of it
// again (folds.tsx `growthOf`): a JSON.stringify per event per append is too slow at 100,000.
import { growthOf } from "./folds.tsx";
import { isRecord } from "./renderer-helpers.tsx";
import type { ContextViewEvent } from "./types.tsx";

export type ContextViewFilter = {
  query: string;
  /** Event types to show; empty = all. */
  types: ReadonlySet<string>;
  /** An actor id to narrow to (their events only). */
  actor?: string;
  /** The lowest offset shown, inclusive. */
  from?: number;
  /** The highest offset shown, inclusive. */
  to?: number;
};

export function filterEvents(
  events: readonly ContextViewEvent[],
  filter: ContextViewFilter,
): ContextViewEvent[] {
  const query = filter.query.trim().toLowerCase();
  return events.filter((event) => {
    if (filter.types.size > 0 && !filter.types.has(event.type)) return false;
    if (filter.actor && event.source?.principal?.actor !== filter.actor) return false;
    if (filter.from !== undefined && event.offset < filter.from) return false;
    if (filter.to !== undefined && event.offset > filter.to) return false;
    if (!query) return true;
    return (
      event.type.toLowerCase().includes(query) ||
      JSON.stringify(event.payload ?? null)
        .toLowerCase()
        .includes(query)
    );
  });
}

/** Whether a filter narrows anything. */
export const narrows = (filter: ContextViewFilter): boolean =>
  Boolean(filter.query.trim()) ||
  filter.types.size > 0 ||
  Boolean(filter.actor) ||
  filter.from !== undefined ||
  filter.to !== undefined;

/** Whether two filters narrow the same way (the view's filter is rebuilt from the URL on every
 *  change of it, the inspected event's too). */
function sameFilter(a: ContextViewFilter, b: ContextViewFilter): boolean {
  return (
    a.query.trim() === b.query.trim() &&
    a.actor === b.actor &&
    a.from === b.from &&
    a.to === b.to &&
    a.types.size === b.types.size &&
    [...a.types].every((type) => b.types.has(type))
  );
}

/** A filtered log and what it filtered, for the next `refilter`. */
export type Filtered = {
  events: readonly ContextViewEvent[];
  filter: ContextViewFilter;
  shown: readonly ContextViewEvent[];
};

/** `filterEvents`, re-using `previous` where the log only grew at one end and the filter is the
 *  same: only the added events are filtered. No filter shows the log itself (the same array, so a
 *  fold of it sees the log's own growth). */
export function refilter(
  previous: Filtered | undefined,
  events: readonly ContextViewEvent[],
  filter: ContextViewFilter,
): Filtered {
  if (!narrows(filter)) return { events, filter, shown: events };
  const growth =
    previous && narrows(previous.filter) && sameFilter(previous.filter, filter)
      ? growthOf(previous.events, events)
      : null;
  if (previous && growth && "end" in growth)
    return {
      events,
      filter,
      shown:
        growth.end.length === 0
          ? previous.shown
          : previous.shown.concat(filterEvents(growth.end, filter)),
    };
  if (previous && growth && "start" in growth)
    return { events, filter, shown: filterEvents(growth.start, filter).concat(previous.shown) };
  return { events, filter, shown: filterEvents(events, filter) };
}

/** Every type in the log with how often it occurs, most frequent first. */
export function typeCounts(events: readonly ContextViewEvent[]): [type: string, count: number][] {
  return sortedCounts(countTypes(new Map(), events));
}

/** A log's type counts and the log, for the next `recount`. */
export type TypeCounts = { events: readonly ContextViewEvent[]; counts: Map<string, number> };

/** The type counts of `events`, counting only what was added where the log only grew at one end. */
export function recount(
  previous: TypeCounts | undefined,
  events: readonly ContextViewEvent[],
): TypeCounts {
  const growth = previous ? growthOf(previous.events, events) : null;
  if (previous && growth) {
    const added = "end" in growth ? growth.end : growth.start;
    if (added.length === 0) return { events, counts: previous.counts };
    return { events, counts: countTypes(new Map(previous.counts), added) };
  }
  return { events, counts: countTypes(new Map(), events) };
}

function countTypes(counts: Map<string, number>, events: readonly ContextViewEvent[]) {
  for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  return counts;
}

/** Counts by type as the filter row lists them: most frequent first, ties by name. */
export function sortedCounts(counts: Map<string, number>): [type: string, count: number][] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** The type chips of the filter row: the log's counts, then every ticked type the loaded log does
 *  not hold (a link's `types`, a type only in older pages) with a count of 0 — so a selection that
 *  hides everything can still be seen and unticked (the old platform's stale selections). */
export function typeChips(
  counts: readonly [type: string, count: number][],
  ticked: ReadonlySet<string>,
): [type: string, count: number][] {
  const listed = new Set(counts.map(([type]) => type));
  const absent = [...ticked].filter((type) => !listed.has(type)).sort();
  return [...counts, ...absent.map((type): [string, number] => [type, 0])];
}

/** An offset box's text as a bound: blank = no bound, a number = that offset (a negative clamped to
 *  0, a fraction cut), anything else = no change (`null`), so a stray key never empties the feed. */
export function offsetBound(text: string): number | undefined | null {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed.replace(/^#/, ""));
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : null;
}

/** The event type without its `events.iterate.com/` prefix. */
export const shortEventType = (type: string): string => type.replace(/^events\.iterate\.com\//, "");

/** The payload as one line, cut to `max` characters — the row's glance at the body. */
export function payloadPreview(payload: unknown, max = 140): string {
  if (payload === undefined) return "";
  const text = JSON.stringify(payload);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The payload's top-level fields as one human line — `key value · key value` — for a type no
 *  renderer names: strings to their first line, arrays to their length, objects to their keys. */
export function payloadSummary(payload: unknown, max = 120): string {
  if (payload === undefined) return "";
  if (Array.isArray(payload))
    return `${String(payload.length)} item${payload.length === 1 ? "" : "s"}`;
  if (!isRecord(payload)) return valueGlance(payload);
  const parts: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (parts.length === 5) {
      parts.push("…");
      break;
    }
    parts.push(`${key} ${valueGlance(value)}`);
  }
  const text = parts.join(" · ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One value inside the line: a string's first line, an array's length, an object's keys, else JSON. */
function valueGlance(value: unknown): string {
  if (typeof value === "string") {
    const line = value.split("\n")[0] || "";
    return line.length > 48 ? `${line.slice(0, 47)}…` : line;
  }
  if (Array.isArray(value)) return `[${String(value.length)}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value);
    return `{${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", …" : ""}}`;
  }
  return String(JSON.stringify(value)); // numbers, booleans, null — and "undefined" for a hole
}

/** Who appended: the email when the stamp has one, else the actor id; "" for the platform's own. */
export const actorLabel = (event: ContextViewEvent): string =>
  event.source?.principal?.email ?? event.source?.principal?.actor ?? "";

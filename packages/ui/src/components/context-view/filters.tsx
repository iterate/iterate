// Filtering the log, as pure functions: by type (the set left ticked), by a text query over the
// type and the payload's JSON, by the actor who appended. Plus the two short forms every row uses.
import { isRecord } from "./renderer-helpers.tsx";
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

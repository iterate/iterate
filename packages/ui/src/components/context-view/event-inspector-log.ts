// The inspector's pure halves, ported from the old platform's raw-event inspector (apps/os
// `raw-event-inspector-panel.tsx`, removed in #2837): where the inspected offset sits in the loaded
// log (the event, its neighbours — by comparison, not offset ± 1, since a log's offsets are sparse
// where ephemeral events were and a stale link still finds real neighbours), the gap to each, the
// signal-first key order the raw event reads in, and which keydowns ← → must leave alone.
import type { ContextViewEvent } from "./types.tsx";

/** The inspected offset in a log sorted by offset: the event (when loaded), the events either side
 *  of the offset (whether or not it is loaded) and where it falls against what is held. */
export type InspectedPlace = {
  event?: ContextViewEvent;
  previous?: ContextViewEvent;
  next?: ContextViewEvent;
  /** `below` — older than every loaded event (a page to read); `above` — newer than the head held
   *  (it may yet arrive); `gap` — inside the loaded range, but no event has it. */
  missing?: "below" | "above" | "gap";
};

/** Where `offset` sits in `events` (sorted by offset): one binary search, the log can be 100,000
 *  long. */
export function inspectedPlace(
  events: readonly ContextViewEvent[],
  offset: number,
): InspectedPlace {
  // the first index whose offset is >= the inspected one
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (events[middle]!.offset < offset) low = middle + 1;
    else high = middle;
  }
  const found = events[low]?.offset === offset ? events[low] : undefined;
  const previous = events[low - 1];
  const next = events[found ? low + 1 : low];
  if (found) return { event: found, previous, next };
  const missing = !next ? "above" : !previous ? "below" : "gap";
  return { previous, next, missing };
}

/** `+950ms`, `+3.2s`, `+1m40s`, `+2h5m` — the gap between two events' `createdAt`. */
export function elapsedBetween(from: string, to: string): string | undefined {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return undefined;
  const ms = Math.max(0, Math.floor(toMs - fromMs));
  if (ms < 1_000) return `+${ms}ms`;
  if (ms < 60_000) return `+${(Math.floor(ms / 100) / 10).toFixed(1).replace(/\.0$/, "")}s`;
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 3_600) return `+${Math.floor(seconds / 60)}m${seconds % 60}s`;
  return `+${Math.floor(seconds / 3_600)}h${Math.floor((seconds % 3_600) / 60)}m`;
}

/** The raw event's keys, signal first: what happened and its payload before the envelope. */
const EVENT_KEY_ORDER = ["type", "payload", "metadata", "idempotencyKey", "offset", "createdAt"];

/** The event with its keys in `EVENT_KEY_ORDER`, then the rest (`source`, `path`) as they came. */
export function orderEventKeys(event: ContextViewEvent): Record<string, unknown> {
  const fields = event as unknown as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of EVENT_KEY_ORDER) if (key in fields) ordered[key] = fields[key];
  for (const [key, value] of Object.entries(fields))
    if (!EVENT_KEY_ORDER.includes(key)) ordered[key] = value;
  return ordered;
}

/** A keydown whose ← → belong to what has focus (a field, an editor), not to paging the log. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
}

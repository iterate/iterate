// The log folded for reading, as a pure function: day separators wherever the date turns; in
// Pretty, a run of the platform's housekeeping becomes one quiet row and a fact repeated
// back-to-back — the same SENTENCE, whatever the payload's timestamps and ids (four "Signed in with
// a browser cookie" in a row) — becomes one row with its count. Pretty + raw and Raw keep every
// event; only the days are marked.
// INCREMENTALLY, for a log of 100,000 events that grows at both ends (live appends at the tail,
// older pages prepended at the head): `refold` re-folds only the last item and what was appended,
// or the first item and what was prepended, and folds the whole log only when it changed otherwise.
// It equals `foldEvents` over the whole log (folds.test.tsx proves it across appends and prepends).
import { isValidElement, type ReactNode } from "react";
import { isHousekeeping } from "./core-renderers.tsx";
import type { ContextViewEvent, ContextViewMode } from "./types.tsx";

export type FeedItem =
  | { kind: "day"; key: string; date: Date }
  | { kind: "event"; key: string; event: ContextViewEvent }
  /** The same fact several times in a row — shown once, with how many. */
  | { kind: "repeat"; key: string; events: ContextViewEvent[] }
  /** A run of the platform's housekeeping — one quiet row, expandable. */
  | { kind: "housekeeping"; key: string; events: ContextViewEvent[] };

/** The LOCAL calendar day an event fell on — the day the reader's clock says, the same day the
 *  separator labels (feed-rows.tsx); grouping by the UTC date would open a second "Today" for an
 *  evening anywhere east or west of Greenwich. Remembered per event object: a fold asks it of every
 *  event it passes, and a Date per event per fold is most of a 100,000-event fold's time. */
function dayOf(event: ContextViewEvent): string {
  let day = daysSeen.get(event);
  if (!day) {
    day = new Date(event.createdAt).toDateString();
    daysSeen.set(event, day);
  }
  return day;
}
const daysSeen = new WeakMap<ContextViewEvent, string>();

/** What makes two events "the same fact" for the repeat fold. The view keys by the type and the
 *  rendered sentence's text (`sentenceText`); without renderers, by the type and the payload. */
export type FactKey = (event: ContextViewEvent) => string;
export const factByPayload: FactKey = (event) =>
  JSON.stringify([event.type, event.payload ?? null]);

/** The words of a rendered sentence — strings and numbers, elements' children walked — so two
 *  renderings compare as text. Sentences are small trees of spans and strongs; nothing else is expected. */
export function sentenceText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(sentenceText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return sentenceText(node.props.children);
  return "";
}

/** Fold `events` into items. `markedDay` is the day already marked above them (a re-fold of the
 *  tail continues the day its first event fell on, so it opens no second separator for it). */
export function foldEvents(
  events: readonly ContextViewEvent[],
  mode: ContextViewMode,
  factOf: FactKey = factByPayload,
  markedDay = "",
): FeedItem[] {
  const items: FeedItem[] = [];
  let lastDay = markedDay;
  let i = 0;
  while (i < events.length) {
    const event = events[i]!;
    const day = dayOf(event);
    if (day !== lastDay) {
      items.push({ kind: "day", key: `day:${day}`, date: new Date(event.createdAt) });
      lastDay = day;
    }
    if (mode === "pretty") {
      if (isHousekeeping(event.type)) {
        let end = i + 1;
        while (
          end < events.length &&
          isHousekeeping(events[end]!.type) &&
          dayOf(events[end]!) === day
        )
          end += 1;
        const run = events.slice(i, end);
        items.push(
          run.length === 1
            ? { kind: "event", key: `event:${String(event.offset)}`, event }
            : { kind: "housekeeping", key: `housekeeping:${String(event.offset)}`, events: run },
        );
        i = end;
        continue;
      }
      const fact = factOf(event);
      let end = i + 1;
      while (end < events.length && dayOf(events[end]!) === day && factOf(events[end]!) === fact)
        end += 1;
      if (end - i >= 2) {
        items.push({
          kind: "repeat",
          key: `repeat:${String(event.offset)}`,
          events: events.slice(i, end),
        });
        i = end;
        continue;
      }
    }
    items.push({ kind: "event", key: `event:${String(event.offset)}`, event });
    i += 1;
  }
  return items;
}

/** Per item, who acted on the last row before it that anyone acted on — "" at the top and after
 *  a day mark (a new day names its first actor again, since yesterday may have scrolled off).
 *  The rows name who acted only when it changes against this. `before` is who acted last above
 *  `items` (a re-fold of the tail carries it on). */
export function whoBefore(
  items: readonly FeedItem[],
  actorOf: (event: ContextViewEvent) => string,
  before = "",
): string[] {
  let last = before;
  return items.map((item) => {
    if (item.kind === "day") {
      last = "";
      return "";
    }
    const before = last;
    const event = lastEventOf(item);
    if (event && actorOf(event)) last = actorOf(event);
    return before;
  });
}

/** The last event an item covers — the anchor for the next row's gap. */
export function lastEventOf(item: FeedItem | undefined): ContextViewEvent | undefined {
  if (!item || item.kind === "day") return undefined;
  return item.kind === "event" ? item.event : item.events.at(-1);
}

/** How many events an item covers. */
const sizeOf = (item: FeedItem): number =>
  item.kind === "day" ? 0 : item.kind === "event" ? 1 : item.events.length;

/** How `next` grew from `previous`, both sorted by offset and `next` holding every element of
 *  `previous` (the SDK's log, a filter of it): the elements added at the end, or at the start —
 *  null when it changed any other way (a filter changed, a window was dropped). Compares the two
 *  ends by identity, which is enough for sorted arrays of distinct elements: if `next` keeps
 *  `previous`'s last element at `previous`'s last index, nothing was added before it. */
export function growthOf<T>(
  previous: readonly T[],
  next: readonly T[],
): { end: readonly T[] } | { start: readonly T[] } | null {
  if (next === previous) return { end: [] };
  if (next.length < previous.length) return null;
  if (previous.length === 0) return { end: next };
  const added = next.length - previous.length;
  if (next[0] === previous[0] && next[previous.length - 1] === previous.at(-1))
    return { end: next.slice(previous.length) };
  if (next.at(-1) === previous.at(-1) && next[added] === previous[0])
    return { start: next.slice(0, added) };
  return null;
}

/** A fold and what it folded, for the next `refold`. */
export type Fold = {
  events: readonly ContextViewEvent[];
  mode: ContextViewMode;
  factOf: FactKey;
  items: FeedItem[];
  /** `whoBefore` of `items`. */
  namedBefore: string[];
};

/** `foldEvents` + `whoBefore` of `events`, re-using `previous` where the log only grew at one
 *  end: an append re-folds the last item (a run the new events may continue) and the new events;
 *  a prepend re-folds the new events and the first item (a run they may extend backwards — the fold
 *  is greedy from the top, so the items after it stand). Anything else folds the whole log. */
export function refold(
  previous: Fold | undefined,
  events: readonly ContextViewEvent[],
  mode: ContextViewMode,
  factOf: FactKey,
  actorOf: (event: ContextViewEvent) => string,
): Fold {
  const growth =
    previous && previous.mode === mode && previous.factOf === factOf && previous.items.length > 0
      ? growthOf(previous.events, events)
      : null;
  if (previous && growth && "end" in growth) {
    if (growth.end.length === 0) return { ...previous, events };
    const last = previous.items.at(-1)!; // a day mark is always followed by an item: never a day
    const start = previous.events.length - sizeOf(last);
    const tail = foldEvents(events.slice(start), mode, factOf, dayOf(events[start]!));
    return {
      events,
      mode,
      factOf,
      items: previous.items.slice(0, -1).concat(tail),
      namedBefore: previous.namedBefore
        .slice(0, -1)
        .concat(whoBefore(tail, actorOf, previous.namedBefore.at(-1))),
    };
  }
  if (previous && growth && "start" in growth) {
    const first = previous.items[1]!; // items[0] is the first day's mark
    const seam = foldEvents(events.slice(0, growth.start.length + sizeOf(first)), mode, factOf);
    const items = seam.concat(previous.items.slice(2));
    return { events, mode, factOf, items, namedBefore: whoBefore(items, actorOf) };
  }
  const items = foldEvents(events, mode, factOf);
  return { events, mode, factOf, items, namedBefore: whoBefore(items, actorOf) };
}

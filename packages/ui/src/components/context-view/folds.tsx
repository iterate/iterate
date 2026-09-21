// The log folded for reading, as a pure function: day separators wherever the date turns; in
// Pretty, a run of the platform's housekeeping becomes one quiet row and a fact repeated
// back-to-back — the same SENTENCE, whatever the payload's timestamps and ids (four "Signed in with
// a browser cookie" in a row) — becomes one row with its count. Pretty + raw and Raw keep every
// event; only the days are marked.
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
 *  evening anywhere east or west of Greenwich. */
const dayOf = (event: ContextViewEvent) => new Date(event.createdAt).toDateString();

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

export function foldEvents(
  events: readonly ContextViewEvent[],
  mode: ContextViewMode,
  factOf: FactKey = factByPayload,
): FeedItem[] {
  const items: FeedItem[] = [];
  let lastDay = "";
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

/** The last event an item covers — the anchor for the next row's gap. */
export function lastEventOf(item: FeedItem | undefined): ContextViewEvent | undefined {
  if (!item || item.kind === "day") return undefined;
  return item.kind === "event" ? item.event : item.events.at(-1);
}

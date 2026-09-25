// The folded log as ONE virtual list in its own scroll region (TanStack Virtual): only the rows in
// view, plus an overscan, are in the DOM, so 100,000 events scroll like 100. Opened folds list their
// members as rows of their own. While there is more log below what is loaded, row 0 is its top:
// "Load older events", or a spinner while a page is read; once the whole log is loaded there is no
// such row — `#1` says it is the start.
//
// The scheme is the old platform's feed's (apps/os `stream-feed-view.tsx`, removed in #2837; its
// failure modes in #1847/#1848): the stick (stick-to-bottom.ts) owns the tail in DOM truth, so
// followOnAppend is off; `anchorTo: "end"` keeps the row at the top of the view where it is when rows
// arrive above it (an older page) or below it (a reader in history is never yanked); rows are keyed
// by offset, never by index, which is what lets that anchor find its row again after a prepend.
// Nearing the top of what is loaded (the reader scrolled there, or the log is shorter than the
// view) asks for the page below it. Off the tail, a "Jump to latest" pill (with how many rows came
// in since) pins it again. The inspected row is scrolled into view once per inspection (the
// inspector paging the log, a link to an event).
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { ArrowDownIcon } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Spinner } from "../spinner.tsx";
import { EventRow, RowGutter } from "./event-row.tsx";
import { DaySeparator, HousekeepingRow, RepeatRow } from "./feed-rows.tsx";
import { actorLabel } from "./filters.tsx";
import { type FeedItem, lastEventOf } from "./folds.tsx";
import { useStickToBottom } from "./stick-to-bottom.ts";
import type { ContextViewEvent, ContextViewMode, EventRenderers } from "./types.tsx";

/** A member of an opened fold, listed under it. */
type MemberRow = {
  kind: "member";
  key: string;
  event: ContextViewEvent;
  previous?: ContextViewEvent;
  /** The fold was housekeeping: the member reads muted. */
  quiet: boolean;
};

/** Older pages are asked for when the top of the view is within this many rows of row 0. */
const LOAD_OLDER_WITHIN_ROWS = 40;

export function FeedList({
  items,
  namedBefore,
  mode,
  renderers,
  inspected,
  onInspect,
  opened,
  onToggle,
  older,
  followTail,
  empty,
}: {
  items: readonly FeedItem[];
  /** `whoBefore(items)`: a row names who acted only when it changes against this. */
  namedBefore: readonly string[];
  mode: ContextViewMode;
  renderers: EventRenderers;
  inspected?: number;
  onInspect: (offset: number) => void;
  opened: ReadonlySet<string>;
  onToggle: (itemKey: string) => void;
  older: { loadOlder(): void; loading: boolean; exhausted: boolean };
  /** Each change pins the view to the tail again, wherever the reader was (the view's own append:
   *  the next rows to arrive are the person's, and they land in view). */
  followTail?: number;
  /** What shows when there are no rows: the empty log, a filter matching nothing, the first read. */
  empty: ReactNode;
}) {
  // Opened folds add their members after them. Nothing opened (the common case) lists the items
  // themselves, with no pass over 100,000 of them.
  const { rows, itemIndexOf } = useMemo(() => {
    if (opened.size === 0)
      return { rows: items as readonly (FeedItem | MemberRow)[], itemIndexOf: null };
    const rows: (FeedItem | MemberRow)[] = [];
    const itemIndexOf: number[] = [];
    items.forEach((item, index) => {
      rows.push(item);
      itemIndexOf.push(index);
      if (item.kind === "day" || item.kind === "event" || !opened.has(item.key)) return;
      item.events.forEach((event, at) => {
        rows.push({
          kind: "member",
          key: `${item.key}/${String(event.offset)}`,
          event,
          previous: at === 0 ? lastEventOf(items[index - 1]) : item.events[at - 1],
          quiet: item.kind === "housekeeping",
        });
        itemIndexOf.push(-1);
      });
    });
    return { rows, itemIndexOf };
  }, [items, opened]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { stuckRef, stuck, stick, release } = useStickToBottom({
    scrollElementRef: scrollRef,
    contentElementRef: contentRef,
  });
  useEffect(() => {
    if (followTail) stick();
  }, [followTail, stick]);
  const { loadOlder, loading, exhausted } = older;
  // while more log lies below what is loaded, virtual index 0 is the top row and row i is virtual
  // index i + 1; once it is all loaded, row i is index i
  const top = exhausted ? 0 : 1;
  const getItemKey = useCallback(
    (index: number) => (index < top ? "top" : rows[index - top]!.key),
    [rows, top],
  );
  const estimateSize = useCallback(
    (index: number) => {
      const row = index < top ? undefined : rows[index - top];
      if (!row) return 28;
      // every one-line row is 26px (event-row.tsx `rowClass`); a day 36; both lines 42
      if (row.kind === "day") return 36;
      if (row.kind === "member") return row.quiet ? 26 : 42;
      if (row.kind !== "event") return 26;
      return mode === "pretty-raw" ? 42 : 26;
    },
    [rows, mode, top],
  );
  const virtualizer = useVirtualizer({
    count: rows.length + top,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    anchorTo: "end",
    // the stick owns the tail: the library's follow is gated on its own isAtEnd(), which drifts
    // from the DOM, and two writers fight (its reconcile loop is uncancellable, TanStack/virtual#1221)
    followOnAppend: false,
    scrollEndThreshold: 80,
    overscan: 16,
    // vertical breathing room lives HERE, not as wrapper padding the virtualizer cannot see (that
    // would shift its coordinates off the scroller's and strand the end anchor above the bottom)
    paddingStart: 4,
    paddingEnd: 8,
  });
  const virtualItems = virtualizer.getVirtualItems();

  // The inspected row, scrolled into view once per inspection (the inspector's paging, a link's
  // `event`) — never again as rows arrive, so a reader who scrolled away from it stays there.
  const revealRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    revealRef.current = inspected;
  }, [inspected]);
  useEffect(() => {
    const offset = revealRef.current;
    if (offset === undefined || rows.length === 0) return;
    revealRef.current = undefined;
    const index = rows.findIndex((row) => rowOffset(row) === offset);
    if (index < 0) return; // folded away, or not loaded: the inspector shows it all the same
    release();
    virtualizer.scrollToIndex(index + top, { align: "auto" });
  });
  // rows that came in since the reader left the tail, for the pill
  const lastOffset = rows.length > 0 ? lastOffsetOf(rows[rows.length - 1]!) : 0;
  const leftAtRef = useRef(lastOffset);
  if (stuck) leftAtRef.current = lastOffset;
  let arrived = 0;
  if (!stuck)
    for (let at = rows.length - 1; at >= 0 && lastOffsetOf(rows[at]!) > leftAtRef.current; at--)
      if (rows[at]!.kind !== "day") arrived += 1;

  const firstInView = virtualItems[0]?.index ?? 0;
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || loading || exhausted || rows.length === 0) return;
    // near the top — but only once the reader left the tail (on opening, the view is at the top for
    // a frame before the stick pins it to the bottom), or when the whole log loaded fits the view
    const fits = scroller.scrollHeight <= scroller.clientHeight;
    if (firstInView < LOAD_OLDER_WITHIN_ROWS && (fits || !stuckRef.current)) loadOlder();
  }, [firstInView, loading, exhausted, loadOlder, rows.length, stuckRef]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        role="log"
        aria-label="Events"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {rows.length === 0 ? (
          empty
        ) : (
          <div
            ref={contentRef}
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualItems.map((virtualItem) => (
              <div
                key={virtualItem.key}
                data-index={virtualItem.index}
                ref={virtualizer.measureElement}
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${String(virtualItem.start)}px)` }}
              >
                {virtualItem.index < top ? (
                  <OlderRow loading={loading} onLoad={loadOlder} />
                ) : (
                  renderRow(virtualItem.index - top)
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {stuck || rows.length === 0 ? null : (
        <button
          type="button"
          onClick={stick}
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border bg-background px-3 py-1 text-xs text-muted-foreground shadow-sm hover:text-foreground"
        >
          <ArrowDownIcon className="size-3.5" />
          Jump to latest
          {arrived > 0 ? (
            <span className="tabular-nums text-foreground">· {arrived} new</span>
          ) : null}
        </button>
      )}
    </div>
  );

  function renderRow(index: number) {
    const row = rows[index]!;
    if (row.kind === "member")
      return (
        <EventRow
          event={row.event}
          previous={row.previous}
          renderers={renderers}
          mode={row.quiet ? "pretty" : "pretty-raw"}
          showWho={false}
          quiet={row.quiet}
          selected={inspected === row.event.offset}
          onOpen={onInspect}
        />
      );
    if (row.kind === "day") return <DaySeparator date={row.date} />;
    const itemIndex = itemIndexOf ? itemIndexOf[index]! : index;
    const previous = lastEventOf(items[itemIndex - 1]);
    const first = row.kind === "event" ? row.event : row.events[0]!;
    // who acted is named when it changes hands: against the last row that WAS someone's (the
    // platform's housekeeping between two of a person's rows names nobody), afresh each day
    const showWho = actorLabel(first) !== namedBefore[itemIndex];
    if (row.kind === "repeat")
      return (
        <RepeatRow
          itemKey={row.key}
          events={row.events}
          previous={previous}
          renderers={renderers}
          showWho={showWho}
          open={opened.has(row.key)}
          onToggle={onToggle}
        />
      );
    if (row.kind === "housekeeping")
      return (
        <HousekeepingRow
          itemKey={row.key}
          events={row.events}
          previous={previous}
          open={opened.has(row.key)}
          onToggle={onToggle}
        />
      );
    return (
      <EventRow
        event={row.event}
        previous={previous}
        renderers={renderers}
        mode={mode}
        showWho={showWho}
        selected={inspected === row.event.offset}
        onOpen={onInspect}
      />
    );
  }
}

/** The event a row opens in the inspector: an event's, an opened fold member's; none for a day
 *  mark or a fold (they open in place). */
function rowOffset(row: FeedItem | MemberRow): number | undefined {
  return row.kind === "event" || row.kind === "member" ? row.event.offset : undefined;
}

/** The last offset a row covers (a day mark: 0 — it never ends the list). */
function lastOffsetOf(row: FeedItem | MemberRow): number {
  return row.kind === "member" ? row.event.offset : (lastEventOf(row)?.offset ?? 0);
}

/** The top of what is loaded, while there is more below it: a way to read the page below, or that
 *  page being read — in the body column, one height either way, so the rows below never shift. */
function OlderRow({ loading, onLoad }: { loading: boolean; onLoad: () => void }) {
  return (
    <div className="flex h-7 items-center gap-x-3.5 px-3 sm:px-4 text-xs text-muted-foreground">
      <RowGutter times />
      {loading ? (
        <span className="flex items-center gap-2">
          <Spinner /> Loading older events…
        </span>
      ) : (
        <button type="button" onClick={onLoad} className="underline-offset-2 hover:underline">
          Load older events
        </button>
      )}
    </div>
  );
}

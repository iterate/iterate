// The folded log as ONE virtual list in its own scroll region (TanStack Virtual): only the rows in
// view, plus an overscan, are in the DOM, so 100,000 events scroll like 100. Opened folds list their
// members as rows of their own. Row 0 is the top of what is loaded: "Load older events", a spinner
// while a page is read, or the start of the log.
//
// The scheme is the old platform's feed's (apps/os `stream-feed-view.tsx`, removed in #2837; its
// failure modes in #1847/#1848): the stick (stick-to-bottom.ts) owns the tail in DOM truth, so
// followOnAppend is off; `anchorTo: "end"` keeps the row at the top of the view where it is when rows
// arrive above it (an older page) or below it (a reader in history is never yanked); rows are keyed
// by offset, never by index, which is what lets that anchor find its row again after a prepend.
// Nearing the top of what is loaded (the reader scrolled there, or the log is shorter than the
// view) asks for the page below it.
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Spinner } from "../spinner.tsx";
import { EventRow } from "./event-row.tsx";
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
  const { stuckRef, stick } = useStickToBottom({
    scrollElementRef: scrollRef,
    contentElementRef: contentRef,
  });
  useEffect(() => {
    if (followTail) stick();
  }, [followTail, stick]);
  // virtual index 0 is the top row; row i is virtual index i + 1
  const getItemKey = useCallback(
    (index: number) => (index === 0 ? "top" : rows[index - 1]!.key),
    [rows],
  );
  const estimateSize = useCallback(
    (index: number) => {
      const row = index === 0 ? undefined : rows[index - 1];
      if (!row) return 32;
      if (row.kind === "day") return 36;
      if (row.kind === "member") return row.quiet ? 28 : 46;
      return mode === "pretty-raw" && row.kind === "event" ? 46 : 28;
    },
    [rows, mode],
  );
  const virtualizer = useVirtualizer({
    count: rows.length + 1,
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

  const firstInView = virtualItems[0]?.index ?? 0;
  const { loadOlder, loading, exhausted } = older;
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || loading || exhausted || rows.length === 0) return;
    // near the top — but only once the reader left the tail (on opening, the view is at the top for
    // a frame before the stick pins it to the bottom), or when the whole log loaded fits the view
    const fits = scroller.scrollHeight <= scroller.clientHeight;
    if (firstInView < LOAD_OLDER_WITHIN_ROWS && (fits || !stuckRef.current)) loadOlder();
  }, [firstInView, loading, exhausted, loadOlder, rows.length, stuckRef]);

  return (
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
              {virtualItem.index === 0 ? (
                <OlderRow loading={loading} exhausted={exhausted} onLoad={loadOlder} />
              ) : (
                renderRow(virtualItem.index - 1)
              )}
            </div>
          ))}
        </div>
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

/** The top of what is loaded: a way to read the page below it, that page being read, or the
 *  start of the log. One height in every state, so the rows below never shift when it changes. */
function OlderRow({
  loading,
  exhausted,
  onLoad,
}: {
  loading: boolean;
  exhausted: boolean;
  onLoad: () => void;
}) {
  return (
    <div className="flex h-8 items-center justify-center gap-2 text-xs text-muted-foreground">
      {exhausted ? (
        "The start of the log"
      ) : loading ? (
        <>
          <Spinner /> Loading older events…
        </>
      ) : (
        <button type="button" onClick={onLoad} className="underline-offset-2 hover:underline">
          Load older events
        </button>
      )}
    </div>
  );
}

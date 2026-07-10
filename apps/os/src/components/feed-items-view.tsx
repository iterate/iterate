import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@iterate-com/ui/lib/utils";
import { useStreamQuery } from "~/domains/streams/client-libraries/browser/hooks/use-stream-query.ts";
import { Centered } from "~/components/centered.tsx";
import { useStickToBottom } from "~/lib/use-stick-to-bottom.ts";
import type { StreamBrowserDatabase } from "~/domains/streams/client-libraries/browser/stream-browser-db.ts";
import type { FeedItemData } from "~/domains/streams/client-libraries/processors/browser-event-feed/grouping.ts";
import {
  buildFeedItemsFilter,
  shortEventType,
  type FeedItemsFilterInput,
} from "~/lib/stream-feed-filters.ts";

/** How many rows past the virtualizer's window the tail query prefetches. */
const TAIL_PREFETCH_ROWS = 32;
/** Cap on rows retained across window shifts (memory bound for long feeds). */
const MAX_RETAINED_ROWS = 2000;

/**
 * Renders the browser-event-feed processor's `feed_items` collection: one row
 * per specific-renderer singleton or per collapsed run of same-type events,
 * narrowed by {@link FeedItemsFilterInput}.
 *
 * Same virtualization scheme as the agent feed (agent-feed.tsx): the stick
 * owns the tail (useStickToBottom; followOnAppend off), the row window is a
 * live SQL range query over dense positions, and rows are retained across
 * filter changes only when fetched under the same filter. Callers must
 * remount this component when pointing it at a different database (key it by
 * the database identity): the virtualizer's measurement and scroll state are
 * only valid for one stream's history.
 */
export function FeedItemsView({
  database,
  emptyLabel,
  filter: filterInput,
  onInspectEvent,
}: {
  database: StreamBrowserDatabase;
  emptyLabel: string;
  filter: FeedItemsFilterInput;
  /** Opens the raw-event inspector panel at this offset. */
  onInspectEvent: (offset: number) => void;
}) {
  // No memo: building the filter is trivial and db.query dedupes by
  // (sql, params) VALUE, so fresh param arrays don't cause resubscribes.
  const filter = buildFeedItemsFilter(filterInput);
  // "WHERE ..." or "" — interpolated into every query over the collection.
  const where = filter == null ? "" : `WHERE ${filter.whereSql}`;
  const params = filter?.params ?? [];
  const countResult = useStreamQuery(
    database,
    `SELECT COUNT(*) AS count FROM feed_items ${where}`,
    params,
  );
  const itemCount = Number(countResult.data[0]?.count ?? 0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: itemCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 44,
    getItemKey: (index) => index,
    anchorTo: "end",
    // OFF — the stick owns tail-following in DOM truth (see agent-feed.tsx).
    followOnAppend: false,
    scrollEndThreshold: 80,
    overscan: 16,
    // Vertical breathing room lives here, not as wrapper padding, so the
    // virtualizer's coordinates match the scroll element exactly — see
    // agent-feed.tsx for the off-by-chrome tail shortfall this prevents.
    paddingStart: 20,
    paddingEnd: 24,
    // NOT directDomUpdates — see agent-feed.tsx: async row windows break the
    // direct-DOM path's end anchor; classic JSX-owned styles hold it.
  });

  const virtualItems = virtualizer.getVirtualItems();
  const first = virtualItems[0]?.index ?? 0;
  const last = virtualItems.at(-1)?.index ?? -1;
  // While the view is opening (initial end-pin below), anchor the row window
  // to the tail so the opening jump lands on rows with real measured sizes —
  // see agent-feed.tsx for the stranding failure mode this prevents.
  const [initialPinDone, setInitialPinDone] = useState(false);
  const virtualWindowSize = Math.max(0, last + 1 + TAIL_PREFETCH_ROWS - first);
  const windowFirst = initialPinDone ? first : Math.max(0, itemCount - virtualWindowSize);
  // Fetch one row before the window (when there is one) so the topmost visible
  // row has its predecessor available for the colour-coded time delta — the
  // window's first row would otherwise never see the index before it.
  const prefetchBefore = windowFirst > 0 ? 1 : 0;
  const queryOffset = windowFirst - prefetchBefore;
  const windowSize = virtualWindowSize + prefetchBefore;
  // Dense ascending local_index means OFFSET/LIMIT over the ordered (and
  // possibly filtered) collection IS the virtualizer's row window.
  const rowsResult = useStreamQuery(
    database,
    `SELECT local_index, component, first_offset, last_offset, event_count, json(data) AS data
     FROM feed_items ${where}
     ORDER BY local_index ASC LIMIT ? OFFSET ?`,
    [...params, windowSize, queryOffset],
  );
  // Retain rows across range re-queries by MERGING each resolved window into
  // the previously-loaded rows: forgetting off-window rows would re-render
  // them as skeletons on the way back, and the skeleton's measurement would
  // overwrite the row's real size (see agent-feed.tsx for the end-anchor
  // failure this causes). Off-window group rows can go briefly stale (their
  // event_count grows in place) until the window query for their range
  // resolves again. The retained rows are only valid for the filter they
  // were fetched under.
  const lastRowsRef = useRef<{ where: string; rows: Map<number, Record<string, unknown>> } | null>(
    null,
  );
  const retainKey = `${where}:${params.join(" ")}`;
  const rowsByIndex = useMemo(() => {
    const retained =
      lastRowsRef.current?.where === retainKey
        ? lastRowsRef.current.rows
        : new Map<number, Record<string, unknown>>();
    if (rowsResult.status !== "ok") return retained;
    const rows = new Map(retained);
    rowsResult.data.forEach((row, position) => {
      rows.set(queryOffset + position, row);
    });
    if (rows.size > MAX_RETAINED_ROWS) {
      const excess = rows.size - MAX_RETAINED_ROWS;
      let dropped = 0;
      for (const key of rows.keys()) {
        if (dropped >= excess) break;
        rows.delete(key);
        dropped++;
      }
    }
    lastRowsRef.current = { where: retainKey, rows };
    return rows;
  }, [rowsResult.data, rowsResult.status, retainKey, queryOffset]);

  // Scrolling at the tail is owned by the stick (see agent-feed.tsx and the
  // hook's docs); this effect only flips the row window from tail-anchored
  // to virtualizer-driven once the tail row's real data has rendered.
  useLayoutEffect(() => {
    if (initialPinDone || itemCount === 0) return;
    if (rowsByIndex.has(itemCount - 1) && virtualizer.isAtEnd()) setInitialPinDone(true);
  }, [initialPinDone, itemCount, rowsByIndex, virtualizer]);

  const contentRef = useRef<HTMLDivElement>(null);
  useStickToBottom({
    scrollElementRef: scrollRef,
    contentElementRef: contentRef,
    onRelease: () => setInitialPinDone(true),
  });

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      {/* Horizontal chrome only — vertical spacing is the virtualizer's
          paddingStart/paddingEnd so its coordinates match the DOM exactly. */}
      <div className="mx-auto w-full max-w-3xl px-4 md:px-6">
        {countResult.status !== "ok" ? (
          <Centered>
            {countResult.status === "error"
              ? (countResult.error?.message ?? "SQLite query failed")
              : "Opening local SQLite mirror"}
          </Centered>
        ) : itemCount === 0 ? (
          <Centered>
            {filter == null ? emptyLabel : "No feed items match the current filters."}
          </Centered>
        ) : null}
        <div
          ref={contentRef}
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
          data-testid="stream-feed-items"
        >
          {virtualItems.map((item) => {
            const row = rowsByIndex.get(item.index);
            return (
              <div
                className="absolute left-0 top-0 w-full"
                data-index={item.index}
                key={item.key}
                ref={virtualizer.measureElement}
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {row == null ? (
                  // Must measure exactly estimateSize (44px) — see the
                  // agent-feed skeleton for why smaller placeholders break
                  // the end anchor during the initial jump.
                  <div className="h-11 py-1.5">
                    <div className="h-full bg-muted/30" />
                  </div>
                ) : (
                  <FeedItemRow
                    row={row}
                    // The gap is measured from the previous row's LAST event, so
                    // a group's delta is the idle time between groups, not within.
                    previousCreatedAt={feedItemLastCreatedAt(rowsByIndex.get(item.index - 1))}
                    onInspectEvent={onInspectEvent}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const FeedItemRow = memo(function FeedItemRow({
  onInspectEvent,
  previousCreatedAt,
  row,
}: {
  onInspectEvent: (offset: number) => void;
  /** The previous row's last event time — the anchor for this row's gap. */
  previousCreatedAt: string | undefined;
  row: Record<string, unknown>;
}) {
  const data = parseFeedItemData(String(row.data));
  const eventType =
    data && "eventType" in data ? data.eventType : (data?.events[0]?.type ?? String(row.component));
  const eventCount = Number(row.event_count);
  const firstOffset = Number(row.first_offset);
  const lastOffset = Number(row.last_offset);
  const createdAt = data?.events[0]?.createdAt;
  const deltaMs = elapsedMs(previousCreatedAt, createdAt);

  // The whole row is the inspect trigger now (no inline expansion): a click
  // opens the raw-event panel at this row's first offset.
  return (
    <button
      type="button"
      title="Inspect raw event"
      onClick={() => onInspectEvent(firstOffset)}
      data-testid="stream-feed-inspect"
      className={cn(
        "flex w-full cursor-pointer items-baseline gap-2.5 border-b border-border/40 px-3.5 py-1.5",
        "text-left font-mono text-xs text-muted-foreground transition-colors",
        "hover:bg-muted/60 hover:text-foreground",
      )}
    >
      <span className="shrink-0 tabular-nums text-muted-foreground/70">
        {firstOffset === lastOffset ? `#${firstOffset}` : `#${firstOffset}–${lastOffset}`}
      </span>
      <span className="min-w-0 truncate text-foreground/80">{shortEventType(eventType)}</span>
      {eventCount > 1 ? (
        <span className="shrink-0 tabular-nums text-muted-foreground/60">
          ×{eventCount.toLocaleString()}
        </span>
      ) : null}
      <span className="ml-auto flex shrink-0 items-baseline gap-2.5 tabular-nums">
        {deltaMs != null ? (
          <span
            className={cn("text-[10px]", deltaColorClass(deltaMs))}
            title="Time since previous event"
          >
            +{formatTimeDelta(deltaMs)}
          </span>
        ) : null}
        {typeof createdAt === "string" ? (
          <time className="text-[10px] text-muted-foreground/50">
            {new Date(createdAt).toLocaleTimeString()}
          </time>
        ) : null}
      </span>
    </button>
  );
});

/** The last event's timestamp in a feed-items row, used as the next row's gap anchor. */
function feedItemLastCreatedAt(row: Record<string, unknown> | undefined): string | undefined {
  if (row == null) return undefined;
  return parseFeedItemData(String(row.data))?.events.at(-1)?.createdAt;
}

/** Milliseconds between two ISO timestamps, clamped at 0; null if either is missing/unparseable. */
function elapsedMs(from: string | undefined, to: string | undefined): number | null {
  if (from == null || to == null) return null;
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return null;
  return Math.max(0, toMs - fromMs);
}

/** `950ms`, `3.2s`, `1m40s`, `2h5m` — compact, human-readable gap. */
function formatTimeDelta(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(Math.floor(ms / 100) / 10).toFixed(1).replace(/\.0$/, "")}s`;
  const totalSeconds = Math.floor(ms / 1_000);
  if (totalSeconds < 3_600) return `${Math.floor(totalSeconds / 60)}m${totalSeconds % 60}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  return `${Math.floor(totalMinutes / 60)}h${totalMinutes % 60}m`;
}

/** Colour by gap magnitude: near-instant is muted, a long pause runs hot. */
function deltaColorClass(ms: number): string {
  if (ms < 1_000) return "text-muted-foreground/40";
  if (ms < 10_000) return "text-emerald-600 dark:text-emerald-500";
  if (ms < 60_000) return "text-amber-600 dark:text-amber-500";
  if (ms < 600_000) return "text-orange-600 dark:text-orange-500";
  return "text-red-600 dark:text-red-500";
}

function parseFeedItemData(raw: string): FeedItemData | null {
  try {
    return JSON.parse(raw) as FeedItemData;
  } catch {
    return null;
  }
}

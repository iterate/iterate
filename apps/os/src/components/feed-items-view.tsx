import { memo, useLayoutEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@iterate-com/ui/components/dropdown-menu";
import { cn } from "@iterate-com/ui/lib/utils";
import { useStreamQuery } from "~/domains/streams/client-libraries/browser/hooks/use-stream-query.ts";
import { Centered } from "~/components/centered.tsx";
import type { StreamBrowserDatabase } from "~/domains/streams/client-libraries/browser/stream-browser-db.ts";
import type { FeedItemData } from "~/domains/streams/client-libraries/processors/browser-event-feed/grouping.ts";
import {
  buildFeedItemsFilter,
  FEED_TYPE_EXPRESSION,
  shortComponent,
  shortEventType,
  type FeedItemsFilterInput,
} from "~/lib/stream-feed-filters.ts";

/** How many rows past the virtualizer's window the tail query prefetches. */
const TAIL_PREFETCH_ROWS = 32;

/**
 * Renders the browser-event-feed processor's `feed_items` collection: one row
 * per specific-renderer singleton or per collapsed run of same-type events,
 * narrowed by {@link FeedItemsFilterInput}.
 *
 * Same virtualization scheme as the agent feed (agent-feed.tsx): TanStack
 * Virtual owns the tail (anchorTo end + followOnAppend), the row window is a
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
    followOnAppend: true,
    scrollEndThreshold: 80,
    overscan: 16,
    directDomUpdates: true,
  });

  // Open at the newest items; later appends are followOnAppend's job (see
  // agent-feed.tsx for why the initial position is set explicitly).
  useLayoutEffect(() => {
    virtualizer.scrollToEnd();
  }, [virtualizer]);

  const virtualItems = virtualizer.getVirtualItems();
  const first = virtualItems[0]?.index ?? 0;
  const last = virtualItems.at(-1)?.index ?? -1;
  // Fetch one row before the window (when there is one) so the topmost visible
  // row has its predecessor available for the colour-coded time delta — the
  // window's `first` row would otherwise never see index `first - 1`.
  const prefetchBefore = first > 0 ? 1 : 0;
  const queryOffset = first - prefetchBefore;
  const windowSize = Math.max(0, last + 1 + TAIL_PREFETCH_ROWS - first) + prefetchBefore;
  // Dense ascending local_index means OFFSET/LIMIT over the ordered (and
  // possibly filtered) collection IS the virtualizer's row window.
  const rowsResult = useStreamQuery(
    database,
    `SELECT local_index, component, first_offset, last_offset, event_count, json(data) AS data
     FROM feed_items ${where}
     ORDER BY local_index ASC LIMIT ? OFFSET ?`,
    [...params, windowSize, queryOffset],
  );
  // Retain the last committed rows across range re-queries so a shifting
  // window doesn't blank already-visible rows to skeletons. The retained rows
  // are only valid for the filter they were fetched under (see agent-feed).
  const lastRowsRef = useRef<{ where: string; rows: Map<number, Record<string, unknown>> } | null>(
    null,
  );
  const retainKey = `${where}:${params.join(" ")}`;
  const rowsByIndex = useMemo(() => {
    if (rowsResult.status !== "ok") {
      const retained = lastRowsRef.current;
      return retained?.where === retainKey
        ? retained.rows
        : new Map<number, Record<string, unknown>>();
    }
    const rows = new Map<number, Record<string, unknown>>();
    rowsResult.data.forEach((row, position) => {
      rows.set(queryOffset + position, row);
    });
    lastRowsRef.current = { where: retainKey, rows };
    return rows;
  }, [rowsResult.data, rowsResult.status, retainKey, queryOffset]);

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 pb-6 pt-5 md:px-6">
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
                  <div className="h-8 bg-muted/30" />
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

/**
 * Any-of filter for feed_items.component (group, stream.woken, …) — the
 * "feed item type" half of the dual filter model.
 */
export function FeedComponentsFilter({
  database,
  onChange,
  value,
}: {
  database: StreamBrowserDatabase;
  onChange: (components: string[] | null) => void;
  value: readonly string[] | null;
}) {
  const result = useStreamQuery(
    database,
    `SELECT component, COUNT(*) AS total FROM feed_items GROUP BY component ORDER BY component`,
    [],
  );
  const options = result.data.flatMap((row) =>
    typeof row.component === "string"
      ? [{ count: Number(row.total ?? 0), type: row.component }]
      : [],
  );
  return (
    <MultiCheckFilter
      dataTestId="stream-feed-component"
      emptyLabel="All components"
      labelSingular="component"
      labelPlural="components"
      options={options}
      shortLabel={shortComponent}
      value={value}
      onChange={onChange}
    />
  );
}

/**
 * Any-of event-type filter for feed items: primary event type of a group or
 * singleton (the "event types inside raw feed items" half of the dual model).
 * Scoped to the active preset's prefix so offered types can actually match.
 */
export function FeedEventTypesFilter({
  database,
  eventTypePrefix,
  onChange,
  value,
}: {
  database: StreamBrowserDatabase;
  eventTypePrefix: string | null;
  onChange: (eventTypes: string[] | null) => void;
  value: readonly string[] | null;
}) {
  const filter = buildFeedItemsFilter({
    eventTypePrefix,
    eventTypes: null,
    components: null,
    searchQuery: null,
    offsetFrom: null,
    offsetTo: null,
  });
  const typesResult = useStreamQuery(
    database,
    `SELECT ${FEED_TYPE_EXPRESSION} AS event_type, SUM(event_count) AS total
     FROM feed_items ${filter == null ? "" : `WHERE ${filter.whereSql}`}
     GROUP BY event_type ORDER BY event_type`,
    filter?.params ?? [],
  );
  const types = typesResult.data.flatMap((row) =>
    typeof row.event_type === "string"
      ? [{ count: Number(row.total ?? 0), type: row.event_type }]
      : [],
  );
  return (
    <MultiCheckFilter
      dataTestId="stream-feed-event-type"
      emptyLabel="All event types"
      labelSingular="event type"
      labelPlural="event types"
      options={types}
      shortLabel={shortEventType}
      value={value}
      onChange={onChange}
    />
  );
}

function MultiCheckFilter({
  dataTestId,
  emptyLabel,
  labelSingular,
  labelPlural,
  options,
  shortLabel,
  value,
  onChange,
}: {
  dataTestId: string;
  emptyLabel: string;
  labelSingular: string;
  labelPlural: string;
  options: readonly { count: number; type: string }[];
  shortLabel: (type: string) => string;
  value: readonly string[] | null;
  onChange: (next: string[] | null) => void;
}) {
  const selected = value ?? [];
  // Stale URL values must still render as selections so they can be unchecked.
  const staleSelections = selected.filter((type) => !options.some((entry) => entry.type === type));
  const merged = [...staleSelections.map((type) => ({ count: 0, type })), ...options].sort((a, b) =>
    shortLabel(a.type).localeCompare(shortLabel(b.type)),
  );

  function toggle(type: string, checked: boolean) {
    const next = checked ? [...selected, type] : selected.filter((entry) => entry !== type);
    onChange(next.length === 0 ? null : next);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="max-w-56 font-mono text-xs font-normal"
            data-testid={dataTestId}
          />
        }
      >
        <span className="truncate">
          {selected.length === 0
            ? emptyLabel
            : selected.length === 1
              ? shortLabel(selected[0]!)
              : `${selected.length} ${labelPlural}`}
        </span>
        <ChevronDownIcon className="size-3 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[min(90vw,34rem)] max-w-[calc(100vw-2rem)]">
        <div className="grid max-h-96 grid-cols-2 gap-x-1 overflow-y-auto">
          {merged.length === 0 ? (
            <p className="col-span-2 px-2 py-1.5 text-xs text-muted-foreground">
              No {labelPlural} in the mirror yet.
            </p>
          ) : (
            merged.map((entry) => (
              <DropdownMenuCheckboxItem
                key={entry.type}
                checked={selected.includes(entry.type)}
                closeOnClick={false}
                onCheckedChange={(checked) => toggle(entry.type, checked)}
                className="min-w-0 font-mono text-xs"
              >
                <span className="min-w-0 flex-1 truncate" title={shortLabel(entry.type)}>
                  {shortLabel(entry.type)}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {entry.count.toLocaleString()}
                </span>
              </DropdownMenuCheckboxItem>
            ))
          )}
        </div>
        {selected.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-xs" onClick={() => onChange(null)}>
              Clear {labelSingular} filter
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

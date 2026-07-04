import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDownIcon, PanelRightOpenIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
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
import type { StreamEvent } from "~/types.ts";
import {
  buildFeedItemsFilter,
  FEED_TYPE_EXPRESSION,
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
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());

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
  const windowSize = Math.max(0, last + 1 + TAIL_PREFETCH_ROWS - first);
  // Dense ascending local_index means OFFSET/LIMIT over the ordered (and
  // possibly filtered) collection IS the virtualizer's row window.
  const rowsResult = useStreamQuery(
    database,
    `SELECT local_index, component, first_offset, last_offset, event_count, json(data) AS data
     FROM feed_items ${where}
     ORDER BY local_index ASC LIMIT ? OFFSET ?`,
    [...params, windowSize, first],
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
      rows.set(first + position, row);
    });
    lastRowsRef.current = { where: retainKey, rows };
    return rows;
  }, [rowsResult.data, rowsResult.status, retainKey, first]);

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
            const localIndex = row == null ? item.index : Number(row.local_index);
            return (
              <div
                className="absolute left-0 top-0 w-full"
                data-index={item.index}
                key={item.key}
                ref={virtualizer.measureElement}
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {row == null ? (
                  <div className="my-1 h-9 rounded-xl bg-muted/40" />
                ) : (
                  <FeedItemRow
                    row={row}
                    expanded={expanded.has(localIndex)}
                    onInspectEvent={onInspectEvent}
                    onToggle={() =>
                      setExpanded((previous) => {
                        const next = new Set(previous);
                        if (next.has(localIndex)) next.delete(localIndex);
                        else next.add(localIndex);
                        return next;
                      })
                    }
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
  expanded,
  onInspectEvent,
  onToggle,
  row,
}: {
  expanded: boolean;
  onInspectEvent: (offset: number) => void;
  onToggle: () => void;
  row: Record<string, unknown>;
}) {
  const data = parseFeedItemData(String(row.data));
  const eventType =
    data && "eventType" in data ? data.eventType : (data?.events[0]?.type ?? String(row.component));
  const eventCount = Number(row.event_count);
  const firstOffset = Number(row.first_offset);
  const lastOffset = Number(row.last_offset);
  const createdAt = data?.events[0]?.createdAt;
  const events = data?.events ?? [];

  return (
    <div className="py-0.5">
      <div
        className={cn(
          "flex w-full items-center gap-1 rounded-xl bg-muted/40 pr-1.5 transition-colors",
          "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
          expanded && "rounded-b-none bg-muted/70 text-foreground",
        )}
      >
        <button
          aria-expanded={expanded}
          onClick={onToggle}
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer items-baseline gap-2.5 py-2 pl-3.5 text-left font-mono text-xs"
        >
          <span className="shrink-0 tabular-nums">
            {firstOffset === lastOffset ? `#${firstOffset}` : `#${firstOffset}–${lastOffset}`}
          </span>
          <span className="min-w-0 truncate text-foreground/80">{shortEventType(eventType)}</span>
          {eventCount > 1 ? (
            <span className="shrink-0 rounded-full bg-background px-1.5 py-px text-[10px]">
              ×{eventCount.toLocaleString()}
            </span>
          ) : null}
          {typeof createdAt === "string" ? (
            <time className="ml-auto shrink-0 text-[10px]">
              {new Date(createdAt).toLocaleTimeString()}
            </time>
          ) : null}
        </button>
        <button
          type="button"
          title="Inspect raw event"
          onClick={() => onInspectEvent(firstOffset)}
          className="shrink-0 cursor-pointer rounded-lg p-1.5 text-muted-foreground/70 hover:bg-background hover:text-foreground"
          data-testid="stream-feed-inspect"
        >
          <PanelRightOpenIcon className="size-3.5" />
        </button>
      </div>
      {expanded ? (
        <div className="rounded-b-xl bg-muted/40 px-3.5 pb-3 pt-1">
          {events.length > 1 ? (
            <GroupEventList events={events} onInspectEvent={onInspectEvent} />
          ) : (
            <SerializedObjectCodeBlock data={events.length === 1 ? events : row.data} />
          )}
        </div>
      ) : null}
    </div>
  );
});

/**
 * The events inside an expanded group row, one line each — clicking a line
 * opens that event in the raw-event inspector (a collapsed run can hold up to
 * 200 events; a single JSON dump of all of them is unreadable).
 */
function GroupEventList({
  events,
  onInspectEvent,
}: {
  events: readonly StreamEvent[];
  onInspectEvent: (offset: number) => void;
}) {
  return (
    <ul>
      {events.map((event) => (
        <li key={event.offset}>
          <button
            type="button"
            onClick={() => onInspectEvent(event.offset)}
            className="flex w-full cursor-pointer items-baseline gap-2.5 rounded-md px-2 py-1 text-left font-mono text-xs text-muted-foreground hover:bg-background hover:text-foreground"
          >
            <span className="shrink-0 tabular-nums">#{event.offset}</span>
            <span className="min-w-0 truncate">{shortEventType(event.type)}</span>
            <time className="ml-auto shrink-0 text-[10px]">
              {new Date(event.createdAt).toLocaleTimeString()}
            </time>
          </button>
        </li>
      ))}
    </ul>
  );
}

function parseFeedItemData(raw: string): FeedItemData | null {
  try {
    return JSON.parse(raw) as FeedItemData;
  } catch {
    return null;
  }
}

/**
 * Any-of event-type filter for the feed-items presets: a roomy two-column grid
 * of checkboxes, one per distinct primary event type currently in the local
 * mirror (scoped to the active preset's prefix so the offered types can
 * actually match), sorted alphabetically by display name and annotated with
 * per-type event counts.
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
  const selected = value ?? [];
  // Stale URL values (hand-edited, or events not mirrored yet) must still
  // render as selections so they can be unchecked. Sort the merged set by the
  // displayed short name so the two-column grid reads alphabetically (the SQL's
  // ORDER BY is on the full type; the stale entries are appended out of band).
  const staleSelections = selected.filter((type) => !types.some((entry) => entry.type === type));
  const options = [...staleSelections.map((type) => ({ count: 0, type })), ...types].sort((a, b) =>
    shortEventType(a.type).localeCompare(shortEventType(b.type)),
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
            data-testid="stream-feed-event-type"
          />
        }
      >
        <span className="truncate">
          {selected.length === 0
            ? "All event types"
            : selected.length === 1
              ? shortEventType(selected[0]!)
              : `${selected.length} event types`}
        </span>
        <ChevronDownIcon className="size-3 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[min(90vw,34rem)] max-w-[calc(100vw-2rem)]">
        <div className="grid max-h-96 grid-cols-2 gap-x-1 overflow-y-auto">
          {options.length === 0 ? (
            <p className="col-span-2 px-2 py-1.5 text-xs text-muted-foreground">
              No event types in the mirror yet.
            </p>
          ) : (
            options.map((entry) => (
              <DropdownMenuCheckboxItem
                key={entry.type}
                checked={selected.includes(entry.type)}
                closeOnClick={false}
                onCheckedChange={(checked) => toggle(entry.type, checked)}
                className="min-w-0 font-mono text-xs"
              >
                <span className="min-w-0 flex-1 truncate" title={shortEventType(entry.type)}>
                  {shortEventType(entry.type)}
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
              Clear selection
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

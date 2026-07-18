import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ZERO_AGENT_RUNTIME, type AgentRuntime } from "@iterate-com/shared/agent-events";
import type { AgentUiItem, AgentUiState } from "@iterate-com/ui/components/events/agent-ui-reducer";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@iterate-com/ui/components/empty";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { cn } from "@iterate-com/ui/lib/utils";
import { useStreamQuery } from "~/domains/streams/client-libraries/browser/hooks/use-stream-query.ts";
import type {
  SqlValue,
  StreamBrowserDatabase,
} from "~/domains/streams/client-libraries/browser/stream-browser-db.ts";
import {
  AGENT_KIND_PREFIX,
  type RawFeedItemData,
} from "~/domains/streams/client-libraries/processors/browser-feed/projector.ts";
import { AgentFeedItemRow, AgentLiveActivity } from "~/components/agent-feed.tsx";
import { useStickToBottom } from "~/lib/use-stick-to-bottom.ts";
import {
  buildStreamFeedWhere,
  shortEventType,
  type StreamFeedQueryInput,
} from "~/lib/stream-feed-filters.ts";

/** How many rows past the virtualizer's window the tail query prefetches. */
const TAIL_PREFETCH_ROWS = 32;
/** Cap on rows retained across window shifts (memory bound for long feeds). */
const MAX_RETAINED_ROWS = 2000;
const EMPTY_AGENT_ITEMS: readonly AgentUiItem[] = [];

/** One parsed feed_items row, ready to render. */
type FeedRow = {
  kind: string;
  firstOffset: number;
  lastOffset: number;
  eventCount: number;
  /** The settled chat item for `agent.*` rows. */
  agentItem: AgentUiItem | null;
  /** The grouped raw events for `raw.*` rows. */
  rawData: RawFeedItemData | null;
};

/**
 * THE stream feed: one TanStack virtual list over the `feed_items` table,
 * `ORDER BY local_index`. Every mode is a filter over the same list —
 * Pretty shows `agent.*` rows, Raw shows `raw.*` rows, Pretty+raw shows both
 * interleaved (see {@link StreamFeedQueryInput}) — so pretty chat rows and raw
 * debug rows share one scroll position and one total order.
 *
 * Virtualization scheme (see agent-feed.tsx history — PRs #1847/#1848 — for
 * the failure modes each piece prevents): the stick owns the tail in DOM
 * truth (useStickToBottom; followOnAppend off), the row window is a live SQL
 * LIMIT/OFFSET query over the filtered collection's dense positions, rows are
 * retained across window shifts with identity stability, and skeletons
 * measure exactly estimateSize. The live in-flight activity is a trailing
 * virtual item rendered straight from reduced state. (Queued messages render
 * with the composer — they're pending input, not history.)
 *
 * Callers must remount this component when pointing it at a different
 * database or mode (key it by database identity + mode): the virtualizer's
 * measurement and scroll state are only valid for one collection's history.
 */
export function StreamFeedView({
  database,
  emptyLabel = "No events in this stream yet.",
  filter,
  isPending = false,
  liveState,
  transientAgentItems = EMPTY_AGENT_ITEMS,
  runtime = ZERO_AGENT_RUNTIME,
  onInspectEvent,
  onInspectLlmRequest,
  onInspectScriptExecution,
  projectSlug,
}: {
  database: StreamBrowserDatabase;
  emptyLabel?: string;
  /** Which kind families (and constraints within them) this mode shows. */
  filter: StreamFeedQueryInput;
  isPending?: boolean;
  /** Reduced agent state for the live tail; null hides the trailing items. */
  liveState: AgentUiState | null;
  /** Runtime-projected settled items which are not journal database rows. */
  transientAgentItems?: readonly AgentUiItem[];
  /** Current processor runtime from the agent live-state subscription. */
  runtime?: AgentRuntime;
  /** Opens the raw-event inspector panel at this offset (raw rows only). */
  onInspectEvent?: (offset: number) => void;
  /** Opens the LLM request inspector at this llmRequestOffset (llm steps only). */
  onInspectLlmRequest?: (llmRequestOffset: number) => void;
  /** Opens the script execution inspector at this execution id (code steps only). */
  onInspectScriptExecution?: (executionId: string) => void;
  projectSlug?: string;
}) {
  // No memo: building the filter is trivial and db.query dedupes by
  // (sql, params) VALUE, so fresh param arrays don't cause resubscribes.
  const { whereSql, params } = buildStreamFeedWhere(filter);
  const countResult = useStreamQuery(
    database,
    `SELECT COUNT(*) AS count FROM feed_items WHERE ${whereSql}`,
    params,
  );
  const itemCount = Number(countResult.data[0]?.count ?? 0);
  const live = filter.agent == null ? null : (liveState?.live ?? null);
  const transientItems = filter.agent == null ? EMPTY_AGENT_ITEMS : transientAgentItems;
  const scrollRef = useRef<HTMLDivElement>(null);
  // Ids of activity summaries the user expanded. Operation rows inside an
  // expanded activity open their URL-backed inspector instead of nesting a
  // second disclosure state.
  const [toggledIds, setToggledIds] = useState<ReadonlySet<string>>(new Set());

  // The live in-flight activity is the list's trailing item so it's inside
  // the virtualizer's size model: its growth shows up in getTotalSize()/the
  // sizer's height, which is what the stick's ResizeObserver follows and what
  // anchorTo's mid-history compensation measures. Rendering it outside the
  // list would hide its height from both.
  const transientCount = transientItems.length;
  const liveCount = live == null ? 0 : 1;
  const totalCount = itemCount + transientCount + liveCount;

  // Settled rows are append-only at dense positions, so the position is a
  // stable key for them. The live activity keeps its own key: its index
  // shifts up every time a settled row lands, and keying it by index would
  // hand the (often tall) live block's cached measurement to the new settled
  // row — a visible jump right when a turn settles.
  const getItemKey = useCallback(
    (index: number) => {
      if (index < itemCount) return index;
      const transient = transientItems[index - itemCount];
      return transient == null ? "live" : `transient:${transient.id}`;
    },
    [itemCount, transientItems],
  );

  const virtualizer = useVirtualizer({
    count: totalCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 56,
    getItemKey,
    anchorTo: "end",
    // followOnAppend stays OFF — the stick owns the tail (useStickToBottom).
    // The library's follow cannot own it here because its gate is isAtEnd():
    // every time the composer below this feed grows (multi-line draft,
    // attachment chips), the viewport shrinks with NO scroll event, so
    // distance-from-end silently accumulates — past scrollEndThreshold the
    // library concludes the reader left the tail and stops following appends
    // altogether. Rect changes never re-pin (observeElementRect only updates
    // scrollRect and recalculates the range). Running follow AND the stick
    // concurrently is two writers where follow's scroll-reconcile loop is
    // uncancellable (TanStack/virtual#1221), so the stick is the only writer.
    followOnAppend: false,
    scrollEndThreshold: 80,
    overscan: 16,
    // The feed's breathing room above/below the rows lives HERE, not as
    // wrapper padding. Vertical chrome the virtualizer can't see would shift
    // its coordinate space off the scroll element's: every scrollToEnd /
    // isAtEnd / followOnAppend would then resolve that many px above the real
    // DOM bottom, leaving the newest message hidden below the fold.
    paddingStart: 20,
    paddingEnd: 24,
    // Deliberately NOT directDomUpdates: in that mode the virtualizer owns
    // each row's transform and the container height, and this feed's async
    // row loading (SQL windows resolving after the rows render) triggers
    // remeasurement storms the direct-DOM path loses track of — the browser
    // clamps scrollTop against a stale container height and the end anchor
    // strands mid-history. The classic mode below (JSX-owned styles) rides
    // the same anchorTo machinery and holds the pin.
  });

  const virtualItems = virtualizer.getVirtualItems();
  const first = virtualItems[0]?.index ?? 0;
  const last = virtualItems.at(-1)?.index ?? -1;
  // While the feed is opening (initial end-pin below), anchor the row window
  // to the TAIL regardless of the virtualizer's not-yet-scrolled range: the
  // opening jump must land on rows with real measured sizes, or estimate
  // error makes the total shrink under the clamped scroll offset and strands
  // the reader mid-history. Once pinned, the virtualizer's range drives the
  // window again.
  const [initialPinDone, setInitialPinDone] = useState(false);
  const virtualWindowSize = Math.max(0, last + 1 + TAIL_PREFETCH_ROWS - first);
  const windowFirst = initialPinDone
    ? Math.min(first, itemCount)
    : Math.max(0, itemCount - virtualWindowSize);
  // Fetch one row before the window (when there is one) so the topmost visible
  // raw row has its predecessor available for the colour-coded time delta —
  // the window's first row would otherwise never see the index before it.
  const prefetchBefore = windowFirst > 0 ? 1 : 0;
  const queryOffset = windowFirst - prefetchBefore;
  const windowSize = virtualWindowSize + prefetchBefore;
  const rowsByIndex = useRetainedFeedRows({ database, whereSql, params, queryOffset, windowSize });

  // All SCROLLING at the tail is owned by the stick (see the hook's docs):
  // it opens the feed at the newest content, holds the bottom through async
  // row loads AND viewport resizes (the composer below has variable height),
  // and releases on real user input. This effect only governs which rows we
  // FETCH while opening — it flips the row window from tail-anchored to
  // virtualizer-driven once the tail row's real data has rendered (or the
  // reader released the stick and took over, via onRelease below).
  useLayoutEffect(() => {
    if (initialPinDone || totalCount === 0) return;
    const tailRowLoaded = itemCount === 0 || rowsByIndex.has(itemCount - 1);
    if (tailRowLoaded && virtualizer.isAtEnd()) setInitialPinDone(true);
  }, [initialPinDone, totalCount, itemCount, rowsByIndex, virtualizer]);

  const contentRef = useRef<HTMLDivElement>(null);
  useStickToBottom({
    scrollElementRef: scrollRef,
    contentElementRefs: [contentRef],
    onRelease: () => setInitialPinDone(true),
  });

  // Stable identity so the memoized settled rows skip the per-chunk re-renders
  // driven by the live streaming state.
  const toggleExpanded = useCallback((id: string) => {
    setToggledIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const filtersNarrow =
    filter.raw != null &&
    (filter.raw.eventTypes != null ||
      filter.raw.components != null ||
      filter.raw.searchQuery != null ||
      filter.raw.offsetFrom != null ||
      filter.raw.offsetTo != null);

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      {/* Horizontal chrome only — vertical spacing is the virtualizer's
          paddingStart/paddingEnd so its coordinates match the DOM exactly. */}
      <div className="mx-auto w-full max-w-3xl px-4 md:px-6">
        {totalCount === 0 ? (
          <Empty className="min-h-48">
            <EmptyHeader>
              {isPending ? <Spinner className="size-4" /> : null}
              <EmptyTitle>{isPending ? "Connecting to the stream" : "Nothing here yet"}</EmptyTitle>
              {isPending ? null : (
                <EmptyDescription>
                  {filtersNarrow ? "No feed items match the current filters." : emptyLabel}
                </EmptyDescription>
              )}
            </EmptyHeader>
          </Empty>
        ) : null}
        <div
          ref={contentRef}
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
          data-testid="stream-feed-items"
        >
          {virtualItems.map((virtualItem) => {
            const index = virtualItem.index;
            const transientItem = transientItems[index - itemCount];
            const isLiveItem = live != null && index === itemCount + transientCount;
            const row = index < itemCount ? rowsByIndex.get(index)?.row : undefined;
            return (
              <div
                key={virtualItem.key}
                data-index={index}
                ref={virtualizer.measureElement}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${virtualItem.start}px)` }}
              >
                {isLiveItem ? (
                  <AgentLiveActivity
                    live={live}
                    runtime={runtime}
                    toggledIds={toggledIds}
                    onToggle={toggleExpanded}
                    onInspectLlmRequest={onInspectLlmRequest}
                    onInspectScriptExecution={onInspectScriptExecution}
                  />
                ) : transientItem != null ? (
                  <AgentFeedItemRow
                    item={transientItem}
                    toggledIds={toggledIds}
                    onToggle={toggleExpanded}
                    onInspectLlmRequest={onInspectLlmRequest}
                    onInspectScriptExecution={onInspectScriptExecution}
                    projectSlug={projectSlug}
                  />
                ) : row == null ? (
                  // Not-yet-loaded rows must measure exactly estimateSize
                  // (56px, margins don't count toward offsetHeight): the
                  // initial jump to the end renders these before their SQL
                  // window resolves, and if they measured smaller the total
                  // size would shrink under the scroll offset and break the
                  // end anchor before the real rows arrive.
                  <div className="h-14 py-2">
                    <div className="h-full rounded-xl bg-muted/40" />
                  </div>
                ) : row.agentItem != null ? (
                  <AgentFeedItemRow
                    item={row.agentItem}
                    toggledIds={toggledIds}
                    onToggle={toggleExpanded}
                    onInspectLlmRequest={onInspectLlmRequest}
                    onInspectScriptExecution={onInspectScriptExecution}
                    projectSlug={projectSlug}
                  />
                ) : (
                  <RawFeedItemRow
                    row={row}
                    // The gap is measured from the previous row's LAST moment,
                    // so a group's delta is the idle time between rows, not
                    // within one.
                    previousTimestampMs={rowLastTimestampMs(rowsByIndex.get(index - 1)?.row)}
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

/**
 * The virtualizer's row window as parsed, identity-stable rows: a live SQL
 * LIMIT/OFFSET query over the filtered collection's dense positions, merged
 * into previously-loaded rows (bounded at MAX_RETAINED_ROWS). Retention is
 * load-bearing, not a cache nicety: replacing the map with just the latest
 * window would forget loaded rows the moment the window shifts; rows scrolled
 * back into view would then re-render as skeletons, and the skeleton's
 * measurement would overwrite the row's real size — with an end-anchored
 * virtualizer those size collapses cascade into the total thrashing and the
 * scroll position stranding mid-history. The retained rows are only valid for
 * the filter they were fetched under — reusing them across a filter change
 * would briefly show unfiltered rows.
 */
function useRetainedFeedRows({
  database,
  whereSql,
  params,
  queryOffset,
  windowSize,
}: {
  database: StreamBrowserDatabase;
  whereSql: string;
  params: SqlValue[];
  queryOffset: number;
  windowSize: number;
}): ReadonlyMap<number, { fingerprint: string; row: FeedRow }> {
  // The filtered collection is ordered by local_index, so OFFSET/LIMIT over it
  // IS the virtualizer's row window in dense positions.
  const rowsResult = useStreamQuery(
    database,
    `SELECT local_index, kind, first_offset, last_offset, event_count, json(data) AS data
     FROM feed_items WHERE ${whereSql}
     ORDER BY local_index ASC LIMIT ? OFFSET ?`,
    [...params, windowSize, queryOffset],
  );
  const retainKey = `${whereSql}:${params.join(" ")}`;
  const lastRowsRef = useRef<{
    retainKey: string;
    rows: Map<number, { fingerprint: string; row: FeedRow }>;
  } | null>(null);
  return useMemo(() => {
    const retained =
      lastRowsRef.current?.retainKey === retainKey
        ? lastRowsRef.current.rows
        : new Map<number, { fingerprint: string; row: FeedRow }>();
    if (rowsResult.status !== "ok") return retained;
    const rows = new Map(retained);
    rowsResult.data.forEach((sqlRow, position) => {
      const index = queryOffset + position;
      const kind = String(sqlRow.kind);
      const raw = String(sqlRow.data);
      // Identity stability is load-bearing: rows re-parse (new object) ONLY
      // when their JSON changed. Handing memoized rows fresh-but-equal items
      // on every window re-query re-renders their markdown, whose async
      // re-parse collapses the row to empty for a frame — and a burst of
      // rows momentarily measuring ~16px is exactly the kind of size storm
      // that breaks the virtualizer's end anchor.
      const fingerprint = `${kind}:${raw}`;
      if (rows.get(index)?.fingerprint === fingerprint) return;
      try {
        const isAgent = kind.startsWith(AGENT_KIND_PREFIX);
        const parsed = JSON.parse(raw) as AgentUiItem | RawFeedItemData;
        rows.set(index, {
          fingerprint,
          row: {
            kind,
            firstOffset: Number(sqlRow.first_offset),
            lastOffset: Number(sqlRow.last_offset),
            eventCount: Number(sqlRow.event_count),
            agentItem: isAgent ? (parsed as AgentUiItem) : null,
            rawData: isAgent ? null : (parsed as RawFeedItemData),
          },
        });
      } catch {
        // Skip unparseable rows; the row stays a skeleton.
      }
    });
    // Keep memory bounded on very long histories: drop the oldest-inserted
    // entries once well past what any viewport plus overscan can show.
    if (rows.size > MAX_RETAINED_ROWS) {
      const excess = rows.size - MAX_RETAINED_ROWS;
      let dropped = 0;
      for (const key of rows.keys()) {
        if (dropped >= excess) break;
        rows.delete(key);
        dropped++;
      }
    }
    lastRowsRef.current = { retainKey, rows };
    return rows;
  }, [rowsResult.data, rowsResult.status, retainKey, queryOffset]);
}

const RawFeedItemRow = memo(function RawFeedItemRow({
  onInspectEvent,
  previousTimestampMs,
  row,
}: {
  onInspectEvent?: (offset: number) => void;
  /** The previous row's last moment — the anchor for this row's gap. */
  previousTimestampMs: number | null;
  row: FeedRow;
}) {
  const data = row.rawData;
  const eventType =
    data != null && "eventType" in data ? data.eventType : (data?.events[0]?.type ?? row.kind);
  const createdAt = data?.events[0]?.createdAt;
  const createdAtMs = createdAt == null ? null : Date.parse(createdAt);
  const deltaMs =
    previousTimestampMs == null || createdAtMs == null || Number.isNaN(createdAtMs)
      ? null
      : Math.max(0, createdAtMs - previousTimestampMs);

  // The whole row is the inspect trigger (no inline expansion): a click opens
  // the raw-event panel at this row's first offset.
  return (
    <button
      type="button"
      title="Inspect raw event"
      onClick={() => onInspectEvent?.(row.firstOffset)}
      data-testid="stream-feed-inspect"
      className={cn(
        "flex w-full cursor-pointer items-baseline gap-2.5 border-b border-border/40 px-3.5 py-1.5",
        "text-left font-mono text-xs text-muted-foreground transition-colors",
        "hover:bg-muted/60 hover:text-foreground",
      )}
    >
      <span className="shrink-0 tabular-nums text-muted-foreground/70">
        {row.firstOffset === row.lastOffset
          ? `#${row.firstOffset}`
          : `#${row.firstOffset}–${row.lastOffset}`}
      </span>
      <span className="min-w-0 truncate text-foreground/80">{shortEventType(eventType)}</span>
      {row.eventCount > 1 ? (
        <span className="shrink-0 tabular-nums text-muted-foreground/60">
          ×{row.eventCount.toLocaleString()}
        </span>
      ) : null}
      <span className="ml-auto flex shrink-0 items-baseline gap-2.5 tabular-nums">
        {deltaMs != null ? (
          <span
            className={cn("text-[10px]", deltaColorClass(deltaMs))}
            title="Time since previous feed item"
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

/**
 * The last moment covered by a feed row, used as the next raw row's gap
 * anchor: a raw row ends at its last event's createdAt, an agent row at its
 * item timestamp (activities: when they ended).
 */
function rowLastTimestampMs(row: FeedRow | undefined): number | null {
  if (row == null) return null;
  if (row.rawData != null) {
    const createdAt = row.rawData.events.at(-1)?.createdAt;
    const parsed = createdAt == null ? Number.NaN : Date.parse(createdAt);
    return Number.isNaN(parsed) ? null : parsed;
  }
  const item = row.agentItem;
  if (item == null) return null;
  if (item.kind === "activity") return item.endedAtMs ?? item.startedAtMs;
  return item.timestampMs;
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

// The "feed" sibling view: feed_items from the unified browser-feed processor.
// Raw rows: consecutive events of the same type collapse into one raw.group row;
// specific-renderer types (created/woken/child-stream-created) always get their own
// raw.* singleton row with custom UI. Agent rows (kind agent.*) render generically —
// this debug app has no chat UI. Uses the same virtualized tail-following
// scroll shell as the raw-events view.

import { Link } from "@tanstack/react-router";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { streamViewSearch, type StreamViewSearch } from "../lib/stream-view-search.ts";
import { createCapnwebStreamClient } from "../lib/capnweb-stream-browser-client.ts";
import { useStickToBottom } from "../lib/use-stick-to-bottom.ts";
import {
  acquireStreamRuntime,
  type StreamBrowserSnapshot,
  type StreamBrowserStore,
} from "~/domains/streams/client-libraries/browser/stream-browser-store.ts";
import type { StreamBrowserDatabase } from "~/domains/streams/client-libraries/browser/stream-browser-db.ts";
import { BROWSER_STREAM_PROCESSORS } from "~/domains/streams/client-libraries/browser/browser-stream-processors.ts";
import { useStreamQuery } from "~/domains/streams/client-libraries/browser/hooks/use-stream-query.ts";

type FeedItemRow = {
  local_index: number;
  kind: string;
  first_offset: number;
  last_offset: number;
  event_count: number;
  data: Record<string, unknown>;
};

const SPECIFIC_RENDERER_TYPES: Record<string, string> = {
  "raw.stream.created": "events.iterate.com/stream/created",
  "raw.stream.woken": "events.iterate.com/stream/woken",
  "raw.stream.child-stream-created": "events.iterate.com/stream/child-stream-created",
};

export function EventFeedView({ streamView }: { streamView: StreamViewSearch }) {
  const store = useMemo(
    () =>
      acquireStreamRuntime({
        streamPath: streamView.path,
        projectId: streamView.projectId,
        createStreamClient: createCapnwebStreamClient,
        processors: BROWSER_STREAM_PROCESSORS,
      }),
    [streamView.projectId, streamView.path],
  );
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
  const db = store.streamDatabase;

  const countResult = useStreamQuery(db, `SELECT COUNT(*) AS count FROM feed_items`);
  const itemCount = Number(countResult.data[0]?.count ?? 0);

  if (countResult.status !== "ok") {
    return (
      <section
        aria-label="Event feed"
        className="relative grid min-h-0 flex-1 place-items-center overflow-y-auto bg-white"
      >
        <div className="flex min-h-60 items-center justify-center gap-2.5 text-sm text-slate-500">
          <div
            className="size-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600"
            aria-hidden="true"
          />
          <span>opening feed_items table</span>
        </div>
      </section>
    );
  }

  return (
    <FeedItemRows
      itemCount={itemCount}
      key={`feed:${streamView.path}:${snapshot.clearVersion}`}
      snapshot={snapshot}
      streamDatabase={db}
      streamView={streamView}
      streamStore={store}
    />
  );
}

function FeedItemRows({
  streamDatabase,
  itemCount,
  snapshot,
  streamView,
  streamStore,
}: {
  streamDatabase: StreamBrowserDatabase;
  itemCount: number;
  snapshot: StreamBrowserSnapshot;
  streamView: StreamViewSearch;
  streamStore: StreamBrowserStore;
}) {
  const topScrollAffordanceHeight = 48;
  const estimatedFeedRowHeight = 44; // Pending + pb-2 must measure exactly this.
  const parentRef = useRef<HTMLDivElement>(null);
  const previousItemCount = useRef(itemCount);
  const initialScrollOffset = useRef(
    itemCount > 50 ? topScrollAffordanceHeight + itemCount * estimatedFeedRowHeight : 0,
  );
  const [expandedLocalIndexes, setExpandedLocalIndexes] = useState(() => new Set<number>());
  const [newItemCount, setNewItemCount] = useState(0);
  const [scrollPosition, setScrollPosition] = useState({ isAtTop: true, isAtEnd: true });
  const virtualizer = useVirtualizer({
    count: itemCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimatedFeedRowHeight,
    getItemKey: (index) => index,
    anchorTo: "end",
    // OFF — the stick owns tail-following in DOM truth (useStickToBottom):
    // the library's follow gate reads its internal offset model, which the
    // sticky in-scroller composer's growth silently skews (content height
    // changes with no scroll event) until isAtEnd() goes false and follows
    // stop. anchorTo stays for mid-history measurement compensation.
    followOnAppend: false,
    ...(initialScrollOffset.current === 0 ? {} : { initialOffset: initialScrollOffset.current }),
    paddingStart: topScrollAffordanceHeight,
    scrollEndThreshold: 80,
    overscan: 24,
    directDomUpdates: true,
    onChange(instance) {
      const nextScrollPosition = {
        isAtTop: (instance.scrollOffset ?? 0) <= 4,
        isAtEnd: instance.isAtEnd(),
      };
      setScrollPosition((current) =>
        current.isAtTop === nextScrollPosition.isAtTop &&
        current.isAtEnd === nextScrollPosition.isAtEnd
          ? current
          : nextScrollPosition,
      );
    },
  });
  const virtualItems = virtualizer.getVirtualItems();
  // The stick observes the virtualizer's sizer AND the sticky composer
  // chrome: the composer lives INSIDE the scroller, so its growth changes
  // content height with no scroll event, and input inside it (typing,
  // clicking the textarea or the affordance buttons) is not leaving-the-tail
  // intent — hence the release exemption.
  const contentRef = useRef<HTMLDivElement | null>(null);
  const composerChromeRef = useRef<HTMLDivElement | null>(null);
  const setVirtualContainer = useCallback(
    (node: HTMLDivElement | null) => {
      virtualizer.containerRef(node);
      contentRef.current = node;
    },
    [virtualizer],
  );
  const { stuckRef, release } = useStickToBottom({
    scrollElementRef: parentRef,
    contentElementRefs: [contentRef, composerChromeRef],
    releaseExemptElementRef: composerChromeRef,
  });

  useLayoutEffect(() => {
    const appendedCount = itemCount - previousItemCount.current;
    previousItemCount.current = itemCount;
    // While stuck the reader is AT the newest item by definition — nothing is
    // unread. This also covers the initial replay: appends pouring in before
    // the viewport converges must not count as unread.
    if (stuckRef.current) {
      setNewItemCount(0);
      return;
    }
    if (appendedCount <= 0) {
      if (itemCount === 0) setNewItemCount(0);
      return;
    }
    if (!scrollPosition.isAtEnd) {
      setNewItemCount((current) => current + appendedCount);
    }
  }, [itemCount, stuckRef, scrollPosition.isAtEnd]);

  useLayoutEffect(() => {
    if (scrollPosition.isAtEnd) setNewItemCount(0);
  }, [scrollPosition.isAtEnd]);

  const showScrollToBottom = itemCount > 0 && !scrollPosition.isAtEnd;
  const showScrollToTop = itemCount > 0 && !scrollPosition.isAtTop;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {showScrollToTop ? (
        <div className="pointer-events-none absolute left-0 right-3.5 top-11 z-10 flex h-12 items-start justify-center pt-2">
          <div
            className="absolute inset-0 bg-gradient-to-b from-white via-white/80 to-transparent"
            aria-hidden
          />
          <div className="pointer-events-auto absolute left-1/2 z-20 -translate-x-1/2 top-3">
            <button
              aria-label="Scroll to top"
              className="pointer-events-auto grid size-8 cursor-pointer place-items-center rounded-full border border-[#e8ebf0] bg-white text-base leading-none text-[#16181d] opacity-60 shadow-[0_4px_12px_rgb(15_23_42_/_8%)] hover:opacity-90"
              type="button"
              onClick={() => {
                release("scroll-to-top-button");
                virtualizer.scrollToOffset(0);
              }}
            >
              ↑
            </button>
          </div>
        </div>
      ) : null}
      <section
        aria-label="Event feed"
        data-testid="event-feed"
        className="relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto bg-white pr-4 [scrollbar-color:rgb(22_24_29_/_12%)_transparent] [scrollbar-gutter:stable_both-edges] [scrollbar-width:thin]"
        ref={parentRef}
      >
        <div
          className="sticky top-0 z-3 grid min-h-11 flex-none grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 border-b border-[#eef1f5] bg-white/95 pr-4 backdrop-blur-sm"
          data-testid="feed-summary-bar"
        >
          <span className="text-xs font-semibold text-[#667085]">Event feed</span>
          <output
            className="whitespace-nowrap font-mono text-xs text-[#667085]"
            data-testid="feed-item-count"
          >
            {itemCount.toLocaleString()} feed {itemCount === 1 ? "item" : "items"}
          </output>
        </div>
        <FeedRuntimeNotice itemCount={itemCount} snapshot={snapshot} />
        {itemCount === 0 ? (
          <div className="flex min-h-60 flex-1 items-center justify-center gap-2.5 text-sm text-slate-500">
            {snapshot.connectionStatus === "receiving-events" ? null : (
              <div
                className="size-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600"
                aria-hidden="true"
              />
            )}
            <span>
              {!snapshot.connectionError
                ? snapshot.connectionStatus === "receiving-events"
                  ? "No feed items yet"
                  : `Stream connection is ${snapshot.connectionStatus}`
                : `Stream connection is ${snapshot.connectionStatus}: ${snapshot.connectionError}`}
            </span>
          </div>
        ) : (
          // directDomUpdates contract: the virtualizer owns this container's
          // height (containerRef) and each row's translate — JSX must not
          // write either. grow/shrink-0 with basis auto: the box honors the
          // virtualizer's height when content is tall (flex-1's 0% basis
          // would OVERRIDE the height style, leaving a short box whose
          // absolute rows overflow invisibly — the stick's ResizeObserver
          // watches this box, so it must be real) and still grows to fill
          // the viewport when content is short, keeping the sticky composer
          // pinned to the viewport bottom.
          <div ref={setVirtualContainer} className="relative w-full grow shrink-0">
            <FeedItemWindow
              expandedLocalIndexes={expandedLocalIndexes}
              itemCount={itemCount}
              streamDatabase={streamDatabase}
              streamView={streamView}
              virtualItems={virtualItems}
              measureElement={virtualizer.measureElement}
              onToggleLocalIndex={(localIndex) => {
                setExpandedLocalIndexes((current) => {
                  const next = new Set(current);
                  if (next.has(localIndex)) {
                    next.delete(localIndex);
                  } else {
                    next.add(localIndex);
                  }
                  return next;
                });
              }}
            />
          </div>
        )}
        <div
          ref={composerChromeRef}
          className="sticky bottom-0 z-[2] bg-white"
          data-testid="stream-composer-chrome"
        >
          {showScrollToBottom ? (
            <div
              className="pointer-events-none absolute inset-x-0 top-0 z-10 flex min-h-[72px] -translate-y-full items-end justify-center pb-2.5"
              data-testid="feed-scroll-to-bottom-affordance"
            >
              <div
                className="absolute inset-0 bg-gradient-to-t from-white via-white/80 to-transparent"
                aria-hidden
              />
              <div className="pointer-events-auto absolute left-1/2 z-20 -translate-x-1/2 bottom-4">
                <button
                  aria-label={
                    newItemCount === 0
                      ? "Scroll to bottom"
                      : `Scroll to bottom, ${newItemCount} new ${
                          newItemCount === 1 ? "item" : "items"
                        }`
                  }
                  className={
                    newItemCount === 0
                      ? "pointer-events-auto grid size-8 cursor-pointer place-items-center rounded-full border border-[#e8ebf0] bg-white text-base leading-none text-[#16181d] opacity-60 shadow-[0_4px_12px_rgb(15_23_42_/_8%)] hover:opacity-90"
                      : "pointer-events-auto inline-grid h-8 auto-cols-max grid-flow-col place-items-center gap-1.5 rounded-full border border-[#e8ebf0] bg-white px-2.5 text-[13px] text-[#16181d] opacity-60 shadow-[0_4px_12px_rgb(15_23_42_/_8%)] hover:opacity-90"
                  }
                  type="button"
                  onClick={() => {
                    setNewItemCount(0);
                    // Direct DOM write: lands at the exact bottom, and the
                    // scroll event it fires re-engages the stick (≤2px).
                    const scroller = parentRef.current;
                    if (scroller) scroller.scrollTop = scroller.scrollHeight;
                  }}
                >
                  <span className="text-base leading-none">↓</span>
                  {newItemCount === 0 ? null : (
                    <span className="font-mono text-xs leading-none">{newItemCount}</span>
                  )}
                </button>
              </div>
            </div>
          ) : null}
          <FeedComposer key={`composer:${streamView.path}`} streamStore={streamStore} />
        </div>
      </section>
    </div>
  );
}

function FeedRuntimeNotice({
  itemCount,
  snapshot,
}: {
  itemCount: number;
  snapshot: StreamBrowserSnapshot;
}) {
  if (snapshot.connectionError) {
    return (
      <div
        className="grid gap-[3px] border-b border-[#fecdca] bg-[#fff4f2] py-[9px] pr-4 text-xs text-[#912018]"
        data-testid="stream-error"
        role="alert"
      >
        <strong>Stream error</strong>
        <span>{snapshot.connectionError}</span>
      </div>
    );
  }

  if (itemCount === 0 && snapshot.databaseRole === "reader") {
    return (
      <output
        className="grid gap-[3px] border-b border-[#fedf89] bg-[#fff8e6] py-[9px] pr-4 text-xs text-[#7a4b00]"
        data-testid="stream-warning"
      >
        <strong>Reader with empty local feed copy</strong>
        <span>
          This tab is waiting for the elected writer tab to store feed items in local SQLite. Reload
          or close older tabs if this does not resolve.
        </span>
      </output>
    );
  }

  return null;
}

function FeedItemWindow({
  streamDatabase,
  streamView,
  virtualItems,
  expandedLocalIndexes,
  itemCount,
  measureElement,
  onToggleLocalIndex,
}: {
  streamDatabase: StreamBrowserDatabase;
  streamView: StreamViewSearch;
  virtualItems: VirtualItem[];
  expandedLocalIndexes: Set<number>;
  itemCount: number;
  measureElement: (node: Element | null) => void;
  onToggleLocalIndex(localIndex: number): void;
}) {
  const firstIndex = virtualItems[0]?.index ?? 0;
  const lastIndex = virtualItems.at(-1)?.index ?? -1;
  const rowQueryResult = useStreamQuery(
    streamDatabase,
    `SELECT local_index, kind, first_offset, last_offset, event_count, json(data) AS data
     FROM feed_items
     WHERE local_index >= ? AND local_index < ?
     ORDER BY local_index ASC`,
    [firstIndex, lastIndex + 1],
  );
  const rowsByLocalIndex = useMemo(() => {
    const rows = new Map<number, FeedItemRow>();
    for (const row of rowQueryResult.data) {
      const parsed = parseFeedItem(row);
      if (parsed) rows.set(parsed.local_index, parsed);
    }
    return rows;
  }, [rowQueryResult.data]);

  return virtualItems.map((virtualItem) => {
    const row = rowsByLocalIndex.get(virtualItem.index);
    const isExpanded = !!row && expandedLocalIndexes.has(row.local_index);
    const isLastFeedRow = virtualItem.index === itemCount - 1;

    return (
      <div
        className={
          isLastFeedRow
            ? "absolute left-0 top-0 w-full pb-2"
            : "absolute left-0 top-0 w-full pb-2 after:absolute after:bottom-1 after:left-0 after:right-0 after:h-px after:bg-[#eef1f5]"
        }
        data-index={virtualItem.index}
        data-testid="virtual-row"
        key={virtualItem.key}
        // Unconditional: directDomUpdates positions rows through the
        // measurement cache, so unmeasured pending rows would never be placed.
        ref={measureElement}
      >
        {!row ? (
          <article
            className="box-border h-9 rounded-md border border-[#e1e5eb]"
            data-testid="feed-item-pending"
          />
        ) : (
          <FeedItem
            expanded={isExpanded}
            isLast={isLastFeedRow}
            row={row}
            streamView={streamView}
            onToggle={() => onToggleLocalIndex(row.local_index)}
          />
        )}
      </div>
    );
  });
}

function FeedItem({
  row,
  isLast,
  expanded,
  streamView,
  onToggle,
}: {
  row: FeedItemRow;
  isLast: boolean;
  expanded: boolean;
  streamView: StreamViewSearch;
  onToggle(): void;
}) {
  const eventType = feedItemEventType(row);
  const articleClass = isLast
    ? "min-w-0 overflow-hidden bg-white"
    : "relative min-w-0 overflow-hidden bg-white";

  if (row.kind === "raw.stream.created") {
    return (
      <StreamLifecycleMarker
        className={articleClass}
        expanded={expanded}
        kind="created"
        offset={row.first_offset}
        row={row}
        onToggle={onToggle}
      />
    );
  }

  if (row.kind === "raw.stream.woken") {
    return (
      <StreamLifecycleMarker
        className={articleClass}
        expanded={expanded}
        kind="woken"
        offset={row.first_offset}
        row={row}
        onToggle={onToggle}
      />
    );
  }

  if (row.kind === "raw.stream.child-stream-created") {
    return (
      <ChildStreamCreatedFeedItem
        className={articleClass}
        streamView={streamView}
        eventType={eventType}
        expanded={expanded}
        row={row}
        onToggle={onToggle}
      />
    );
  }

  const offsetLabel =
    row.event_count === 1 ? String(row.first_offset) : `${row.first_offset}–${row.last_offset}`;
  const detailLabel =
    row.event_count === 1 ? "1 event" : `${row.event_count.toLocaleString()} events`;

  return (
    <article
      data-testid="feed-item"
      data-kind={row.kind}
      data-event-type={eventType}
      data-first-offset={row.first_offset}
      data-last-offset={row.last_offset}
      data-event-count={row.event_count}
      className={articleClass}
    >
      <button
        aria-expanded={expanded}
        className="grid w-full cursor-pointer grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-3 border-0 bg-transparent px-2.5 py-2 text-left font-mono text-xs text-[#536073] hover:bg-[#f8fafc]"
        data-testid="feed-item-meta"
        type="button"
        onClick={onToggle}
      >
        <span>{offsetLabel}</span>
        <span className="truncate">{eventType}</span>
        <span className="whitespace-nowrap text-[#667085]">{detailLabel}</span>
      </button>
      {expanded ? <FeedItemJson row={row} /> : null}
    </article>
  );
}

function StreamLifecycleMarker({
  className,
  expanded,
  kind,
  offset,
  row,
  onToggle,
}: {
  className: string;
  expanded: boolean;
  kind: "created" | "woken";
  offset: number;
  row: FeedItemRow;
  onToggle(): void;
}) {
  const label = kind === "created" ? "Durable object created" : "Durable object woke up";

  return (
    <article
      className={className}
      data-testid="feed-item"
      data-kind={row.kind}
      data-event-type={feedItemEventType(row)}
      data-first-offset={row.first_offset}
      data-last-offset={row.last_offset}
      data-event-count={row.event_count}
    >
      <button
        aria-expanded={expanded}
        aria-label={`${label}, offset ${offset}`}
        className="group relative flex w-full cursor-pointer items-center px-3 py-3"
        data-testid="feed-lifecycle-marker"
        data-kind={kind}
        type="button"
        onClick={onToggle}
      >
        <span
          aria-hidden
          className="absolute inset-x-3 top-1/2 h-px -translate-y-1/2 bg-violet-200"
        />
        <span className="relative mx-auto bg-white px-3 text-[11px] font-medium tracking-wide text-violet-700">
          {label}
          <span className="ml-2 font-mono font-normal text-violet-500/80">#{offset}</span>
        </span>
      </button>
      {expanded ? <FeedItemJson row={row} /> : null}
    </article>
  );
}

function ChildStreamCreatedFeedItem({
  className,
  streamView,
  eventType,
  expanded,
  row,
  onToggle,
}: {
  className: string;
  streamView: StreamViewSearch;
  eventType: string;
  expanded: boolean;
  row: FeedItemRow;
  onToggle(): void;
}) {
  const childPath = childStreamPathFromRow(row);
  const childSearch = !childPath
    ? undefined
    : streamViewSearch({
        path: childPath,
        projectId: streamView.projectId,
        view: "browser-feed",
      });

  return (
    <article
      className={className}
      data-testid="feed-item"
      data-kind={row.kind}
      data-event-type={eventType}
      data-first-offset={row.first_offset}
      data-last-offset={row.last_offset}
      data-event-count={row.event_count}
    >
      <div className="px-2.5 py-2">
        <div className="flex items-start gap-2.5 rounded-lg border border-violet-100 bg-violet-50/60 px-3 py-2.5">
          <span aria-hidden className="mt-0.5 text-sm leading-none text-violet-600">
            ⎇
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-violet-950">Child stream created</p>
            {!childPath ? (
              <p className="mt-1 font-mono text-[11px] text-violet-700/80">
                missing childPath in payload
              </p>
            ) : (
              <p className="mt-1 text-[11px] text-violet-800/90">
                Under <span className="font-mono text-violet-900">{streamView.path}</span>
              </p>
            )}
            {!childSearch ? null : (
              <Link
                className="mt-2 inline-flex items-center gap-1 font-mono text-xs text-violet-700 underline decoration-violet-300 underline-offset-2 hover:text-violet-900"
                data-testid="feed-child-stream-link"
                search={childSearch}
                to="/streams"
              >
                Open {childPath}
                <span aria-hidden>→</span>
              </Link>
            )}
          </div>
          <button
            aria-expanded={expanded}
            aria-label="Toggle child stream event JSON"
            className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-violet-600/80 hover:bg-violet-100/80"
            data-testid="feed-item-meta"
            type="button"
            onClick={onToggle}
          >
            json
          </button>
        </div>
      </div>
      {expanded ? <FeedItemJson row={row} /> : null}
    </article>
  );
}

function FeedItemJson({ row }: { row: FeedItemRow }) {
  return (
    <pre
      className="m-0 overflow-auto whitespace-pre-wrap break-words p-2.5 font-mono text-[13px] leading-normal"
      data-testid="feed-item-json"
    >
      {JSON.stringify(feedItemExpandedJson(row), null, 2)}
    </pre>
  );
}

function childStreamPathFromRow(row: FeedItemRow): string | undefined {
  const event = feedItemEvents(row)[0];
  if (!event) return undefined;
  const payload = event.payload;
  if (!payload || typeof payload !== "object") return undefined;
  const childPath = (payload as Record<string, unknown>).childPath;
  return typeof childPath === "string" && childPath.length > 0 ? childPath : undefined;
}

function feedItemEventType(row: FeedItemRow) {
  if (typeof row.data.eventType === "string") return row.data.eventType;
  const first = feedItemEvents(row)[0];
  if (first && typeof first.type === "string") return first.type;
  return SPECIFIC_RENDERER_TYPES[row.kind] ?? row.kind;
}

function feedItemEvents(row: FeedItemRow): Record<string, unknown>[] {
  if (!Array.isArray(row.data.events)) return [];
  return row.data.events.flatMap((entry) =>
    entry && typeof entry === "object" ? [entry as Record<string, unknown>] : [],
  );
}

function feedItemExpandedJson(row: FeedItemRow) {
  const events = feedItemEvents(row);
  return events.length === 0 ? row.data : events;
}

function parseFeedItem(row: Record<string, unknown>): FeedItemRow | undefined {
  if (
    typeof row.local_index !== "number" ||
    typeof row.kind !== "string" ||
    typeof row.first_offset !== "number" ||
    typeof row.last_offset !== "number" ||
    typeof row.event_count !== "number"
  ) {
    return undefined;
  }
  let data: Record<string, unknown> = {};
  if (typeof row.data === "string") {
    try {
      const parsed: unknown = JSON.parse(row.data);
      if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
    } catch {
      data = {};
    }
  }
  return {
    local_index: row.local_index,
    kind: row.kind,
    first_offset: row.first_offset,
    last_offset: row.last_offset,
    event_count: row.event_count,
    data,
  };
}

function FeedComposer({ streamStore }: { streamStore: StreamBrowserStore }) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [composerText, setComposerText] = useState(() =>
    JSON.stringify(
      {
        type: "events.iterate.com/debug/manual-event",
        payload: {
          message: "hello from the browser composer",
        },
      },
      null,
      2,
    ),
  );
  const [appendState, setAppendState] = useState<"idle" | "appending" | "done" | "error">("idle");

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [composerText]);

  async function appendComposerEvent() {
    setAppendState("appending");

    try {
      await streamStore.appendBatch({
        events: [JSON.parse(composerText)],
      });
      setAppendState("done");
    } catch {
      setAppendState("error");
    }
  }

  return (
    <section
      className="relative bg-white py-4"
      aria-label="Append event"
      data-testid="stream-composer"
    >
      <div className="relative">
        <textarea
          aria-label="Event JSON"
          className="block min-h-[104px] w-full resize-y box-border rounded-md border border-[#bac2cf] px-2.5 pb-[38px] pt-2.5 font-mono text-[13px] leading-[1.5]"
          data-testid="composer-textarea"
          ref={textareaRef}
          spellCheck={false}
          value={composerText}
          onChange={(event) => {
            setAppendState("idle");
            setComposerText(event.currentTarget.value);
          }}
        />
        {appendState === "idle" ? null : (
          <output
            aria-live="polite"
            className={
              appendState === "error"
                ? "pointer-events-none absolute bottom-[13px] left-3 font-mono text-[11px] uppercase text-[#b42318]"
                : "pointer-events-none absolute bottom-[13px] left-3 font-mono text-[11px] uppercase text-[#667085]"
            }
            data-testid="composer-state"
          >
            {appendState === "appending"
              ? "appending"
              : appendState === "done"
                ? "appended"
                : "error"}
          </output>
        )}
        <button
          aria-label={
            appendState === "error" ? "Append failed; retry append event" : "Append event"
          }
          className={
            appendState === "error"
              ? "absolute bottom-1.5 right-1.5 inline-flex size-7 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-[#b42318] hover:bg-[#f2f4f7] disabled:cursor-default disabled:opacity-60"
              : appendState === "done"
                ? "absolute bottom-1.5 right-1.5 inline-flex size-7 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-[#067647] hover:bg-[#f2f4f7] disabled:cursor-default disabled:opacity-60"
                : "absolute bottom-1.5 right-1.5 inline-flex size-7 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-[#98a2b3] hover:bg-[#f2f4f7] hover:text-[#536073] disabled:cursor-default disabled:opacity-60"
          }
          disabled={appendState === "appending"}
          type="button"
          onClick={() => void appendComposerEvent()}
        >
          ↗
        </button>
      </div>
    </section>
  );
}

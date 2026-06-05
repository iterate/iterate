import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ClientOnly, useNavigate } from "@tanstack/react-router";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import {
  acquireStreamRuntime,
  type BrowserProcessorConfig,
  type StreamBrowserSnapshot,
  type StreamBrowserStore,
  type StreamRuntimeState,
} from "../../../src/browser/stream-browser-store.ts";
import {
  DEFAULT_CIRCUIT_BREAKER_BURST_CAPACITY,
  DEFAULT_CIRCUIT_BREAKER_REFILL_RATE_PER_MINUTE,
} from "../../../src/processors/circuit-breaker/contract.ts";
import {
  type StreamBrowserDatabase,
  type StreamEventRow,
} from "../../../src/browser/stream-browser-db.ts";
import {
  BROWSER_RAW_EVENTS_SCHEMA_VERSION,
  browserRawEvents,
  loadBrowserRawEventsCheckpoint,
} from "../../../src/processors/browser-raw-events/implementation.ts";
import { useStreamQuery } from "../../../src/browser/hooks/use-stream-query.ts";
import { EventFeedView } from "./-event-feed-view.tsx";
import { StreamStateView } from "./-stream-state-view.tsx";
import { ViewSwitcher } from "./-view-switcher.tsx";

export function StreamPage({ streamPath, viewSlug }: { streamPath: string; viewSlug: string }) {
  return (
    <ClientOnly fallback={<StreamHydrationFallback streamPath={streamPath} />}>
      <HydratedStreamPage streamPath={streamPath} viewSlug={viewSlug} />
    </ClientOnly>
  );
}

// One hydration boundary, then exactly one of the three sibling views, chosen by `?view=`
// (the value is the view's slug). All three share the same sidebar shell.
function HydratedStreamPage({ streamPath, viewSlug }: { streamPath: string; viewSlug: string }) {
  const sidebarRuntime = useRawEventsView(streamPath, "");

  return (
    <StreamViewShell currentView={viewSlug} sidebarRuntime={sidebarRuntime} streamPath={streamPath}>
      {viewSlug === "browser-event-feed" ? (
        <EventFeedView streamPath={streamPath} />
      ) : viewSlug === "browser-state" ? (
        <StreamStateView streamPath={streamPath} />
      ) : (
        <RawEventsMain streamPath={streamPath} />
      )}
    </StreamViewShell>
  );
}

export function StreamCompactView({ streamPath }: { streamPath: string }) {
  return (
    <ClientOnly fallback={<StreamHydrationFallback streamPath={streamPath} />}>
      <HydratedStreamCompactView streamPath={streamPath} />
    </ClientOnly>
  );
}

// The raw-events sibling view: type filter + virtualized raw event list + composer.
function RawEventsMain({ streamPath }: { streamPath: string }) {
  const [eventTypeFilter, setEventTypeFilter] = useState("");
  const runtime = useRawEventsView(streamPath, eventTypeFilter);

  if (runtime.countResult.status !== "ok") {
    return (
      <StreamLoadingPanel
        message={
          runtime.countResult.status === "error"
            ? `client hydrated, sqlite DB error at ${runtime.streamDatabase.databasePath}: ${runtime.countResult.error?.message ?? "unknown error"}`
            : `client hydrated, opening sqlite DB at ${runtime.streamDatabase.databasePath}`
        }
      />
    );
  }

  return (
    <EventRows
      eventCount={runtime.eventCount}
      eventTypeFilter={eventTypeFilter}
      eventTypes={runtime.eventTypes}
      key={`events:${streamPath}:${runtime.snapshot.clearVersion}:${eventTypeFilter}`}
      snapshot={runtime.snapshot}
      streamDatabase={runtime.streamDatabase}
      streamPath={streamPath}
      streamStore={runtime.streamStore}
      totalEventCount={runtime.totalEventCount}
      onEventTypeFilterChange={setEventTypeFilter}
    />
  );
}

function HydratedStreamCompactView({ streamPath }: { streamPath: string }) {
  const [eventTypeFilter, setEventTypeFilter] = useState("");
  const runtime = useRawEventsView(streamPath, eventTypeFilter);

  return (
    <section
      className="flex min-h-0 flex-col border-r border-slate-200 last:border-r-0"
      aria-label={`Stream ${streamPath}`}
      data-stream-path={streamPath}
    >
      <div className="grid min-h-9 grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-2 border-b border-slate-100 px-3 py-1.5">
        <span className="min-w-0 truncate font-mono text-xs leading-snug text-slate-950">
          {streamPath}
        </span>
        <output className="font-mono text-xs text-slate-500" data-testid="stream-status">
          {runtime.snapshot.connectionStatus}
        </output>
        <output className="font-mono text-xs text-slate-500" data-testid="subscription-status">
          {runtime.snapshot.subscriptionStatus}
        </output>
        <output className="font-mono text-xs text-slate-500" data-testid="event-count">
          {runtime.eventCount}
        </output>
      </div>
      {runtime.countResult.status !== "ok" ? (
        <StreamLoadingPanel
          message={
            runtime.countResult.status === "error"
              ? `sqlite DB error at ${runtime.streamDatabase.databasePath}: ${runtime.countResult.error?.message ?? "unknown error"}`
              : `opening sqlite DB at ${runtime.streamDatabase.databasePath}`
          }
        />
      ) : (
        <EventRows
          eventCount={runtime.eventCount}
          eventTypeFilter={eventTypeFilter}
          eventTypes={runtime.eventTypes}
          key={`events:${streamPath}:${runtime.snapshot.clearVersion}:${eventTypeFilter}`}
          snapshot={runtime.snapshot}
          streamDatabase={runtime.streamDatabase}
          streamPath={streamPath}
          streamStore={runtime.streamStore}
          totalEventCount={runtime.totalEventCount}
          onEventTypeFilterChange={setEventTypeFilter}
        />
      )}
    </section>
  );
}

// The browser's thin layer over a processor: acquire the shared (path, processor) runtime
// — which, once it wins leadership, runs the processor over a subscription exactly like the
// StreamProcessorRunner DO — and subscribe to its snapshot for React. Nothing view-specific.
function useStreamProcessor(streamPath: string, config: BrowserProcessorConfig) {
  const store = useMemo(
    () => acquireStreamRuntime({ streamPath, ...config }),
    [streamPath, config],
  );
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
  return { store, snapshot, db: store.streamDatabase };
}

// Stable raw-events config (a constant so useStreamProcessor's useMemo identity is stable).
const RAW_EVENTS_RUNTIME: BrowserProcessorConfig = {
  processor: browserRawEvents,
  schemaVersion: BROWSER_RAW_EVENTS_SCHEMA_VERSION,
  tables: ["events"],
  loadCheckpoint: loadBrowserRawEventsCheckpoint,
};

// The raw-events view's data: the thin runtime + this view's own reactive SQL queries.
function useRawEventsView(streamPath: string, eventTypeFilter: string) {
  const { store, snapshot, db } = useStreamProcessor(streamPath, RAW_EVENTS_RUNTIME);
  const totalCountResult = useStreamQuery(db, `SELECT COUNT(*) AS count FROM events`);
  const countResult = useStreamQuery(
    db,
    eventTypeFilter === ""
      ? `SELECT COUNT(*) AS count FROM events`
      : `SELECT COUNT(*) AS count FROM events WHERE type = ?`,
    eventTypeFilter === "" ? [] : [eventTypeFilter],
  );
  const eventTypesResult = useStreamQuery(
    db,
    `SELECT type, COUNT(*) AS count FROM events GROUP BY type ORDER BY type ASC`,
  );
  const eventCount = Number(countResult.data[0]?.count ?? 0);
  const totalEventCount = Number(totalCountResult.data[0]?.count ?? 0);
  const eventTypes = eventTypesResult.data.flatMap((row) => {
    if (typeof row.type !== "string" || typeof row.count !== "number") return [];
    return [{ count: row.count, type: row.type }];
  });
  return {
    countResult,
    eventCount,
    eventTypes,
    snapshot,
    streamDatabase: db,
    streamStore: store,
    totalEventCount,
  };
}

function StreamHydrationFallback({ streamPath }: { streamPath: string }) {
  return (
    <div className="min-h-full bg-white font-sans text-slate-950">
      <div className="flex min-h-60 items-center justify-center gap-2.5 text-sm text-slate-500">
        <div
          className="size-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600"
          aria-hidden="true"
        />
        <span>SSR done, hydrating client for {streamPath}</span>
      </div>
    </div>
  );
}

function StreamViewShell({
  streamPath,
  currentView,
  sidebarRuntime,
  children,
}: {
  streamPath: string;
  currentView: string;
  sidebarRuntime: ReturnType<typeof useRawEventsView>;
  children: ReactNode;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(
    () => globalThis.matchMedia("(min-width: 761px)").matches,
  );

  return (
    <main className="block h-dvh overflow-hidden bg-white font-sans text-[#16181d]">
      <div className="flex h-full min-h-0 flex-row gap-4 p-0 max-[760px]:flex-col max-[760px]:gap-0">
        <StreamSidebar
          className={sidebarOpen ? undefined : "hidden"}
          currentView={currentView}
          eventCount={sidebarRuntime.totalEventCount}
          key={`sidebar:${streamPath}`}
          snapshot={sidebarRuntime.snapshot}
          streamDatabase={sidebarRuntime.streamDatabase}
          streamStore={sidebarRuntime.streamStore}
          streamPath={streamPath}
          onSidebarOpenChange={setSidebarOpen}
        />
        <div
          className={
            sidebarOpen
              ? "relative flex min-h-0 min-w-0 flex-1 flex-col"
              : "relative flex min-h-0 min-w-0 flex-1 flex-col pl-4"
          }
        >
          {sidebarOpen ? null : (
            <button
              aria-controls="stream-sidebar"
              aria-label="Show sidebar"
              className="absolute left-4 top-4 z-20 inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-[#667085] hover:bg-[#f8fafc] hover:text-[#344054]"
              title="Show sidebar"
              type="button"
              onClick={() => setSidebarOpen(true)}
            >
              <SidebarIcon />
            </button>
          )}
          {children}
        </div>
      </div>
    </main>
  );
}

function StreamLoadingPanel({ message }: { message: string }) {
  return (
    <section
      aria-label="Stream events"
      className="relative grid min-h-0 flex-1 place-items-center overflow-y-auto bg-white"
    >
      <div className="flex min-h-60 items-center justify-center gap-2.5 text-sm text-slate-500">
        <div
          className="size-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600"
          aria-hidden="true"
        />
        <span>{message}</span>
      </div>
    </section>
  );
}

function EditStreamIcon() {
  return (
    <svg
      aria-hidden
      className="size-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function SidebarIcon() {
  return (
    <svg
      aria-hidden
      className="size-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect height="18" rx="2" width="18" x="3" y="3" />
      <path d="M9 3v18" />
    </svg>
  );
}

function AppendEventIcon() {
  return (
    <svg
      aria-hidden
      className="size-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 2 11 13" />
      <path d="m22 2-7 20-4-9-9-4Z" />
    </svg>
  );
}

function StreamTopBar({
  streamPath,
  onSidebarOpenChange,
}: {
  streamPath: string;
  onSidebarOpenChange(open: boolean): void;
}) {
  const navigate = useNavigate();
  const pathInputRef = useRef<HTMLInputElement>(null);
  const [editingPath, setEditingPath] = useState(false);
  const [editedPath, setEditedPath] = useState(streamPath);
  const trimmedDraftPath = editedPath.trim();
  const normalizedDraftPath =
    trimmedDraftPath === ""
      ? "/"
      : trimmedDraftPath.startsWith("/")
        ? trimmedDraftPath
        : `/${trimmedDraftPath}`;
  const pathChanged = normalizedDraftPath !== streamPath;

  useLayoutEffect(() => {
    if (!editingPath) return;
    pathInputRef.current?.focus();
    pathInputRef.current?.select();
  }, [editingPath]);

  function goToDraftPath() {
    if (!pathChanged) {
      setEditingPath(false);
      setEditedPath(streamPath);
      return;
    }
    setEditingPath(false);
    if (normalizedDraftPath === "/") {
      void navigate({ to: "/streams", search: { view: "browser-raw-events" } });
      return;
    }
    void navigate({
      to: "/streams/$",
      params: { _splat: normalizedDraftPath.slice(1) },
      search: { view: "browser-raw-events" },
    });
  }

  function startEditingPath() {
    setEditedPath(streamPath);
    setEditingPath(true);
  }

  function cancelEditingPath() {
    setEditedPath(streamPath);
    setEditingPath(false);
  }

  return (
    <header className="mb-4 grid items-start gap-3 border-b border-[#e8ebf0] bg-white pb-4">
      <button
        aria-controls="stream-sidebar"
        aria-label="Hide sidebar"
        className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-[#667085] hover:bg-[#f8fafc] hover:text-[#344054]"
        title="Hide sidebar"
        type="button"
        onClick={() => onSidebarOpenChange(false)}
      >
        <SidebarIcon />
      </button>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 w-full">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {editingPath ? (
            <>
              <input
                aria-label="Stream path"
                className="min-w-0 flex-1 rounded border border-[#bac2cf] px-1.5 py-1 font-mono text-xs leading-snug"
                id="stream-path"
                ref={pathInputRef}
                value={editedPath}
                onChange={(event) => setEditedPath(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    cancelEditingPath();
                    return;
                  }
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  goToDraftPath();
                }}
              />
            </>
          ) : (
            <button
              className="min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-left font-mono text-xs leading-snug text-[#16181d]"
              title="Edit stream path"
              type="button"
              onClick={() => startEditingPath()}
            >
              {streamPath}
            </button>
          )}
        </div>
        {editingPath ? (
          <div className="flex shrink-0 items-center gap-2">
            <button
              className="cursor-pointer border-0 bg-transparent px-0 py-1 text-[11px] font-semibold text-[#667085] disabled:cursor-default disabled:opacity-40"
              disabled={!pathChanged}
              type="button"
              onClick={() => goToDraftPath()}
            >
              Go to stream
            </button>
            <button
              className="cursor-pointer border-0 bg-transparent px-0 py-1 text-[11px] text-[#98a2b3] hover:text-[#475467] hover:underline"
              type="button"
              onClick={() => cancelEditingPath()}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            aria-label="Edit stream path"
            className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-[#667085] hover:bg-[#f8fafc] hover:text-[#344054]"
            title="Edit stream path"
            type="button"
            onClick={() => startEditingPath()}
          >
            <EditStreamIcon />
          </button>
        )}
      </div>
    </header>
  );
}

function EventRows({
  streamDatabase,
  eventCount,
  eventTypeFilter,
  eventTypes,
  totalEventCount,
  snapshot,
  streamPath,
  streamStore,
  onEventTypeFilterChange,
}: {
  streamDatabase: StreamBrowserDatabase;
  eventCount: number;
  eventTypeFilter: string;
  eventTypes: { count: number; type: string }[];
  totalEventCount: number;
  snapshot: StreamBrowserSnapshot;
  streamPath: string;
  streamStore: StreamBrowserStore;
  onEventTypeFilterChange(eventType: string): void;
}) {
  const topScrollAffordanceHeight = 48;
  const estimatedEventRowHeight = 38;
  const parentRef = useRef<HTMLDivElement>(null);
  const previousEventCount = useRef(eventCount);
  const settledInitialEndScroll = useRef(false);
  const initialScrollOffset = useRef(
    eventCount > 50 ? topScrollAffordanceHeight + eventCount * estimatedEventRowHeight : 0,
  );
  const [expandedOffsets, setExpandedOffsets] = useState(() => new Set<number>());
  const [newEventCount, setNewEventCount] = useState(0);
  const [scrollPosition, setScrollPosition] = useState({ isAtTop: true, isAtEnd: true });
  const virtualizer = useVirtualizer({
    count: eventCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimatedEventRowHeight,
    // This stream is append-only, so the virtual index is a stable item key.
    // If this grows older-history prepends later, switch this to a persisted row id.
    getItemKey: (index) => index,
    anchorTo: "end",
    followOnAppend: true,
    // TanStack's chat docs recommend `initialOffset` for restored screens.
    // `EventRows` mounts after the SQLite count query is ready, so a reload of
    // an already-populated local mirror is a restored screen: start near the
    // estimated end. For fresh/tiny streams omit the option entirely so live
    // append behavior stays on TanStack's normal `followOnAppend` path.
    ...(initialScrollOffset.current === 0 ? {} : { initialOffset: initialScrollOffset.current }),
    paddingStart: topScrollAffordanceHeight,
    scrollEndThreshold: 80,
    overscan: 24,
    // The official React chat example uses direct DOM updates. Without this,
    // a tiny/non-scrollable list that receives a huge same-render append can
    // scroll to the previous max offset and stop following the end.
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

  useLayoutEffect(() => {
    if (settledInitialEndScroll.current || eventCount === 0) return;
    settledInitialEndScroll.current = true;
    virtualizer.scrollToEnd();
  }, [eventCount, virtualizer]);

  useLayoutEffect(() => {
    const appendedCount = eventCount - previousEventCount.current;
    previousEventCount.current = eventCount;
    if (appendedCount <= 0) {
      if (eventCount === 0) setNewEventCount(0);
      return;
    }
    if (!scrollPosition.isAtEnd) {
      setNewEventCount((current) => current + appendedCount);
    }
  }, [eventCount, scrollPosition.isAtEnd]);

  useLayoutEffect(() => {
    if (scrollPosition.isAtEnd) setNewEventCount(0);
  }, [scrollPosition.isAtEnd]);

  const showScrollToBottom = eventCount > 0 && !scrollPosition.isAtEnd;
  const showScrollToTop = eventCount > 0 && !scrollPosition.isAtTop;

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
                virtualizer.scrollToOffset(0);
              }}
            >
              ↑
            </button>
          </div>
        </div>
      ) : null}
      <section
        aria-label="Stream events"
        data-testid="stream-events"
        className="relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto bg-white pr-4 [scrollbar-color:rgb(22_24_29_/_12%)_transparent] [scrollbar-gutter:stable_both-edges] [scrollbar-width:thin]"
        ref={parentRef}
      >
        <EventTypeFilterBar
          eventCount={eventCount}
          eventTypeFilter={eventTypeFilter}
          eventTypes={eventTypes}
          totalEventCount={totalEventCount}
          onEventTypeFilterChange={onEventTypeFilterChange}
        />
        <StreamRuntimeNotice eventCount={eventCount} snapshot={snapshot} />
        {eventCount === 0 ? (
          <div className="flex min-h-60 flex-1 items-center justify-center gap-2.5 text-sm text-slate-500">
            {snapshot.connectionStatus === "subscribed" ? null : (
              <div
                className="size-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600"
                aria-hidden="true"
              />
            )}
            <span>
              {eventTypeFilter !== ""
                ? "SQLite is ready; no events match the selected event type"
                : snapshot.connectionError === undefined
                  ? snapshot.connectionStatus === "subscribed"
                    ? "SQLite is ready; no events are stored locally yet"
                    : `SQLite is ready; stream connection is ${snapshot.connectionStatus}`
                  : `SQLite is ready; stream connection is ${snapshot.connectionStatus}: ${snapshot.connectionError}`}
            </span>
          </div>
        ) : (
          <>
            <div
              className="relative w-full flex-1"
              style={{ minHeight: virtualizer.getTotalSize() }}
            >
              <EventRowWindow
                eventCount={eventCount}
                eventTypeFilter={eventTypeFilter}
                expandedOffsets={expandedOffsets}
                streamDatabase={streamDatabase}
                virtualItems={virtualItems}
                measureElement={virtualizer.measureElement}
                onToggleOffset={(offset) => {
                  setExpandedOffsets((current) => {
                    const next = new Set(current);
                    if (next.has(offset)) {
                      next.delete(offset);
                    } else {
                      next.add(offset);
                    }
                    return next;
                  });
                }}
              />
            </div>
          </>
        )}
        <div className="sticky bottom-0 z-[2] bg-white" data-testid="stream-composer-chrome">
          {showScrollToBottom ? (
            <div
              className="pointer-events-none absolute inset-x-0 top-0 z-10 flex min-h-[72px] -translate-y-full items-end justify-center pb-2.5"
              data-testid="stream-scroll-to-bottom-affordance"
            >
              <div
                className="absolute inset-0 bg-gradient-to-t from-white via-white/80 to-transparent"
                aria-hidden
              />
              <div className="pointer-events-auto absolute left-1/2 z-20 -translate-x-1/2 bottom-4">
                <button
                  aria-label={
                    newEventCount === 0
                      ? "Scroll to bottom"
                      : `Scroll to bottom, ${newEventCount} new ${
                          newEventCount === 1 ? "event" : "events"
                        }`
                  }
                  className={
                    newEventCount === 0
                      ? "pointer-events-auto grid size-8 cursor-pointer place-items-center rounded-full border border-[#e8ebf0] bg-white text-base leading-none text-[#16181d] opacity-60 shadow-[0_4px_12px_rgb(15_23_42_/_8%)] hover:opacity-90"
                      : "pointer-events-auto inline-grid h-8 auto-cols-max grid-flow-col place-items-center gap-1.5 rounded-full border border-[#e8ebf0] bg-white px-2.5 text-[13px] text-[#16181d] opacity-60 shadow-[0_4px_12px_rgb(15_23_42_/_8%)] hover:opacity-90"
                  }
                  type="button"
                  onClick={() => {
                    setNewEventCount(0);
                    virtualizer.scrollToEnd();
                  }}
                >
                  <span className="text-base leading-none">↓</span>
                  {newEventCount === 0 ? null : (
                    <span className="font-mono text-xs leading-none">{newEventCount}</span>
                  )}
                </button>
              </div>
            </div>
          ) : null}
          <StreamComposer key={`composer:${streamPath}`} streamStore={streamStore} />
        </div>
      </section>
    </div>
  );
}

function EventTypeFilterBar({
  eventCount,
  eventTypeFilter,
  eventTypes,
  totalEventCount,
  onEventTypeFilterChange,
}: {
  eventCount: number;
  eventTypeFilter: string;
  eventTypes: { count: number; type: string }[];
  totalEventCount: number;
  onEventTypeFilterChange(eventType: string): void;
}) {
  const totalLabel = `${totalEventCount.toLocaleString()} total ${
    totalEventCount === 1 ? "event" : "events"
  }`;
  const filteredLabel = `${eventCount.toLocaleString()} filtered ${
    eventCount === 1 ? "event" : "events"
  }`;

  return (
    <div
      className="sticky top-0 z-3 grid min-h-11 flex-none grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 border-b border-[#eef1f5] bg-white/95 pr-4 backdrop-blur-sm"
      data-testid="event-type-filter-bar"
    >
      <label className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 text-xs font-semibold text-[#667085]">
        <span>Event type</span>
        <select
          aria-label="Event type filter"
          className="min-w-0 rounded-md border border-[#bac2cf] bg-white px-2 py-1.5 font-mono text-xs"
          value={eventTypeFilter}
          onChange={(event) => onEventTypeFilterChange(event.currentTarget.value)}
        >
          <option value="">All event types</option>
          {eventTypes.map((eventType) => (
            <option key={eventType.type} value={eventType.type}>
              {eventType.type} ({eventType.count})
            </option>
          ))}
        </select>
      </label>
      <output
        className="whitespace-nowrap font-mono text-xs text-[#667085]"
        data-testid="filter-count"
      >
        {eventTypeFilter === "" ? totalLabel : `${filteredLabel} / ${totalLabel}`}
      </output>
    </div>
  );
}

function StreamRuntimeNotice({
  eventCount,
  snapshot,
}: {
  eventCount: number;
  snapshot: StreamBrowserSnapshot;
}) {
  if (snapshot.connectionError !== undefined) {
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

  if (eventCount === 0 && snapshot.subscriptionStatus === "follower") {
    // This is the exact failure shape seen after a deploy with stale tabs:
    // the tab is connected but intentionally not subscribing, and its local
    // SQLite mirror is empty. Surface it loudly instead of showing only a
    // spinner, because there may be no exception in this tab's console.
    return (
      <output
        className="grid gap-[3px] border-b border-[#fedf89] bg-[#fff8e6] py-[9px] pr-4 text-xs text-[#7a4b00]"
        data-testid="stream-warning"
      >
        <strong>Follower with empty SQLite mirror</strong>
        <span>
          This tab is waiting for the elected writer tab to mirror events into local SQLite. Reload
          or close older tabs if this does not resolve.
        </span>
      </output>
    );
  }

  return null;
}

function EventRowWindow({
  streamDatabase,
  virtualItems,
  expandedOffsets,
  eventCount,
  eventTypeFilter,
  measureElement,
  onToggleOffset,
}: {
  streamDatabase: StreamBrowserDatabase;
  virtualItems: VirtualItem[];
  expandedOffsets: Set<number>;
  eventCount: number;
  eventTypeFilter: string;
  measureElement: (node: Element | null) => void;
  onToggleOffset(offset: number): void;
}) {
  const firstIndex = virtualItems[0]?.index ?? 0;
  const lastIndex = virtualItems.at(-1)?.index ?? -1;
  const windowSize = Math.max(0, lastIndex - firstIndex + 1);
  // local_index is the dense, zero-based browser list position TanStack Virtual reads.
  // Today it is offset - 1 and SQLite rejects gaps. If server-side TTL later ages out
  // old offsets, this column can remain the local dense index while offset keeps its
  // original stream identity.
  //
  // With no filter, the virtual index and local_index are the same. With an event-type
  // filter, TanStack Virtual indexes the filtered list, so SQLite walks the
  // events_type_local_index index in local order and returns LIMIT/OFFSET rows from
  // that filtered list.
  const rowQueryResult = useStreamQuery(
    streamDatabase,
    eventTypeFilter === ""
      ? `SELECT local_index AS virtual_index, '' AS query_event_type,
           local_index, offset, type, idempotency_key, created_at, inserted_at, json_pretty(raw_jsonb) AS raw_json
         FROM events
         WHERE local_index >= ? AND local_index < ?
         ORDER BY local_index ASC`
      : `SELECT ? + ROW_NUMBER() OVER (ORDER BY local_index) - 1 AS virtual_index,
           ? AS query_event_type,
           local_index, offset, type, idempotency_key, created_at, inserted_at, raw_json
         FROM (
           SELECT local_index, offset, type, idempotency_key, created_at, inserted_at, json_pretty(raw_jsonb) AS raw_json
           FROM events
           WHERE type = ?
           ORDER BY local_index ASC
           LIMIT ? OFFSET ?
         )
         ORDER BY local_index ASC`,
    eventTypeFilter === ""
      ? [firstIndex, lastIndex + 1]
      : [firstIndex, eventTypeFilter, eventTypeFilter, windowSize, firstIndex],
  );
  const rowsByLocalIndex = useMemo(() => {
    const rows = new Map<number, StreamEventRow>();
    for (const row of rowQueryResult.data) {
      const event = streamEventRowFromSql(row);
      if (
        event !== undefined &&
        row.query_event_type === eventTypeFilter &&
        typeof row.virtual_index === "number"
      ) {
        rows.set(row.virtual_index, event);
      }
    }
    return rows;
  }, [eventTypeFilter, rowQueryResult.data]);
  const markedFirstRowDraw = useRef(false);
  useLayoutEffect(() => {
    if (markedFirstRowDraw.current || rowsByLocalIndex.size === 0) return;
    markedFirstRowDraw.current = true;
    performance.mark("stream:first-event-row");
  }, [rowsByLocalIndex.size]);

  return virtualItems.map((virtualItem) => {
    const event = rowsByLocalIndex.get(virtualItem.index);
    const isExpanded = event !== undefined && expandedOffsets.has(event.offset);
    const isLastEventRow = virtualItem.index === eventCount - 1;

    return (
      <div
        className={
          isLastEventRow
            ? "absolute left-0 top-0 w-full pb-2"
            : "absolute left-0 top-0 w-full pb-2 after:absolute after:bottom-1 after:left-0 after:right-0 after:h-px after:bg-[#eef1f5]"
        }
        data-index={virtualItem.index}
        data-testid="virtual-row"
        key={virtualItem.key}
        ref={event === undefined ? undefined : measureElement}
        style={{ transform: `translateY(${virtualItem.start}px)` }}
      >
        {event === undefined ? (
          <article
            className="box-border h-[30px] rounded-md border border-[#e1e5eb]"
            data-testid="event-row-pending"
          />
        ) : (
          <article
            data-testid="event-row"
            className={
              isExpanded ? "min-w-0 overflow-hidden bg-white" : "min-w-0 overflow-hidden bg-white"
            }
          >
            <button
              aria-expanded={isExpanded}
              className="grid w-full cursor-pointer grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-3 border-0 bg-transparent px-2.5 py-2 text-left font-mono text-xs text-[#536073] hover:bg-[#f8fafc]"
              data-event-offset={event.offset}
              data-event-type={event.type}
              data-local-index={event.local_index}
              data-testid="event-meta"
              type="button"
              onClick={() => onToggleOffset(event.offset)}
            >
              <span>{event.offset}</span>
              <span>{event.type}</span>
              <time dateTime={event.created_at}>{event.created_at}</time>
            </button>
            {isExpanded ? (
              <pre
                className="m-0 overflow-auto whitespace-pre-wrap break-words p-2.5 font-mono text-[13px] leading-normal"
                data-testid="event-json"
              >
                {event.raw_json}
              </pre>
            ) : null}
          </article>
        )}
      </div>
    );
  });
}

function streamEventRowFromSql(row: Record<string, unknown>): StreamEventRow | undefined {
  if (
    typeof row.local_index !== "number" ||
    typeof row.offset !== "number" ||
    typeof row.type !== "string" ||
    typeof row.created_at !== "string" ||
    typeof row.inserted_at !== "string" ||
    typeof row.raw_json !== "string" ||
    !(row.idempotency_key === null || typeof row.idempotency_key === "string")
  ) {
    return undefined;
  }
  return {
    local_index: row.local_index,
    offset: row.offset,
    type: row.type,
    idempotency_key: row.idempotency_key,
    created_at: row.created_at,
    inserted_at: row.inserted_at,
    raw_json: row.raw_json,
  };
}

function StreamSidebar({
  className,
  streamPath,
  currentView,
  snapshot,
  streamDatabase,
  streamStore,
  eventCount,
  onSidebarOpenChange,
}: {
  className?: string;
  streamPath: string;
  currentView: string;
  snapshot: StreamBrowserSnapshot;
  streamDatabase: StreamBrowserDatabase;
  streamStore: StreamBrowserStore;
  eventCount: number;
  onSidebarOpenChange(open: boolean): void;
}) {
  return (
    <aside
      className={
        className === undefined
          ? "w-[252px] flex-[0_0_252px] shrink-0 overflow-y-auto border-r border-[#e8ebf0] bg-white p-4 max-[760px]:order-first max-[760px]:max-h-[50dvh] max-[760px]:w-auto max-[760px]:flex-none max-[760px]:border-b max-[760px]:border-r-0"
          : `w-[252px] flex-[0_0_252px] shrink-0 overflow-y-auto border-r border-[#e8ebf0] bg-white p-4 max-[760px]:order-first max-[760px]:max-h-[50dvh] max-[760px]:w-auto max-[760px]:flex-none max-[760px]:border-b max-[760px]:border-r-0 ${className}`
      }
      id="stream-sidebar"
    >
      <StreamTopBar streamPath={streamPath} onSidebarOpenChange={onSidebarOpenChange} />
      <div className="py-2">
        <ViewSwitcher streamPath={streamPath} current={currentView} />
      </div>
      <SubscriptionTool
        eventCount={eventCount}
        snapshot={snapshot}
        streamDatabase={streamDatabase}
        streamStore={streamStore}
      />
      <InsertEventsTool streamStore={streamStore} streamPath={streamPath} />
      <StreamControlTool snapshot={snapshot} streamStore={streamStore} />
    </aside>
  );
}

function SubscriptionTool({
  snapshot,
  streamDatabase,
  streamStore,
  eventCount,
}: {
  snapshot: StreamBrowserSnapshot;
  streamDatabase: StreamBrowserDatabase;
  streamStore: StreamBrowserStore;
  eventCount: number;
}) {
  const [actionFeedback, setActionFeedback] = useState<
    "idle" | "downloading" | "clearing" | "killing" | "resetting" | "done" | "error"
  >("idle");
  const serverActionBusy = actionFeedback === "killing" || actionFeedback === "resetting";

  return (
    <section className="grid gap-2 py-4 first:pt-0">
      <h2 className="m-0 text-[11px] font-semibold uppercase tracking-[0.04em] text-[#98a2b3]">
        Subscription
      </h2>
      <dl className="m-0 grid gap-1 text-xs [&_dd]:m-0 [&_div]:flex [&_div]:items-center [&_div]:justify-between [&_dt]:text-[11px] [&_dt]:font-medium [&_dt]:text-[#98a2b3]">
        <div title="Connection to the stream Durable Object over a capnweb WebSocket: connecting → connected → subscribing → subscribed (or reconnecting / error).">
          <dt>Status</dt>
          <dd>
            <output
              className={
                snapshot.connectionStatus === "error"
                  ? "whitespace-nowrap font-mono text-[11px] text-[#b42318]"
                  : "whitespace-nowrap font-mono text-[11px] text-[#263142]"
              }
              data-testid="stream-status"
            >
              {snapshot.connectionStatus}
            </output>
          </dd>
        </div>
        <div title="This tab's role in the Web Locks election. leader = the single writer (it subscribes to the stream and writes events into the shared local DB); follower = a reader that mirrors the leader's writes from the same on-disk DB; electing/idle = before a role is assigned.">
          <dt>Subscription</dt>
          <dd>
            <output
              className="whitespace-nowrap font-mono text-[11px] text-[#263142]"
              data-testid="subscription-status"
            >
              {snapshot.subscriptionStatus}
            </output>
          </dd>
        </div>
        {snapshot.connectionError === undefined ? null : (
          <div title="The most recent connection or subscription error, if any.">
            <dt>Error</dt>
            <dd>
              <output className="block max-w-[150px] break-words text-right font-mono text-[11px] text-[#b42318]">
                {snapshot.connectionError}
              </output>
            </dd>
          </div>
        )}
        <div title="Number of events stored in this tab's local SQLite mirror (one row per stream offset).">
          <dt>Events</dt>
          <dd>
            <output
              className="whitespace-nowrap font-mono text-[11px] text-[#263142]"
              data-testid="event-count"
            >
              {eventCount}
            </output>
          </dd>
        </div>
        <div title="Whether the page is crossOriginIsolated (the COOP+COEP / SharedArrayBuffer mode). Deliberately false: wa-sqlite's OPFSCoopSyncVFS needs no isolation, and enabling it would re-introduce the SharedArrayBuffer OPFS deadlock. Not a problem — it's expected.">
          <dt>Cross-origin isolated</dt>
          <dd>
            <output className="whitespace-nowrap font-mono text-[11px] text-[#263142]">
              {String(snapshot.databaseInfo?.crossOriginIsolated ?? false)}
            </output>
          </dd>
        </div>
        <div title="Where the SQLite database lives. opfs = the browser's Origin Private File System — a real file on disk that survives reloads.">
          <dt>Storage</dt>
          <dd>
            <output className="whitespace-nowrap font-mono text-[11px] text-[#263142]">
              {snapshot.databaseInfo?.storageType ?? "pending"}
            </output>
          </dd>
        </div>
        <div title="Whether the browser granted eviction-protected ('persistent') storage to this origin. false = best-effort: the data IS saved to disk, but the browser may evict it under storage pressure. Chrome only grants this to engaged/installed origins; there's no API to force it.">
          <dt>Persisted</dt>
          <dd>
            <output className="whitespace-nowrap font-mono text-[11px] text-[#263142]">
              {String(snapshot.databaseInfo?.persisted ?? false)}
            </output>
          </dd>
        </div>
        <div title="On-disk size of this tab's local SQLite database file.">
          <dt>DB file size</dt>
          <dd>
            <output className="whitespace-nowrap font-mono text-[11px] text-[#263142]">
              {formatByteSize(snapshot.databaseInfo?.databaseSizeBytes ?? 0)}
            </output>
          </dd>
        </div>
      </dl>
      <div className="flex flex-wrap gap-1.5">
        <button
          className="min-h-0 flex-[1_1_calc(50%_-_3px)] cursor-pointer whitespace-nowrap rounded border border-[#d8dde4] bg-white px-1.5 py-1 text-center text-[11px] font-medium text-[#475467] hover:border-[#bac2cf] hover:bg-[#f8f9fb] disabled:cursor-default disabled:opacity-55"
          disabled={actionFeedback === "downloading" || serverActionBusy}
          type="button"
          onClick={() => {
            setActionFeedback("downloading");
            void streamDatabase.download().then(
              () => setActionFeedback("done"),
              () => setActionFeedback("error"),
            );
          }}
        >
          Download
        </button>
        <button
          className="min-h-0 flex-[1_1_calc(50%_-_3px)] cursor-pointer whitespace-nowrap rounded border border-[#d8dde4] bg-white px-1.5 py-1 text-center text-[11px] font-medium text-[#475467] hover:border-[#bac2cf] hover:bg-[#f8f9fb] disabled:cursor-default disabled:opacity-55"
          disabled={actionFeedback === "clearing" || serverActionBusy}
          type="button"
          onClick={() => {
            setActionFeedback("clearing");
            void streamStore.clearLocalDatabase().then(
              () => setActionFeedback("done"),
              () => setActionFeedback("error"),
            );
          }}
        >
          Clear local
        </button>
        <button
          className="min-h-0 flex-[1_1_calc(50%_-_3px)] cursor-pointer whitespace-nowrap rounded border border-[#d8dde4] bg-white px-1.5 py-1 text-center text-[11px] font-medium text-[#475467] hover:border-[#bac2cf] hover:bg-[#f8f9fb] disabled:cursor-default disabled:opacity-55"
          disabled={serverActionBusy}
          title="Abort the stream DO; durable log is kept and a woken event is appended on restart."
          type="button"
          onClick={() => {
            setActionFeedback("killing");
            void streamStore.kill().then(
              () => setActionFeedback("done"),
              () => setActionFeedback("error"),
            );
          }}
        >
          Kill
        </button>
        <button
          className="min-h-0 flex-[1_1_calc(50%_-_3px)] cursor-pointer whitespace-nowrap rounded border border-[#d8dde4] bg-white px-1.5 py-1 text-center text-[11px] font-medium text-[#475467] hover:border-[#bac2cf] hover:bg-[#f8f9fb] disabled:cursor-default disabled:opacity-55"
          disabled={serverActionBusy}
          title="Wipe all stream DO storage, then abort — next connection starts a fresh stream."
          type="button"
          onClick={() => {
            setActionFeedback("resetting");
            void streamStore.reset().then(
              () => setActionFeedback("done"),
              () => setActionFeedback("error"),
            );
          }}
        >
          Reset
        </button>
      </div>
      {actionFeedback === "idle" ? null : (
        <output
          className={
            actionFeedback === "error"
              ? "min-h-4 font-mono text-xs uppercase text-[#b42318]"
              : "min-h-4 font-mono text-xs uppercase text-[#667085]"
          }
        >
          {actionFeedback}
        </output>
      )}
    </section>
  );
}

const RUNTIME_STATE_POLL_MS = 1_000;

function useStreamRuntimeState(streamStore: StreamBrowserStore, connectionStatus: string) {
  const [runtimeState, setRuntimeState] = useState<StreamRuntimeState | undefined>();
  const [pollError, setPollError] = useState<string | undefined>();

  useEffect(() => {
    if (connectionStatus === "connecting" || connectionStatus === "closed") {
      setRuntimeState(undefined);
      setPollError(undefined);
      return;
    }

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const next = await streamStore.runtimeState();
        if (!disposed) {
          setRuntimeState(next);
          setPollError(undefined);
        }
      } catch (caught) {
        if (!disposed) {
          setPollError(caught instanceof Error ? caught.message : String(caught));
        }
      }
      if (!disposed) timer = setTimeout(() => void poll(), RUNTIME_STATE_POLL_MS);
    };

    void poll();

    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [connectionStatus, streamStore]);

  return { runtimeState, pollError };
}

function StreamControlTool({
  snapshot,
  streamStore,
}: {
  snapshot: StreamBrowserSnapshot;
  streamStore: StreamBrowserStore;
}) {
  const { runtimeState, pollError } = useStreamRuntimeState(streamStore, snapshot.connectionStatus);
  const core = runtimeState?.coreProcessorState;
  const paused = core?.paused ?? false;
  const pauseReason = core?.pauseReason ?? null;

  const [burstCapacity, setBurstCapacity] = useState(() =>
    String(DEFAULT_CIRCUIT_BREAKER_BURST_CAPACITY),
  );
  const [refillRatePerMinute, setRefillRatePerMinute] = useState(() =>
    String(DEFAULT_CIRCUIT_BREAKER_REFILL_RATE_PER_MINUTE),
  );
  const [controlAction, setControlAction] = useState<
    "idle" | "resuming" | "configuring" | "done" | "error"
  >("idle");

  async function resumeStream() {
    setControlAction("resuming");
    try {
      await streamStore.appendBatch({
        events: [
          {
            type: "events.iterate.com/stream/resumed",
            payload: { reason: "operator resume from sidebar" },
          },
        ],
      });
      setControlAction("done");
    } catch {
      setControlAction("error");
    }
  }

  async function applyCircuitBreakerConfig() {
    const burst = Math.floor(Number(burstCapacity));
    const refill = Math.floor(Number(refillRatePerMinute));
    if (!Number.isFinite(burst) || burst <= 0 || !Number.isFinite(refill) || refill <= 0) {
      return;
    }

    setControlAction("configuring");
    try {
      await streamStore.appendBatch({
        events: [
          {
            type: "events.iterate.com/circuit-breaker/configured",
            payload: { burstCapacity: burst, refillRatePerMinute: refill },
            idempotencyKey: `circuit-breaker:${burst}:${refill}`,
          },
        ],
      });
      setControlAction("done");
    } catch {
      setControlAction("error");
    }
  }

  const gateLabel = runtimeState === undefined ? "…" : paused ? "Paused" : "Active";
  const gateClass =
    runtimeState === undefined ? "text-[#667085]" : paused ? "text-[#b42318]" : "text-[#067647]";

  return (
    <section className="grid gap-2 border-t border-[#eef1f5] py-4">
      <h2 className="m-0 text-[11px] font-semibold uppercase tracking-[0.04em] text-[#98a2b3]">
        Stream gate
      </h2>
      <dl className="m-0 grid gap-1 text-xs [&_dd]:m-0 [&_div]:flex [&_div]:items-center [&_div]:justify-between [&_dt]:text-[11px] [&_dt]:font-medium [&_dt]:text-[#98a2b3]">
        <div title="Whether the core processor is rejecting ordinary appends (paused) or accepting them (active).">
          <dt>Gate</dt>
          <dd>
            <output
              className={`whitespace-nowrap font-mono text-[11px] font-semibold ${gateClass}`}
              data-testid="stream-gate-status"
            >
              {gateLabel}
            </output>
          </dd>
        </div>
        {pauseReason === null ? null : (
          <div title="Why the stream was paused, from the latest stream/paused event.">
            <dt>Pause reason</dt>
            <dd>
              <output
                className="block max-w-[150px] break-words text-right font-mono text-[11px] text-[#b42318]"
                data-testid="stream-pause-reason"
              >
                {pauseReason}
              </output>
            </dd>
          </div>
        )}
      </dl>
      {paused ? (
        <button
          className="w-full cursor-pointer whitespace-nowrap rounded-md bg-[#067647] px-3 py-2 text-[13px] font-semibold text-white disabled:cursor-default disabled:opacity-55"
          data-testid="stream-resume-button"
          disabled={controlAction === "resuming" || snapshot.connectionStatus !== "subscribed"}
          type="button"
          onClick={() => void resumeStream()}
        >
          Resume stream
        </button>
      ) : null}
      {pollError === undefined ? null : (
        <output
          className="font-mono text-[11px] text-[#b42318]"
          data-testid="stream-control-error"
          role="alert"
        >
          {pollError}
        </output>
      )}
      <h3 className="m-0 pt-1 text-[11px] font-semibold uppercase tracking-[0.04em] text-[#98a2b3]">
        Circuit breaker
      </h3>
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void applyCircuitBreakerConfig();
        }}
      >
        <label className="grid gap-1 text-[11px] font-medium text-[#667085]">
          <span>Burst capacity</span>
          <input
            className="min-w-0 rounded-md border border-[#e1e5eb] bg-white/70 px-2 py-1.5 font-mono text-xs"
            data-testid="circuit-breaker-burst-capacity"
            min="1"
            step="1"
            type="number"
            value={burstCapacity}
            onChange={(event) => setBurstCapacity(event.currentTarget.value)}
          />
        </label>
        <label className="grid gap-1 text-[11px] font-medium text-[#667085]">
          <span>Refill / minute</span>
          <input
            className="min-w-0 rounded-md border border-[#e1e5eb] bg-white/70 px-2 py-1.5 font-mono text-xs"
            data-testid="circuit-breaker-refill-rate"
            min="1"
            step="1"
            type="number"
            value={refillRatePerMinute}
            onChange={(event) => setRefillRatePerMinute(event.currentTarget.value)}
          />
        </label>
        <button
          className="cursor-pointer whitespace-nowrap rounded-md border border-[#d8dde4] bg-white px-3 py-2 text-[13px] font-medium text-[#475467] hover:border-[#bac2cf] hover:bg-[#f8f9fb] disabled:cursor-default disabled:opacity-55"
          data-testid="circuit-breaker-apply"
          disabled={
            controlAction === "configuring" || paused || snapshot.connectionStatus !== "subscribed"
          }
          title={
            paused
              ? "Resume the stream first — circuit-breaker/configured cannot append while paused."
              : undefined
          }
          type="submit"
        >
          Apply limits
        </button>
        {paused ? (
          <p className="m-0 text-[11px] leading-snug text-[#667085]">
            Limits can only be changed while the gate is active. Resume the stream first.
          </p>
        ) : null}
      </form>
      {controlAction === "idle" ? null : (
        <output
          className={
            controlAction === "error"
              ? "min-h-4 font-mono text-xs uppercase text-[#b42318]"
              : "min-h-4 font-mono text-xs uppercase text-[#667085]"
          }
          data-testid="stream-control-action"
        >
          {controlAction}
        </output>
      )}
    </section>
  );
}

function formatByteSize(bytes: number) {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toLocaleString(undefined, {
    maximumFractionDigits: unitIndex === 0 ? 0 : 1,
  })} ${units[unitIndex]}`;
}

function InsertEventsTool({
  streamPath,
  streamStore,
}: {
  streamPath: string;
  streamStore: StreamBrowserStore;
}) {
  const [insertState, dispatchInsertState] = useReducer(
    (
      state: {
        insertEventCount: string;
        insertBatchSize: string;
        periodSeconds: string;
        appendResponseMode: "await" | "background" | "dispose";
        insertState: "idle" | "inserting" | "done" | "error";
      },
      action:
        | { type: "set-insert-event-count"; value: string }
        | { type: "set-insert-batch-size"; value: string }
        | { type: "set-period-seconds"; value: string }
        | { type: "set-append-response-mode"; value: "await" | "background" | "dispose" }
        | { type: "set-insert-state"; value: "idle" | "inserting" | "done" | "error" },
    ) => {
      switch (action.type) {
        case "set-insert-event-count":
          return { ...state, insertEventCount: action.value };
        case "set-insert-batch-size":
          return { ...state, insertBatchSize: action.value };
        case "set-period-seconds":
          return { ...state, periodSeconds: action.value };
        case "set-append-response-mode":
          return { ...state, appendResponseMode: action.value };
        case "set-insert-state":
          return { ...state, insertState: action.value };
      }
    },
    {
      insertEventCount: "1000",
      insertBatchSize: "100",
      periodSeconds: "5",
      appendResponseMode: "await",
      insertState: "idle",
    },
  );

  async function insertRandomEvents() {
    const count = Math.max(0, Math.floor(Number(insertState.insertEventCount)));
    const batchSize = Math.max(1, Math.floor(Number(insertState.insertBatchSize)));
    const periodMs = Math.max(0, Number(insertState.periodSeconds) * 1_000);
    if (
      !Number.isFinite(count) ||
      !Number.isFinite(batchSize) ||
      !Number.isFinite(periodMs) ||
      count === 0
    ) {
      return;
    }

    dispatchInsertState({ type: "set-insert-state", value: "inserting" });

    try {
      const pendingResponses: Promise<unknown>[] = [];
      const batchCount = Math.ceil(count / batchSize);
      const batchDelayMs = batchCount <= 1 ? 0 : periodMs / (batchCount - 1);

      await Promise.all(
        Array.from({ length: batchCount }, (_, batchIndex) =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, batchDelayMs * batchIndex);
          }).then(() => {
            const startIndex = batchIndex * batchSize;
            const result = streamStore.appendBatch({
              events: Array.from(
                { length: Math.min(batchSize, count - startIndex) },
                (_, indexInBatch) => {
                  const index = startIndex + indexInBatch;
                  return randomStreamEventInput({
                    batchIndex,
                    batchSize,
                    count,
                    index,
                    streamPath,
                  });
                },
              ),
            });

            if (insertState.appendResponseMode === "await") {
              pendingResponses.push(result);
            } else if (insertState.appendResponseMode === "background") {
              // CapnWeb RpcPromises are lazy. Calling `.then()` starts the
              // append without making this form wait for the returned events.
              void result.then(undefined, (error: unknown) => {
                console.error("background appendBatch failed", error);
              });
            } else if (insertState.appendResponseMode === "dispose") {
              // CapnWeb says callers should dispose RpcPromises they do not
              // await. This option tests whether that still lets a write-only
              // append reach the Durable Object before cancellation wins.
              result[Symbol.dispose]();
            }
          }),
        ),
      );
      if (insertState.appendResponseMode === "await") await Promise.all(pendingResponses);
      dispatchInsertState({ type: "set-insert-state", value: "done" });
    } catch {
      dispatchInsertState({ type: "set-insert-state", value: "error" });
    }
  }

  return (
    <section className="grid gap-2 border-t border-[#eef1f5] py-4">
      <h2 className="m-0 text-[11px] font-semibold uppercase tracking-[0.04em] text-[#98a2b3]">
        Insert events
      </h2>
      <label className="grid gap-1 text-[11px] font-medium text-[#667085]">
        <span>Count</span>
        <input
          className="min-w-0 rounded-md border border-[#e1e5eb] bg-white/70 px-2 py-1.5 font-mono text-xs"
          min="1"
          step="1"
          type="number"
          value={insertState.insertEventCount}
          onChange={(event) =>
            dispatchInsertState({
              type: "set-insert-event-count",
              value: event.currentTarget.value,
            })
          }
        />
      </label>
      <label className="grid gap-1 text-[11px] font-medium text-[#667085]">
        <span>Seconds</span>
        <input
          className="min-w-0 rounded-md border border-[#e1e5eb] bg-white/70 px-2 py-1.5 font-mono text-xs"
          min="0"
          step="0.1"
          type="number"
          value={insertState.periodSeconds}
          onChange={(event) =>
            dispatchInsertState({
              type: "set-period-seconds",
              value: event.currentTarget.value,
            })
          }
        />
      </label>
      <label className="grid gap-1 text-[11px] font-medium text-[#667085]">
        <span>Batch size</span>
        <input
          className="min-w-0 rounded-md border border-[#e1e5eb] bg-white/70 px-2 py-1.5 font-mono text-xs"
          min="1"
          step="1"
          type="number"
          value={insertState.insertBatchSize}
          onChange={(event) =>
            dispatchInsertState({
              type: "set-insert-batch-size",
              value: event.currentTarget.value,
            })
          }
        />
      </label>
      <label className="grid gap-1 text-[11px] font-medium text-[#667085]">
        <span>appendBatch response</span>
        <select
          className="min-w-0 rounded-md border border-[#e1e5eb] bg-white/70 px-2 py-1.5 font-mono text-xs"
          value={insertState.appendResponseMode}
          onChange={(event) =>
            dispatchInsertState({
              type: "set-append-response-mode",
              value:
                event.currentTarget.value === "dispose"
                  ? "dispose"
                  : event.currentTarget.value === "background"
                    ? "background"
                    : "await",
            })
          }
        >
          <option value="await">Await</option>
          <option value="background">Background</option>
          <option value="dispose">Dispose</option>
        </select>
      </label>
      <button
        className="cursor-pointer whitespace-nowrap rounded-md bg-[#1f6feb] px-3 py-2 text-[13px] font-semibold text-white no-underline disabled:cursor-default disabled:opacity-55"
        disabled={insertState.insertState === "inserting"}
        type="button"
        onClick={() => void insertRandomEvents()}
      >
        Stream random events
      </button>
      <output
        className="min-h-4 font-mono text-xs uppercase text-[#667085]"
        data-testid="insert-state"
      >
        {insertState.insertState}
      </output>
    </section>
  );
}

function randomStreamEventInput(args: {
  batchIndex: number;
  batchSize: number;
  count: number;
  index: number;
  streamPath: string;
}) {
  const randomValues = new Uint32Array(3);
  crypto.getRandomValues(randomValues);
  const random = randomValues[0] ?? 0;
  const suffix = `${args.index}-${crypto.randomUUID().slice(0, 8)}`;
  const actors = ["Ada", "Grace", "Linus", "Margaret", "Katherine", "Dennis"];
  const nouns = ["invoice", "deployment", "workspace", "artifact", "subscription", "trace"];
  const adjectives = ["urgent", "draft", "verified", "archived", "reviewed", "blocked"];
  const actor = actors[random % actors.length] ?? "Ada";
  const noun = nouns[(randomValues[1] ?? 0) % nouns.length] ?? "artifact";
  const adjective = adjectives[(randomValues[2] ?? 0) % adjectives.length] ?? "reviewed";
  const eventTypes = [
    "events.iterate.com/random/note-appended",
    "events.iterate.com/random/tag-applied",
    "events.iterate.com/random/status-changed",
    "events.iterate.com/random/metric-recorded",
    "events.iterate.com/random/ping-sent",
  ] as const;
  const type = eventTypes[random % eventTypes.length] ?? "events.iterate.com/random/note-appended";
  const debug = {
    batchIndex: args.batchIndex,
    batchSize: args.batchSize,
    count: args.count,
    generatedAt: new Date().toISOString(),
    index: args.index,
    streamPath: args.streamPath,
  };

  if (type === "events.iterate.com/random/note-appended") {
    return {
      type,
      payload: {
        ...debug,
        actor,
        body: `${actor} appended a ${adjective} note about the ${noun}.`,
        id: suffix,
      },
    };
  }

  if (type === "events.iterate.com/random/tag-applied") {
    return {
      type,
      payload: {
        ...debug,
        actor,
        tags: [noun, adjective],
        targetId: suffix,
      },
    };
  }

  if (type === "events.iterate.com/random/status-changed") {
    return {
      type,
      payload: {
        ...debug,
        actor,
        from: adjective,
        to: noun,
        targetId: suffix,
      },
    };
  }

  if (type === "events.iterate.com/random/metric-recorded") {
    return {
      type,
      payload: {
        ...debug,
        metric: noun,
        unit: "count",
        value: 1 + (random % 100),
      },
    };
  }

  return {
    type,
    payload: {
      ...debug,
      actor,
      message: `${actor} sent ping ${suffix}`,
      sequence: args.index,
    },
  };
}

function StreamComposer({ streamStore }: { streamStore: StreamBrowserStore }) {
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
    if (textarea === null) return;
    const maxHeight = Math.floor(window.innerHeight * 0.35);
    textarea.style.height = "auto";
    textarea.style.maxHeight = `${maxHeight}px`;
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
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
          title={
            appendState === "appending"
              ? "Appending"
              : appendState === "done"
                ? "Appended"
                : "Append event"
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
          <AppendEventIcon />
        </button>
      </div>
    </section>
  );
}

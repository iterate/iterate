import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { Link } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDownIcon, FilterIcon, SearchIcon } from "lucide-react";
import {
  acquireStreamRuntime,
  type StreamBrowserStore,
  type StreamRuntimeState,
} from "@iterate-com/streams/browser/stream-browser-store";
import { useStreamQuery } from "@iterate-com/streams/browser/hooks/use-stream-query";
import type {
  SqliteQueryStatus,
  StreamBrowserDatabase,
  StreamEventRow,
} from "@iterate-com/streams/browser/stream-browser-db";
import { browserProcessorStateStorage } from "@iterate-com/streams/browser/processor-state-storage";
import {
  BROWSER_RAW_EVENTS_SCHEMA_VERSION,
  BrowserRawEventsContract,
  BrowserRawEventsProcessor,
  type BrowserRawEventsState,
} from "@iterate-com/streams/processors/browser-raw-events/implementation";
import { StreamEventInput } from "@iterate-com/streams/shared/event";
import {
  getInitialProcessorState,
  runProcessorReduce,
  type StreamEvent,
} from "@iterate-com/streams/shared/stream-processors";
import type { Event, StreamPath } from "@iterate-com/shared/streams/types";
import { Button } from "@iterate-com/ui/components/button";
import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
import { SidebarTrigger } from "@iterate-com/ui/components/sidebar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@iterate-com/ui/components/select";
import { Tabs, TabsList, TabsTrigger } from "@iterate-com/ui/components/tabs";
import type { EventsStreamViewState } from "@iterate-com/ui/components/events/feed-items";
import {
  EventsStreamView,
  type EventsStreamElementType,
  type EventsStreamRendererMode,
} from "@iterate-com/ui/components/events/stream-feed";
import { StreamViewProcessorContract } from "@iterate-com/ui/components/events/stream-view-processor/contract";
import type { AgentUiState } from "@iterate-com/ui/components/events/agent-ui-reducer";
import {
  AGENT_UI_FEED_TABLE,
  AGENT_UI_SCHEMA_VERSION,
  AgentUiProcessor,
  AgentUiProcessorContract,
} from "@iterate-com/ui/components/events/agent-ui-processor";
import { cn } from "@iterate-com/ui/lib/utils";
import { parse as parseYaml } from "yaml";
import { AgentFeedView } from "~/components/agent-feed.tsx";
import { AgentPillComposer, type AgentComposerMode } from "~/components/agent-pill-composer.tsx";
import { PresenceAvatar, StreamProcessorsPanel } from "~/components/stream-processors-panel.tsx";
import { StreamSwitcherDialog } from "~/components/stream-switcher-dialog.tsx";
import { sparklinePoints, useSimulatedRttMetrics } from "~/lib/stream-presence.ts";
import type { StreamNavigator } from "~/lib/stream-navigation.ts";
import { projectStreamRpcPath } from "~/lib/stream-links.ts";

type ProjectStreamMessageComposer = {
  placeholder?: string;
  onSubmit: (message: string) => Promise<void>;
};

type ProjectStreamViewTab = "agent" | "feed" | "raw" | "state";
type StreamPathLinkRenderer = (input: {
  children: ReactNode;
  className?: string;
  path: StreamPath;
}) => ReactNode;

const DEFAULT_RAW_EVENT_YAML =
  "type: events.iterate.com/os/manual-event\npayload:\n  message: Hello from OS\n";

const MAX_PRESENCE_AVATARS = 4;

export function ProjectStreamView({
  defaultComposerMode,
  emptyLabel = "No events in this stream yet.",
  headerAccessory,
  messageComposer,
  projectSlug,
  projectSlugOrId,
  renderStreamPathLink,
  streamNavigator,
  streamUrl,
  streamPath,
}: {
  defaultComposerMode?: "message" | "raw";
  emptyLabel?: string;
  headerAccessory?: ReactNode;
  messageComposer?: ProjectStreamMessageComposer;
  projectSlug: string;
  projectSlugOrId: string;
  renderStreamPathLink?: StreamPathLinkRenderer;
  streamNavigator?: StreamNavigator;
  streamUrl?: string;
  streamPath: StreamPath;
}) {
  const streamPathText = streamPath.toString();
  const store = useMemo(
    () =>
      acquireStreamRuntime({
        namespace: projectSlugOrId,
        streamPath: streamPathText,
        streamUrl: streamUrl ?? projectStreamRpcPath(projectSlugOrId, streamPathText),
        slug: BrowserRawEventsContract.slug,
        schemaVersion: BROWSER_RAW_EVENTS_SCHEMA_VERSION,
        tables: ["events"],
        createProcessor({ stream, sql, subscriptionKey }) {
          const storage = browserProcessorStateStorage<BrowserRawEventsState>({
            sql,
            processorSlug: BrowserRawEventsContract.slug,
            subscriptionKey,
          });
          return new BrowserRawEventsProcessor({
            iterateContext: { stream },
            sql,
            readState: storage.readState,
            writeState: storage.writeState,
          });
        },
      }),
    [projectSlugOrId, streamPathText, streamUrl],
  );
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
  const countResult = useStreamQuery(store.streamDatabase, `SELECT COUNT(*) AS count FROM events`);
  const eventCount = Number(countResult.data[0]?.count ?? 0);
  const reductionKey = `${projectSlugOrId}:${streamPathText}`;

  // A second browser-hosted processor on the same stream (and same per-path
  // SQLite database): folds agent events into settled `agent_feed_items` rows
  // plus a live in-flight activity persisted in its reduced state. Runs at
  // this level (not inside the agent tab) because the header chrome —
  // presence avatars, busy indicator — derives from the same state.
  const agentStore = useMemo(
    () =>
      acquireStreamRuntime({
        namespace: projectSlugOrId,
        streamPath: streamPathText,
        streamUrl: streamUrl ?? projectStreamRpcPath(projectSlugOrId, streamPathText),
        slug: AgentUiProcessorContract.slug,
        schemaVersion: AGENT_UI_SCHEMA_VERSION,
        tables: [AGENT_UI_FEED_TABLE],
        createProcessor({ stream, sql, subscriptionKey }) {
          const storage = browserProcessorStateStorage<AgentUiState>({
            sql,
            processorSlug: AgentUiProcessorContract.slug,
            subscriptionKey,
          });
          return new AgentUiProcessor({
            iterateContext: { stream },
            sql,
            readState: storage.readState,
            writeState: storage.writeState,
          });
        },
      }),
    [projectSlugOrId, streamPathText, streamUrl],
  );
  const agentSnapshot = useSyncExternalStore(
    agentStore.subscribe,
    agentStore.getSnapshot,
    agentStore.getServerSnapshot,
  );
  const agentUiState = useAgentUiReducedState(store.streamDatabase);
  const metrics = useSimulatedRttMetrics();

  const [activeTab, setActiveTab] = useState<ProjectStreamViewTab>("agent");
  const [toolsOpen, setToolsOpen] = useState(false);
  const [feedSearch, setFeedSearch] = useState("");
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [procPanelOpen, setProcPanelOpen] = useState(false);
  const feedSearchInputRef = useRef<HTMLInputElement>(null);
  const [composerMode, setComposerMode] = useState<AgentComposerMode>(
    defaultComposerMode ?? (messageComposer ? "message" : "raw"),
  );
  const [messageText, setMessageText] = useState("");
  const [rawText, setRawText] = useState(DEFAULT_RAW_EVENT_YAML);
  const [submitError, setSubmitError] = useState<string | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Only auto-scroll the raw view to the bottom when the viewport is already
  // pinned there. Yanking a scrolled-up reader back to the bottom on every
  // append shifts the virtualized window far enough that the whole visible
  // range re-queries and flashes grey skeletons before SQLite returns the new
  // rows. Lives here (not in the raw view) so the composer can re-pin it.
  const rawStickToBottomRef = useRef(true);

  useEffect(() => {
    if (toolsOpen) feedSearchInputRef.current?.focus();
  }, [toolsOpen]);

  useEffect(() => {
    if (streamNavigator == null) return;
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && (event.key === "k" || event.key === "K")) {
        event.preventDefault();
        setSwitcherOpen((previous) => !previous);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [streamNavigator]);

  async function runSubmit(action: () => Promise<void>) {
    setIsSubmitting(true);
    setSubmitError(undefined);
    // The user just appended from the composer at the bottom, so follow the
    // new event down even if they had scrolled up earlier.
    rawStickToBottomRef.current = true;
    try {
      await action();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function submitMessage() {
    const trimmed = messageText.trim();
    if (!trimmed || messageComposer == null) return;
    await runSubmit(async () => {
      await messageComposer.onSubmit(trimmed);
      setMessageText("");
    });
  }

  async function submitRawEvents() {
    const trimmed = rawText.trim();
    if (!trimmed) return;
    await runSubmit(async () => {
      const parsed = parseYaml(trimmed) as unknown;
      const events = (Array.isArray(parsed) ? parsed : [parsed]).map((event) =>
        StreamEventInput.parse(event),
      );
      await store.appendBatch({ events });
    });
  }

  const connectionLabel =
    snapshot.connectionError ??
    (snapshot.connectionStatus === "subscribed" ? emptyLabel : snapshot.connectionStatus);
  const agentBusy = agentUiState?.live != null;
  const presence = agentUiState?.presence ?? [];

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-4 pb-1 pt-2.5">
        <SidebarTrigger className="-ml-1" />
        <button
          type="button"
          aria-haspopup="dialog"
          title={
            streamNavigator == null
              ? streamPathText
              : `${streamPathText} — click or ⌘K to switch streams`
          }
          onClick={() => streamNavigator != null && setSwitcherOpen(true)}
          className={cn(
            "flex h-9 min-w-0 items-center gap-2 rounded-full bg-muted px-3.5",
            streamNavigator != null && "cursor-pointer hover:bg-muted/70",
          )}
        >
          <span className="truncate font-mono text-sm">{streamPathText}</span>
          {streamNavigator == null ? null : (
            <>
              <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
              <kbd className="hidden shrink-0 rounded bg-background px-1.5 py-px text-[10px] text-muted-foreground sm:inline">
                ⌘K
              </kbd>
            </>
          )}
        </button>

        <div className="ml-auto flex items-center gap-3">
          {presence.length === 0 ? null : (
            <button
              type="button"
              title="Stream processors & presence"
              onClick={() => setProcPanelOpen(true)}
              className="flex items-center pl-1.5"
            >
              {presence.slice(0, MAX_PRESENCE_AVATARS).map((entry) => (
                <PresenceAvatar
                  key={entry.subscriptionKey}
                  entry={entry}
                  busy={agentBusy}
                  className="-ml-1.5 border-2 border-background"
                />
              ))}
              {presence.length > MAX_PRESENCE_AVATARS ? (
                <span className="-ml-1.5 grid size-6 place-items-center rounded-full border-2 border-background bg-muted font-mono text-[9px] font-bold text-muted-foreground">
                  +{presence.length - MAX_PRESENCE_AVATARS}
                </span>
              ) : null}
            </button>
          )}
          <Button
            variant="ghost"
            size="sm"
            title="Stream health & metrics"
            onClick={() => setProcPanelOpen(true)}
            className="font-mono text-xs font-normal text-muted-foreground"
          >
            <svg width="24" height="11" viewBox="0 0 26 12" className="shrink-0">
              <polyline
                points={sparklinePoints(metrics.spark.slice(-12), 26, 12)}
                fill="none"
                className="stroke-emerald-600"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
            </svg>
            {metrics.rttNow}ms
          </Button>
          <Tabs
            value={activeTab}
            onValueChange={(value) => setActiveTab(value as ProjectStreamViewTab)}
          >
            <TabsList className="h-8">
              <TabsTrigger value="agent" className="px-3 text-xs">
                Agent
              </TabsTrigger>
              <TabsTrigger value="feed" className="px-3 text-xs">
                Feed
              </TabsTrigger>
              <TabsTrigger value="raw" className="px-3 text-xs">
                Raw
              </TabsTrigger>
              <TabsTrigger value="state" className="px-3 text-xs">
                State
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Button
            variant="ghost"
            size="icon"
            title="Search & filter"
            aria-expanded={toolsOpen}
            onClick={() => setToolsOpen((previous) => !previous)}
            className="rounded-full text-muted-foreground"
          >
            <FilterIcon className="size-3.5" />
          </Button>
        </div>
      </header>
      {headerAccessory == null ? null : <div className="shrink-0">{headerAccessory}</div>}
      {toolsOpen ? (
        <div className="flex shrink-0 items-center gap-3 px-4 pb-1.5 pt-1">
          {/* Search filters the agent feed's SQL; the other tabs don't take a
              filter yet, so don't offer a no-op input there. */}
          {activeTab === "agent" ? (
            <div className="flex h-9 min-w-0 max-w-sm flex-1 items-center gap-2 rounded-full bg-muted px-3.5">
              <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                ref={feedSearchInputRef}
                value={feedSearch}
                onChange={(event) => setFeedSearch(event.target.value)}
                placeholder="Search feed…"
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
          ) : null}
          <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
            {eventCount.toLocaleString()} events · {snapshot.connectionStatus}
          </span>
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {activeTab === "agent" ? (
          <AgentFeedView
            database={store.streamDatabase}
            liveState={agentUiState}
            search={feedSearch}
            emptyLabel={connectionLabel}
            // The reduced-state row only exists once the processor has
            // checkpointed; an already-subscribed empty stream is "nothing
            // here yet", not "connecting".
            isPending={agentUiState == null && agentSnapshot.connectionStatus !== "subscribed"}
          />
        ) : activeTab === "feed" ? (
          <ProjectStreamFeedView
            database={store.streamDatabase}
            emptyLabel={connectionLabel}
            renderStreamPathLink={
              renderStreamPathLink ??
              (({ path, children, className }) => (
                <Link
                  to="/projects/$projectSlug/streams/$"
                  params={{ projectSlug, _splat: path }}
                  {...(className == null ? {} : { className })}
                >
                  {children}
                </Link>
              ))
            }
            reductionKey={reductionKey}
          />
        ) : activeTab === "raw" ? (
          <ProjectStreamRawView
            database={store.streamDatabase}
            emptyLabel={connectionLabel}
            stickToBottomRef={rawStickToBottomRef}
          />
        ) : (
          <ProjectStreamStateView store={store} />
        )}
        {procPanelOpen ? (
          <StreamProcessorsPanel
            presence={presence}
            metrics={metrics}
            eventCount={eventCount}
            busy={agentBusy}
            onClose={() => setProcPanelOpen(false)}
          />
        ) : null}
      </div>

      {activeTab === "state" ? null : (
        <div className="shrink-0 px-4 pb-4 pt-2.5">
          <AgentPillComposer
            mode={composerMode}
            onModeChange={setComposerMode}
            {...(messageComposer == null
              ? {}
              : {
                  message: {
                    value: messageText,
                    onValueChange: setMessageText,
                    onSubmit: submitMessage,
                    ...(messageComposer.placeholder == null
                      ? {}
                      : { placeholder: messageComposer.placeholder }),
                  },
                })}
            raw={{
              value: rawText,
              onValueChange: setRawText,
              onSubmit: submitRawEvents,
            }}
            isSubmitting={isSubmitting}
            {...(submitError == null ? {} : { error: submitError })}
          />
        </div>
      )}

      {streamNavigator == null ? null : (
        <StreamSwitcherDialog
          open={switcherOpen}
          onOpenChange={setSwitcherOpen}
          currentPath={streamPath}
          navigator={streamNavigator}
          scope={projectSlugOrId}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Incremental browser-side reduction over the SQLite raw-event mirror
// ---------------------------------------------------------------------------

type ReducedStreamState<TState> = {
  status: SqliteQueryStatus;
  error?: string;
  state: TState;
  events: Event[];
};

type ReductionCache<TState> = {
  key: string;
  rowCount: number;
  lastOffset: number;
  state: TState;
  events: Event[];
};

/**
 * Reduce the SQLite raw-event mirror into a processor's reduced state.
 *
 * The reduction is incremental: appends only reduce the new tail rows on top
 * of the cached state, so live streams (including high-volume LLM chunk
 * deltas) don't replay the whole history on every event. Any non-append
 * change (clear, reset, truncation) recomputes from scratch.
 */
function useReducedStreamState<TState>(args: {
  database: StreamBrowserDatabase;
  reductionKey: string;
  /** Distinguishes caches when several reductions share one reductionKey. */
  cacheScope: string;
  initialState: () => TState;
  reduceEvent: (state: TState, event: Event) => TState;
}): ReducedStreamState<TState> {
  const rowsResult = useStreamQuery(
    args.database,
    `SELECT offset, json(raw_jsonb) AS raw_json FROM events ORDER BY local_index ASC`,
  );
  const cacheRef = useRef<ReductionCache<TState> | null>(null);
  const cacheKey = `${args.cacheScope}:${args.reductionKey}`;
  const { initialState, reduceEvent } = args;

  return useMemo(() => {
    const cached = cacheRef.current?.key === cacheKey ? cacheRef.current : null;

    if (rowsResult.status !== "ok") {
      return {
        status: rowsResult.status,
        ...(rowsResult.error == null ? {} : { error: rowsResult.error.message }),
        state: cached?.state ?? initialState(),
        events: cached?.events ?? [],
      };
    }

    const rows = rowsResult.data;
    const canExtend =
      cached != null &&
      rows.length >= cached.rowCount &&
      (cached.rowCount === 0 || Number(rows[cached.rowCount - 1]?.offset) === cached.lastOffset);

    const startIndex = canExtend ? cached.rowCount : 0;
    let state = canExtend ? cached.state : initialState();
    const events = canExtend ? [...cached.events] : [];

    for (let index = startIndex; index < rows.length; index++) {
      const rawJson = rows[index]?.raw_json;
      if (typeof rawJson !== "string") continue;
      let event: Event;
      try {
        event = JSON.parse(rawJson) as Event;
      } catch {
        continue;
      }
      events.push(event);
      state = reduceEvent(state, event);
    }

    cacheRef.current = {
      key: cacheKey,
      rowCount: rows.length,
      lastOffset: events.length === 0 ? -1 : events[events.length - 1]!.offset,
      state,
      events,
    };

    return { status: "ok" as const, state, events };
  }, [rowsResult, cacheKey, initialState, reduceEvent]);
}

/**
 * The agent-ui processor persists its reduced state (live activity with
 * streaming text, presence roster) to `processor_state` on every checkpoint;
 * reading it reactively is how the live tail re-renders per delta batch.
 * Null until the processor's first checkpoint lands.
 */
function useAgentUiReducedState(database: StreamBrowserDatabase): AgentUiState | null {
  const result = useStreamQuery(
    database,
    // subscription_key is part of the primary key, so multiple rows can exist
    // for the slug (e.g. after a key-format change); read the most advanced one.
    `SELECT reduced_state FROM processor_state WHERE processor_slug = ?
     ORDER BY max_offset DESC LIMIT 1`,
    [AgentUiProcessorContract.slug],
  );
  return useMemo(() => {
    const raw = result.data[0]?.reduced_state;
    if (typeof raw !== "string") return null;
    try {
      return JSON.parse(raw) as AgentUiState;
    } catch {
      return null;
    }
  }, [result.data]);
}

function initialStreamViewState(): EventsStreamViewState {
  return getInitialProcessorState(StreamViewProcessorContract);
}

function reduceStreamViewEvent(state: EventsStreamViewState, event: Event): EventsStreamViewState {
  const reduction = runProcessorReduce({
    processor: { contract: StreamViewProcessorContract },
    event: event as unknown as StreamEvent,
    state,
  });
  return reduction?.state ?? state;
}

// ---------------------------------------------------------------------------
// Feed view: semantic chat-style elements reduced from raw events
// ---------------------------------------------------------------------------

function ProjectStreamFeedView({
  database,
  emptyLabel,
  renderStreamPathLink,
  reductionKey,
}: {
  database: StreamBrowserDatabase;
  emptyLabel: string;
  renderStreamPathLink: StreamPathLinkRenderer;
  reductionKey: string;
}) {
  const feed = useReducedStreamState<EventsStreamViewState>({
    database,
    reductionKey,
    cacheScope: StreamViewProcessorContract.slug,
    initialState: initialStreamViewState,
    reduceEvent: reduceStreamViewEvent,
  });
  const [rendererMode, setRendererMode] = useState<EventsStreamRendererMode>("raw-pretty");
  const [hiddenElementTypes, setHiddenElementTypes] = useState<EventsStreamElementType[]>([]);
  const [openEventOffset, setOpenEventOffset] = useState<number | undefined>(undefined);

  const displayState = useMemo(
    () => applyRendererMode({ viewState: feed.state, events: feed.events, rendererMode }),
    [feed.state, feed.events, rendererMode],
  );

  return (
    <EventsStreamView
      className="min-h-0 flex-1"
      viewState={displayState}
      events={feed.events}
      emptyLabel={emptyLabel}
      isPending={feed.status === "pending" && feed.events.length === 0}
      {...(feed.error == null ? {} : { errorLabel: feed.error })}
      {...(openEventOffset == null ? {} : { openEventOffset })}
      onOpenEventOffsetChange={setOpenEventOffset}
      hiddenElementTypes={hiddenElementTypes}
      onHiddenElementTypesChange={setHiddenElementTypes}
      rendererMode={rendererMode}
      onRendererModeChange={setRendererMode}
      renderStreamPathLink={renderStreamPathLink}
    />
  );
}

/**
 * The reducer always produces both raw groups and semantic elements; renderer
 * modes are pure view-time filters over that single view state.
 */
function applyRendererMode(args: {
  viewState: EventsStreamViewState;
  events: readonly Event[];
  rendererMode: EventsStreamRendererMode;
}): EventsStreamViewState {
  if (args.rendererMode === "pretty") {
    return {
      ...args.viewState,
      slots: {
        ...args.viewState.slots,
        feed: args.viewState.slots.feed.filter((element) => element.type !== "grouped-raw-event"),
      },
    };
  }

  if (args.rendererMode === "raw-single-json") {
    return {
      ...args.viewState,
      slots: {
        ...args.viewState.slots,
        feed: [{ type: "raw-json-dump", id: "raw-json-dump", props: { events: [...args.events] } }],
      },
    };
  }

  return args.viewState;
}

// ---------------------------------------------------------------------------
// Raw view: virtualized event rows with an event-type filter
// ---------------------------------------------------------------------------

const ALL_EVENT_TYPES = "__all__";

function ProjectStreamRawView({
  database,
  emptyLabel,
  stickToBottomRef,
}: {
  database: StreamBrowserDatabase;
  emptyLabel: string;
  stickToBottomRef: RefObject<boolean>;
}) {
  const [eventTypeFilter, setEventTypeFilter] = useState<string>(ALL_EVENT_TYPES);
  const typeFilter = eventTypeFilter === ALL_EVENT_TYPES ? null : eventTypeFilter;
  const typesResult = useStreamQuery(
    database,
    `SELECT type, COUNT(*) AS count FROM events GROUP BY type ORDER BY type ASC`,
  );
  const countResult = useStreamQuery(
    database,
    typeFilter == null
      ? `SELECT COUNT(*) AS count FROM events`
      : `SELECT COUNT(*) AS count FROM events WHERE type = ?`,
    typeFilter == null ? [] : [typeFilter],
  );
  const eventCount = Number(countResult.data[0]?.count ?? 0);
  const [expandedOffsets, setExpandedOffsets] = useState<ReadonlySet<number>>(new Set());
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const scrollContainer = scrollContainerRef.current;
      if (scrollContainer == null) return;
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [eventCount, stickToBottomRef]);

  function toggleOffset(offset: number) {
    setExpandedOffsets((previous) => {
      const next = new Set(previous);
      if (next.has(offset)) {
        next.delete(offset);
      } else {
        next.add(offset);
      }
      return next;
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 px-4 py-2">
        <Select
          value={eventTypeFilter}
          onValueChange={(value) => setEventTypeFilter(value ?? ALL_EVENT_TYPES)}
        >
          <SelectTrigger size="sm" className="min-w-0 max-w-full font-mono text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_EVENT_TYPES}>All event types</SelectItem>
            {typesResult.data.map((row) => (
              <SelectItem
                key={String(row.type)}
                value={String(row.type)}
                className="font-mono text-xs"
              >
                {String(row.type)} ({Number(row.count).toLocaleString()})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {eventCount.toLocaleString()} events
        </span>
      </div>
      <div
        ref={scrollContainerRef}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => {
          const el = event.currentTarget;
          // Within ~80px of the bottom counts as "pinned"; expanding a row or a
          // late virtualizer measurement can leave a few px of slack.
          stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {countResult.status !== "ok" ? (
          <Centered>
            {countResult.status === "error"
              ? (countResult.error?.message ?? "SQLite query failed")
              : "Opening local SQLite mirror"}
          </Centered>
        ) : (
          <VirtualEventRows
            key={eventTypeFilter}
            database={database}
            emptyLabel={typeFilter == null ? emptyLabel : "No events match this type."}
            eventCount={eventCount}
            expandedOffsets={expandedOffsets}
            onToggleOffset={toggleOffset}
            scrollElementRef={scrollContainerRef}
            typeFilter={typeFilter}
          />
        )}
      </div>
    </div>
  );
}

function VirtualEventRows({
  database,
  emptyLabel,
  eventCount,
  expandedOffsets,
  onToggleOffset,
  scrollElementRef,
  typeFilter,
}: {
  database: StreamBrowserDatabase;
  emptyLabel: string;
  eventCount: number;
  expandedOffsets: ReadonlySet<number>;
  onToggleOffset: (offset: number) => void;
  scrollElementRef: RefObject<HTMLDivElement | null>;
  typeFilter: string | null;
}) {
  const virtualizer = useVirtualizer({
    count: eventCount,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => 36,
    overscan: 24,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const first = virtualItems[0]?.index ?? 0;
  const last = virtualItems.at(-1)?.index ?? -1;
  const windowSize = Math.max(0, last + 1 - first);
  const rowsResult = useStreamQuery(
    database,
    typeFilter == null
      ? `SELECT local_index, offset, type, idempotency_key, created_at, inserted_at, json(raw_jsonb) AS raw_json
         FROM events
         WHERE local_index >= ? AND local_index < ?
         ORDER BY local_index ASC`
      : `SELECT local_index, offset, type, idempotency_key, created_at, inserted_at, json(raw_jsonb) AS raw_json
         FROM events
         WHERE type = ?
         ORDER BY local_index ASC
         LIMIT ? OFFSET ?`,
    typeFilter == null ? [first, last + 1] : [typeFilter, windowSize, first],
  );
  // Retain the last committed rows across range re-queries. When the visible
  // window shifts (append grows the list, or a scroll moves it), the range SQL
  // query is recreated and briefly reports `pending` carrying a *different*
  // range's rows. Rendering straight from that pending data blanks every
  // already-visible row to a grey skeleton for a frame. Keeping the last "ok"
  // rows means only genuinely-new indices fall back to a skeleton.
  const lastRowsRef = useRef<Map<number, StreamEventRow>>(new Map());
  const rowsByIndex = useMemo(() => {
    if (rowsResult.status !== "ok") return lastRowsRef.current;
    const rows = new Map<number, StreamEventRow>();
    rowsResult.data.forEach((row, position) => {
      const index = typeFilter == null ? Number(row.local_index) : first + position;
      if (Number.isFinite(index)) rows.set(index, row as StreamEventRow);
    });
    lastRowsRef.current = rows;
    return rows;
  }, [rowsResult.data, rowsResult.status, typeFilter, first]);

  if (eventCount === 0) {
    return <Centered>{emptyLabel}</Centered>;
  }

  return (
    <div className="px-4">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualItems.map((item) => {
          const row = rowsByIndex.get(item.index);
          return (
            <article
              className="absolute left-0 top-0 w-full border-b bg-background py-1.5 font-mono text-xs"
              // measureElement reads data-index to attribute heights to rows;
              // without it expanded rows keep their estimated size and the
              // JSON paints over the rows below.
              data-index={item.index}
              key={item.key}
              ref={virtualizer.measureElement}
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {row ? (
                <RawEventRow
                  expanded={expandedOffsets.has(Number(row.offset))}
                  onToggle={() => onToggleOffset(Number(row.offset))}
                  row={row}
                />
              ) : (
                <div className="h-6 rounded bg-muted" />
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function RawEventRow({
  expanded,
  onToggle,
  row,
}: {
  expanded: boolean;
  onToggle: () => void;
  row: StreamEventRow;
}) {
  return (
    <>
      <button
        aria-expanded={expanded}
        className="grid w-full cursor-pointer grid-cols-[64px_minmax(0,1fr)_auto] items-baseline gap-3 text-left text-muted-foreground hover:text-foreground"
        onClick={onToggle}
        type="button"
      >
        <span>#{row.offset}</span>
        <span className="truncate">{row.type}</span>
        <time>{row.created_at}</time>
      </button>
      {expanded ? (
        <SerializedObjectCodeBlock className="my-2" data={parseRawEventJson(row.raw_json)} />
      ) : null}
    </>
  );
}

function parseRawEventJson(rawJson: string): unknown {
  try {
    return JSON.parse(rawJson);
  } catch {
    return rawJson;
  }
}

// ---------------------------------------------------------------------------
// State view: live reduced + runtime processor state via runtimeState() RPC
// ---------------------------------------------------------------------------

const STATE_POLL_INTERVAL_MS = 1_000;

function ProjectStreamStateView({ store }: { store: StreamBrowserStore }) {
  const [runtimeState, setRuntimeState] = useState<StreamRuntimeState | null>(null);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const state = await store.runtimeState();
        if (!disposed) {
          // Keep the previous object identity when nothing changed so the
          // code block doesn't rebuild (and lose scroll) every poll tick.
          setRuntimeState((previous) =>
            previous != null && JSON.stringify(previous) === JSON.stringify(state)
              ? previous
              : state,
          );
          setError(undefined);
        }
      } catch (caught) {
        if (!disposed) setError(caught instanceof Error ? caught.message : String(caught));
      }
      if (!disposed) timer = setTimeout(() => void poll(), STATE_POLL_INTERVAL_MS);
    };
    void poll();

    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [store]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 px-4 py-2">
        <span className="text-xs font-semibold text-muted-foreground">Reduced processor state</span>
        <output className="font-mono text-xs text-muted-foreground">
          {runtimeState == null ? "loading" : "live"}
        </output>
      </div>
      {error == null ? null : (
        <p className="px-4 py-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {runtimeState == null ? (
          <Centered>Reading runtime state…</Centered>
        ) : (
          <SerializedObjectCodeBlock data={runtimeState} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center p-6 text-sm text-muted-foreground">
      {children}
    </div>
  );
}

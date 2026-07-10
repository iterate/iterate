import { useCallback, useMemo, useState, type ReactNode } from "react";
import { FilterIcon, XIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { Sheet, SheetContent, SheetTitle } from "@iterate-com/ui/components/sheet";
import { toast } from "@iterate-com/ui/components/sonner";
import type {
  AgentUiLlmStep,
  AgentUiState,
  AgentUiStep,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import type { Stream } from "../itx-api.generated.ts";
import {
  AGENT_UI_FEED_TABLE,
  AGENT_UI_SCHEMA_VERSION,
  AgentUiProcessor,
  AgentUiProcessorContract,
} from "~/domains/streams/client-libraries/processors/agent-ui-processor.ts";
import { parseBrowserCoreProcessorState } from "~/domains/streams/client-libraries/browser/core-processor-state.ts";
import { useStreamQuery } from "~/domains/streams/client-libraries/browser/hooks/use-stream-query.ts";
import { useStreamProcessorStore } from "~/domains/streams/client-libraries/browser/hooks/use-stream-processor-store.ts";
import type { StreamBrowserDatabase } from "~/domains/streams/client-libraries/browser/stream-browser-db.ts";
import { asBrowserStreamClient } from "~/domains/streams/client-libraries/browser/stream-browser-store.ts";
import {
  BROWSER_RAW_EVENTS_SCHEMA_VERSION,
  BrowserRawEventsContract,
  BrowserRawEventsProcessor,
  type BrowserRawEventsState,
} from "~/domains/streams/client-libraries/processors/browser-raw-events/implementation.ts";
import {
  BROWSER_EVENT_FEED_SCHEMA_VERSION,
  BROWSER_EVENT_FEED_TABLE,
  BrowserEventFeedContract,
  BrowserEventFeedProcessor,
  type BrowserEventFeedState,
} from "~/domains/streams/client-libraries/processors/browser-event-feed/implementation.ts";
import { AgentFeedView, AgentTokenUsageStrip } from "~/components/agent-feed.tsx";
import { FeedItemsView } from "~/components/feed-items-view.tsx";
import { RawEventInspectorPanel } from "~/components/raw-event-inspector-panel.tsx";
import { StreamFeedFilterRow } from "~/components/stream-feed-filters.tsx";
import {
  StreamProcessorsPanel,
  type StreamRuntimeDebugState,
} from "~/components/stream-processors-panel.tsx";
import {
  StreamViewComposer,
  type StreamInterrupt,
  type StreamMessageComposer,
} from "~/components/stream-view-composer.tsx";
import { StreamModeTabs, StreamViewHeader } from "~/components/stream-view-header.tsx";
import {
  defaultPresetForMode,
  feedItemsFilterFromSearch,
  presetsForStream,
} from "~/lib/stream-feed-filters.ts";
import { NULL_DURABLE_OBJECT_PROJECT_ID } from "~/lib/stream-navigation.ts";
import { useItx } from "~/itx/itx-react.tsx";
import { useSimulatedRttMetrics } from "~/lib/stream-presence.ts";
import {
  modeCapabilities,
  streamViewMode,
  useStreamViewPanels,
  useStreamViewSearch,
} from "~/lib/stream-view-search.ts";

type ItxStreamSource = (streamPath: string) => Stream | Promise<Stream>;

/**
 * The stream view: every domain page's main pane. Renders mode-owned feed
 * surfaces under the shared header (Pretty / Pretty+raw / Raw on agents),
 * with the composer below and right-edge overlays (raw-event inspector,
 * processors sheet) on top.
 *
 * This component is the orchestrator: it owns the three browser-hosted
 * processors that mirror the stream into local SQLite (raw events, agent UI,
 * grouped feed items) and hands their stores/databases to focused child
 * components. All view state (mode, filters, open panels) lives in the URL —
 * see ~/lib/stream-view-search.ts — so children read it themselves; the
 * component stays mounted across ⌘K stream switches (the switcher navigates
 * with an empty search, resetting the view to the new stream's defaults).
 */
export function ProjectStreamView({
  autoFocusMessageComposer = false,
  defaultComposerMode,
  emptyLabel = "No events in this stream yet.",
  layout = "split",
  messageComposer,
  panel,
  projectId,
  projectSlug,
  showHeader = true,
  streamSource,
  streamPath,
}: {
  autoFocusMessageComposer?: boolean;
  defaultComposerMode?: "message" | "raw";
  emptyLabel?: string;
  /**
   * "split" (default) shows the panel beside the feed; "fullPanel" hands the
   * panel the whole content area and relegates the feed (with its filter row,
   * tabs, and composer) to a sheet behind the header's Events button.
   */
  layout?: "split" | "fullPanel";
  messageComposer?: StreamMessageComposer;
  /**
   * The domain's reduced-state render (creation saga, settings forms, stream
   * tree, …), shown beside the stream under the shared header — every domain
   * object IS a stream, and its page is that stream's view. Left on large
   * screens, stacked on top on small ones. Omit for pure stream pages (agent
   * chat, raw stream browser).
   */
  panel?: ReactNode;
  projectId: string | null;
  projectSlug?: string;
  showHeader?: boolean;
  streamSource?: ItxStreamSource;
  streamPath: string;
}) {
  const itx = useItx();
  const streamRuntimeProjectKey = projectId ?? NULL_DURABLE_OBJECT_PROJECT_ID;
  const resolvedStreamSource = useMemo<ItxStreamSource>(
    () => streamSource ?? ((path) => itx.streams.get(path)),
    [itx, streamSource],
  );
  const streamClientFactory = useMemo(
    () => async (input: { streamPath: string }) =>
      asBrowserStreamClient(await resolvedStreamSource(input.streamPath), () => {}),
    [resolvedStreamSource],
  );

  // Three browser-hosted processors share the stream's per-path SQLite mirror:
  // the verbatim raw-event log (also the composer's append target), the agent
  // UI reduction (chat items + live activity + presence — mounted here, not in
  // the agent tab, because the header derives presence/busy from it), and the
  // grouped feed_items collection the Feed tab's presets filter over.
  const { store, snapshot } = useStreamProcessorStore<BrowserRawEventsState>({
    createStreamClient: streamClientFactory,
    projectId: streamRuntimeProjectKey,
    streamPath,
    slug: BrowserRawEventsContract.slug,
    schemaVersion: BROWSER_RAW_EVENTS_SCHEMA_VERSION,
    tables: ["events"],
    Processor: BrowserRawEventsProcessor,
  });
  const { store: agentStore, snapshot: agentSnapshot } = useStreamProcessorStore<AgentUiState>({
    createStreamClient: streamClientFactory,
    projectId: streamRuntimeProjectKey,
    streamPath,
    slug: AgentUiProcessorContract.slug,
    schemaVersion: AGENT_UI_SCHEMA_VERSION,
    resetOnSchemaVersionChange: true,
    tables: [AGENT_UI_FEED_TABLE],
    Processor: AgentUiProcessor,
  });
  const { store: feedStore } = useStreamProcessorStore<BrowserEventFeedState>({
    createStreamClient: streamClientFactory,
    projectId: streamRuntimeProjectKey,
    streamPath,
    slug: BrowserEventFeedContract.slug,
    schemaVersion: BROWSER_EVENT_FEED_SCHEMA_VERSION,
    tables: [BROWSER_EVENT_FEED_TABLE],
    Processor: BrowserEventFeedProcessor,
  });

  const countResult = useStreamQuery(store.streamDatabase, `SELECT COUNT(*) AS count FROM events`);
  const eventCount = Number(countResult.data[0]?.count ?? 0);
  const agentUiState = useAgentUiReducedState(store.streamDatabase);
  const metrics = useSimulatedRttMetrics();

  const { search } = useStreamViewSearch();
  const panels = useStreamViewPanels();
  const activeMode = streamViewMode(search, streamPath);
  const caps = modeCapabilities(search, streamPath);
  // Feed-items presets apply whenever the mode shows raw feed_items.
  const presets = useMemo(() => presetsForStream(streamPath), [streamPath]);
  const defaultPreset = defaultPresetForMode(streamPath, activeMode);
  const activePreset = caps.rawPresets
    ? (presets.find((preset) => preset.id === search.preset) ?? defaultPreset)
    : defaultPreset;
  const feedSearch = search.q ?? "";
  const rawFilter = feedItemsFilterFromSearch(search, streamPath);

  // The server is about to append: verify deliveries actually arrive and
  // reconnect within seconds if a subscription died silently — instead of
  // the user's message not appearing until the next paced probe (or a reload).
  const nudgeDeliveries = useCallback(() => {
    void store.nudge();
    void agentStore.nudge();
    void feedStore.nudge();
  }, [store, agentStore, feedStore]);

  const runningLlmRequestId =
    agentUiState?.live?.steps.find(isRunningLlmStep)?.llmRequestOffset ?? null;
  const interrupt = useAgentInterrupt({
    onInterrupt: messageComposer?.onInterrupt,
    runningLlmRequestId,
    onNudgeDeliveries: nudgeDeliveries,
  });

  async function clearClientDatabases() {
    // Sequential on purpose: the three runtimes share one per-path SQLite
    // mirror, and each clear deletes its tables and VACUUMs — interleaving
    // them would race writes and compactions on the same file.
    await feedStore.clearLocalDatabase();
    await agentStore.clearLocalDatabase();
    await store.clearLocalDatabase();
    window.location.reload();
  }

  const getProcessorRuntimeState = useCallback(
    async (subscriptionKey: string) => {
      const stream = await resolvedStreamSource(streamPath);
      const [runtimeState, streamRuntimeState] = await Promise.all([
        stream.getProcessorRuntimeState({ subscriptionKey }),
        stream.runtimeState(),
      ]);
      return {
        runtimeState,
        // The itx Stream.runtimeState() types coreProcessorState as
        // unknown; parse out the slice this panel needs.
        streamMaxOffset: parseBrowserCoreProcessorState(streamRuntimeState.coreProcessorState)
          .maxOffset,
      };
    },
    [resolvedStreamSource, streamPath],
  );
  const getStreamRuntimeState = useCallback(
    async (): Promise<StreamRuntimeDebugState> =>
      (await resolvedStreamSource(streamPath)).runtimeState(),
    [resolvedStreamSource, streamPath],
  );

  const connectionLabel =
    snapshot.connectionError ??
    (snapshot.connectionStatus === "subscribed" ? emptyLabel : snapshot.connectionStatus);
  // Busy = work is actively running, independent of chat-message timing.
  const agentBusy = agentUiState?.live?.steps.some((step) => step.status === "running") ?? false;
  const presence = agentUiState?.presence ?? [];
  const agentPauseControl = useAgentPauseControl({
    database: store.streamDatabase,
    resolvedStreamSource,
    streamPath,
    onNudgeDeliveries: nudgeDeliveries,
  });
  const streamKillControl = useStreamKillControl({
    resolvedStreamSource,
    streamPath,
    onNudgeDeliveries: nudgeDeliveries,
  });

  const filterRow =
    search.filter !== true ? null : (
      <StreamFeedFilterRow
        activePreset={activePreset}
        eventCount={eventCount}
        connectionStatus={snapshot.connectionStatus}
        feedDatabase={feedStore.streamDatabase}
        presets={presets}
        streamPath={streamPath}
      />
    );

  const agentFeed = caps.agentFeed ? (
    <AgentFeedView
      {...(interrupt != null && (agentUiState?.queuedUserMessages ?? []).length > 0
        ? { onInterruptQueuedMessages: interrupt.run }
        : {})}
      // Fresh virtualizer state per stream mirror + mode (see AgentFeedView docs).
      key={`${store.streamDatabase.databasePath}:${activeMode}:agent`}
      database={store.streamDatabase}
      liveState={agentUiState}
      search={feedSearch}
      showDebug={caps.agentShowDebug}
      emptyLabel={connectionLabel}
      isInterruptingQueuedMessages={interrupt?.isInterrupting ?? false}
      projectSlug={projectSlug}
      isPending={agentUiState == null && agentSnapshot.connectionStatus !== "subscribed"}
    />
  ) : null;

  const rawFeed = caps.rawFeed ? (
    <FeedItemsView
      key={`${feedStore.streamDatabase.databasePath}:${activeMode}:raw`}
      database={feedStore.streamDatabase}
      emptyLabel={connectionLabel}
      filter={rawFilter}
      onInspectEvent={panels.inspectEvent}
    />
  ) : null;

  // Mode body: Pretty = agent only; Raw = feed_items only; Pretty+raw = both
  // stacked (chat + full raw rail with click-to-inspect).
  const modeBody =
    caps.agentFeed && caps.rawFeed ? (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Both pane wrappers must be flex columns: the feeds size themselves
            with flex-1 and only scroll internally when a flex parent
            constrains them — in a block wrapper they grow to content height
            and the pane just clips them at the top. */}
        <div className="relative flex min-h-0 flex-[3] flex-col overflow-hidden border-b">
          {agentFeed}
        </div>
        <div className="relative flex min-h-0 flex-[2] flex-col overflow-hidden">
          <div className="flex h-7 shrink-0 items-center border-b bg-muted/30 px-4">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Raw events
            </span>
            <span className="ml-2 font-mono text-[10px] text-muted-foreground/70">
              click a row to inspect · arrow keys page
            </span>
          </div>
          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">{rawFeed}</div>
        </div>
      </div>
    ) : (
      (agentFeed ?? rawFeed)
    );

  // The feed column — mode body with overlays on top, composer below. One JSX
  // value so the split layout and the fullPanel Events sheet render the same
  // thing.
  const feedColumn = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {modeBody}
        {caps.eventInspector && panels.inspectedOffset != null ? (
          <RawEventInspectorPanel
            database={store.streamDatabase}
            offset={panels.inspectedOffset}
            onNavigate={panels.inspectEvent}
            onClose={panels.closeInspector}
          />
        ) : null}
      </div>

      <div className="shrink-0 px-4 pb-4 pt-2.5">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-1">
          {caps.agentFeed && agentUiState?.tokenUsage != null ? (
            <AgentTokenUsageStrip tokenUsage={agentUiState.tokenUsage} />
          ) : null}
          <StreamViewComposer
            autoFocusMessage={autoFocusMessageComposer}
            {...(defaultComposerMode == null
              ? caps.agentFeed
                ? { defaultMode: "message" as const }
                : { defaultMode: "raw" as const }
              : { defaultMode: defaultComposerMode })}
            interrupt={interrupt}
            {...(messageComposer == null ? {} : { messageComposer })}
            onNudgeDeliveries={nudgeDeliveries}
            presence={presence}
            store={store}
          />
        </div>
      </div>
    </div>
  );

  const processorsSheet = (
    <StreamProcessorsPanel
      open={panels.processorsPanelOpen}
      onOpenChange={(open) => {
        if (!open) panels.closeProcessorsPanel();
      }}
      presence={presence}
      metrics={metrics}
      eventCount={eventCount}
      busy={agentBusy}
      focusedKey={panels.focusedProcessorKey}
      onFocus={panels.focusProcessor}
      onBack={panels.openProcessorsOverview}
      onClose={panels.closeProcessorsPanel}
      onClearClientDatabase={clearClientDatabases}
      getProcessorRuntimeState={getProcessorRuntimeState}
      getStreamRuntimeState={getStreamRuntimeState}
    />
  );

  if (layout === "fullPanel") {
    return (
      <section className="flex min-h-0 flex-1 flex-col bg-background">
        <StreamViewHeader
          agentBusy={agentBusy}
          agentPause={agentPauseControl}
          eventsToggle={{ eventCount }}
          metrics={metrics}
          presence={presence}
          streamKill={streamKillControl}
          streamPath={streamPath}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{panel}</div>
        {processorsSheet}
        <StreamEventsSheet streamPath={streamPath}>
          {filterRow}
          {feedColumn}
        </StreamEventsSheet>
      </section>
    );
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-background">
      {showHeader ? (
        <StreamViewHeader
          agentBusy={agentBusy}
          agentPause={agentPauseControl}
          metrics={metrics}
          presence={presence}
          streamKill={streamKillControl}
          streamPath={streamPath}
        />
      ) : null}
      {showHeader ? filterRow : null}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
        {panel == null ? null : (
          <aside className="max-h-[45svh] min-h-0 shrink-0 overflow-y-auto border-b lg:max-h-none lg:w-[26rem] lg:border-b-0 lg:border-r">
            <div className="flex flex-col gap-4 p-4">{panel}</div>
          </aside>
        )}
        {feedColumn}
      </div>
      {processorsSheet}
    </section>
  );
}

/**
 * Full-panel layouts relegate the feed to this right-edge sheet behind the
 * header's Events button (`?events=true`). Children are the filter row +
 * feed column the split layout renders inline.
 */
function StreamEventsSheet({ children, streamPath }: { children: ReactNode; streamPath: string }) {
  const { search, setSearch } = useStreamViewSearch();
  const { eventsSheetOpen, openEventsSheet, closeEventsSheet } = useStreamViewPanels();
  return (
    <Sheet
      open={eventsSheetOpen}
      onOpenChange={(open) => (open ? openEventsSheet() : closeEventsSheet())}
    >
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl"
        showCloseButton={false}
      >
        <SheetTitle className="sr-only">Stream events for {streamPath}</SheetTitle>
        <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
            {streamPath}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <StreamModeTabs streamPath={streamPath} />
            <Button
              variant="ghost"
              size="icon"
              title="Search & filter"
              aria-expanded={search.filter === true}
              onClick={() => setSearch({ filter: search.filter === true ? undefined : true })}
              className="rounded-full text-muted-foreground"
            >
              <FilterIcon className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              title="Close events"
              onClick={closeEventsSheet}
              className="rounded-full text-muted-foreground"
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        </div>
        {children}
      </SheetContent>
    </Sheet>
  );
}

/**
 * The header's pause/resume affordance for agent streams — appends the
 * paused/resumed control events. Undefined on non-agent paths (no pause
 * semantics), so the header hides the action.
 */
function useAgentPauseControl(args: {
  database: StreamBrowserDatabase;
  resolvedStreamSource: ItxStreamSource;
  streamPath: string;
  onNudgeDeliveries: () => void;
}):
  | {
      paused: boolean;
      pending: boolean;
      reason: string | null;
      setPaused: (paused: boolean) => Promise<void>;
    }
  | undefined {
  const { database, resolvedStreamSource, streamPath, onNudgeDeliveries } = args;
  const pauseState = useStreamPauseState(database);
  const [pending, setPending] = useState(false);
  if (!streamPath.startsWith("/agents/")) return undefined;
  return {
    paused: pauseState.paused,
    reason: pauseState.reason,
    pending,
    setPaused: async (paused: boolean) => {
      if (pending) return;
      setPending(true);
      try {
        const stream = await resolvedStreamSource(streamPath);
        await stream.append({
          type: paused ? "events.iterate.com/stream/paused" : "events.iterate.com/stream/resumed",
          payload: {
            reason: paused ? "Paused by operator from the agent UI." : "Resumed by operator.",
          },
        });
        onNudgeDeliveries();
      } finally {
        setPending(false);
      }
    },
  };
}

/** The header's kill-stream action; "kill requested" from a prior kill still reads as success. */
function useStreamKillControl(args: {
  resolvedStreamSource: ItxStreamSource;
  streamPath: string;
  onNudgeDeliveries: () => void;
}): { kill: () => Promise<void>; pending: boolean } {
  const { resolvedStreamSource, streamPath, onNudgeDeliveries } = args;
  const [pending, setPending] = useState(false);
  return {
    pending,
    kill: async () => {
      if (pending) return;
      setPending(true);
      try {
        const stream = await resolvedStreamSource(streamPath);
        await stream.kill();
        toast.success("Stream killed");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.toLowerCase().includes("kill requested")) {
          toast.success("Stream killed");
        } else {
          toast.error(`Failed to kill stream: ${message}`);
          return;
        }
      } finally {
        setPending(false);
      }
      onNudgeDeliveries();
    },
  };
}

function isRunningLlmStep(step: AgentUiStep): step is AgentUiLlmStep {
  return step.kind === "llm" && step.status === "running";
}

/**
 * The interrupt affordance for the running agent turn, shared by the composer
 * and the agent feed's queued-messages banner. Null while nothing is running
 * (or the stream has no interrupt hook), so consumers can gate on existence.
 */
function useAgentInterrupt(args: {
  onInterrupt: ((llmRequestOffset: number) => Promise<void>) | undefined;
  runningLlmRequestId: number | null;
  onNudgeDeliveries: () => void;
}): StreamInterrupt | null {
  const [isInterrupting, setIsInterrupting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const { onInterrupt, runningLlmRequestId, onNudgeDeliveries } = args;

  // An interrupt error belongs to the turn it failed against; without this a
  // stale error would resurface on the NEXT turn (the hook returns null in
  // between, hiding it). State-adjust-during-render per react.dev — no effect.
  const [errorRequestId, setErrorRequestId] = useState(runningLlmRequestId);
  if (errorRequestId !== runningLlmRequestId) {
    setErrorRequestId(runningLlmRequestId);
    setError(undefined);
  }

  if (onInterrupt == null || runningLlmRequestId == null) return null;

  return {
    isInterrupting,
    ...(error == null ? {} : { error }),
    run: async () => {
      if (isInterrupting) return;
      setIsInterrupting(true);
      setError(undefined);
      try {
        await onInterrupt(runningLlmRequestId);
        onNudgeDeliveries();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setIsInterrupting(false);
      }
    },
  };
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

function useStreamPauseState(database: StreamBrowserDatabase): {
  paused: boolean;
  reason: string | null;
} {
  const result = useStreamQuery(
    database,
    `SELECT type, json_extract(raw_jsonb, '$.payload.reason') AS reason
     FROM events
     WHERE type IN ('events.iterate.com/stream/paused', 'events.iterate.com/stream/resumed')
     ORDER BY offset DESC
     LIMIT 1`,
  );
  const latest = result.data[0];
  const reason = latest == null || typeof latest.reason !== "string" ? null : latest.reason;
  return { paused: latest?.type === "events.iterate.com/stream/paused", reason };
}

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
import { parseBrowserCoreProcessorState } from "~/domains/streams/client-libraries/browser/core-processor-state.ts";
import { useStreamQuery } from "~/domains/streams/client-libraries/browser/hooks/use-stream-query.ts";
import { useStreamMirror } from "~/domains/streams/client-libraries/browser/hooks/use-stream-mirror.ts";
import type { StreamBrowserDatabase } from "~/domains/streams/client-libraries/browser/stream-browser-db.ts";
import type { StreamBrowserStore } from "~/domains/streams/client-libraries/browser/stream-browser-store.ts";
import { asBrowserStreamClient } from "~/domains/streams/client-libraries/browser/stream-transport.ts";
import { BrowserFeedContract } from "~/domains/streams/client-libraries/processors/browser-feed/implementation.ts";
import { QueuedMessagesPanel } from "~/components/agent-feed.tsx";
import { StreamFeedView } from "~/components/stream-feed-view.tsx";
import { RawEventInspectorPanel } from "~/components/raw-event-inspector-panel.tsx";
import { LlmRequestInspectorPanel } from "~/components/llm-request-inspector-panel.tsx";
import { StreamFeedFilterRow } from "~/components/stream-feed-filters.tsx";
import {
  StreamStatePanel,
  type StreamRuntimeDebugState,
} from "~/components/stream-state-panel.tsx";
import {
  StreamViewComposer,
  type StreamInterrupt,
  type StreamMessageComposer,
} from "~/components/stream-view-composer.tsx";
import { StreamModeTabs, StreamViewHeader } from "~/components/stream-view-header.tsx";
import { feedItemsFilterFromSearch } from "~/lib/stream-feed-filters.ts";
import { NULL_DURABLE_OBJECT_PROJECT_ID } from "~/lib/stream-navigation.ts";
import { connectSession, reportTransportSuspicion } from "~/itx/itx-react.tsx";
import { useBrowserStreamMetrics } from "~/lib/stream-presence.ts";
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
 * This component is the orchestrator: it owns the two browser-hosted
 * processors that mirror the stream into local SQLite (the raw `events` log
 * and the single `feed_items` projection) and hands their stores/databases to
 * focused child components. All view state (mode, filters, open panels) lives in the URL —
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
  resetStreamSourceTransport,
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
  /**
   * Evict the transport `streamSource` dials through when the stream runtimes
   * declare it dead (see BrowserStreamConnectionConfig.resetTransport). Pair
   * it with a custom `streamSource`; the default source wires its own.
   */
  resetStreamSourceTransport?: () => void;
  showHeader?: boolean;
  streamSource?: ItxStreamSource;
  streamPath: string;
}) {
  const streamRuntimeProjectKey = projectId ?? NULL_DURABLE_OBJECT_PROJECT_ID;
  // The stream mirror rides the ONE shared session socket — the same connection
  // the page's ordinary queries use. It can page tens of thousands of historical
  // events and owns an aggressive reconnect loop, but it NEVER closes the shared
  // socket itself: on a suspected half-open transport it REPORTS the suspicion to
  // the socket-owned verifier ({@link reportTransportSuspicion}), the only thing
  // that may retire the shared socket — and only after two failed probes against
  // the same generation. That is what lets the mirror share the socket without
  // re-introducing the failure where resetting the mirror rejected a concurrent
  // Repo.readFile and blanked the whole task board.
  //
  // Resolve the session PER CALL (never `useItx()`): the stream view's shell —
  // header, tabs, composer, panel — must paint before the socket connects (a
  // hook read here would suspend the whole view), and the runtimes this source
  // feeds outlive the render — a captured capnweb stub pins whatever transport
  // it was born on, so after a suspend/resume killed that socket every reconnect
  // would ride the corpse and the feed would wedge until a reload (the repro in
  // specs/stream-resume-after-suspend.spec.ts). `connectSession()` returns the
  // CURRENT generation each call.
  const resolvedStreamSource = useMemo<ItxStreamSource>(
    () =>
      streamSource ??
      (async (path) => {
        const session = await connectSession();
        return projectId == null
          ? session.streams.get(path)
          : session.projects.get(projectId).streams.get(path);
      }),
    [projectId, streamSource],
  );
  const streamClientFactory = useMemo(() => {
    if (streamSource !== undefined) {
      // Custom source: its own transport, so no default suspicion wiring — the
      // runtime falls back to resetStreamSourceTransport.
      return async (input: { streamPath: string }) => {
        const stub = await streamSource(input.streamPath);
        // The stub's REAL dispose, so every reconnect releases its stream export
        // instead of stranding one per reconnect in the cap table on both sides.
        return asBrowserStreamClient(stub, () => (stub as Partial<Disposable>)[Symbol.dispose]?.());
      };
    }
    return async (input: { streamPath: string }) => {
      const session = await connectSession();
      const stub =
        projectId == null
          ? session.streams.get(input.streamPath)
          : session.projects.get(projectId).streams.get(input.streamPath);
      return asBrowserStreamClient(
        stub,
        () => (stub as Partial<Disposable>)[Symbol.dispose]?.(),
        // Report suspicion — NEVER close the shared socket directly. The
        // socket-owned verifier retires it only if it is genuinely half-open.
        reportTransportSuspicion,
      );
    };
  }, [projectId, streamSource]);
  // Half-open recovery: a suspended page's socket can die without a close frame,
  // so per-call dialing alone can't recover it. When the runtimes' probes/dials
  // time out they call this, which reports the suspicion to the shared socket's
  // verifier rather than evicting anything itself. A custom streamSource brings
  // its own resetTransport (or none).
  const resetTransport = useMemo(
    () =>
      resetStreamSourceTransport ??
      (streamSource === undefined ? reportTransportSuspicion : undefined),
    [resetStreamSourceTransport, streamSource],
  );

  // The stream mirror: one download of this stream into the shared per-path
  // SQLite mirror, fanned out to the canonical processors — the verbatim
  // raw-event `events` log (also the composer's append target) and the
  // browser-feed projector, whose single `feed_items` table backs every mode
  // (pretty chat rows and raw rows in one total order) and whose reduced state
  // carries the live activity + presence the header derives presence/busy from.
  // All four tables live in the one `store.streamDatabase`.
  const { store, snapshot } = useStreamMirror({
    createStreamClient: streamClientFactory,
    ...(resetTransport === undefined ? {} : { resetTransport }),
    projectId: streamRuntimeProjectKey,
    streamPath,
  });

  // Trigger-maintained counts (O(#types)) instead of COUNT(*) (full mirror
  // scan): this query re-runs after every delivered batch and shares the one
  // OPFS connection with ingest writes — see the raw-events processor schema.
  const countResult = useStreamQuery(
    store.streamDatabase,
    `SELECT COALESCE(SUM(n), 0) AS count FROM event_type_counts`,
  );
  const eventCount = Number(countResult.data[0]?.count ?? 0);
  const agentUiState = useAgentUiReducedState(store.streamDatabase);
  // Real, browser-measured: transport RTT from RPCs the store already makes,
  // plus the hosted processor's self-measured consumption report.
  const metrics = useBrowserStreamMetrics(store);

  const { search } = useStreamViewSearch();
  const panels = useStreamViewPanels();
  const activeMode = streamViewMode(search, streamPath);
  const caps = modeCapabilities(search, streamPath);
  // Trimmed: a whitespace-only query must read as "no filter", not a LIKE
  // pattern of spaces that hides every row.
  const feedSearch = (search.q ?? "").trim();
  const rawFilter = feedItemsFilterFromSearch(search, streamPath);

  // The server is about to append: verify deliveries actually arrive and
  // reconnect within seconds if a subscription died silently — instead of
  // the user's message not appearing until the next paced probe (or a reload).
  const nudgeDeliveries = useCallback(() => {
    void store.nudge();
  }, [store]);

  const runningLlmRequestId =
    agentUiState?.live?.steps.find(isRunningLlmStep)?.llmRequestOffset ?? null;
  const interrupt = useAgentInterrupt({
    onInterrupt: messageComposer?.onInterrupt,
    runningLlmRequestId,
    onNudgeDeliveries: nudgeDeliveries,
  });

  async function clearClientDatabases() {
    // One mirror now: clear all canonical tables + checkpoints and reload.
    await store.clearLocalDatabase();
    window.location.reload();
  }

  const { getProcessorRuntimeState, getStreamRuntimeState } = useProcessorsPanelDebugState({
    resolvedStreamSource,
    store,
    streamPath,
  });

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
        eventCount={eventCount}
        connectionStatus={snapshot.connectionStatus}
        feedDatabase={store.streamDatabase}
        streamPath={streamPath}
      />
    );

  // Mode body: ONE virtualized list over feed_items for every mode — Pretty
  // shows agent rows, Raw shows raw rows, Pretty+raw both interleaved in
  // local_index order (raw rows click through to the inspector).
  const modeBody = (
    <StreamFeedView
      // Fresh virtualizer state per stream mirror + mode (see StreamFeedView docs).
      key={`${store.streamDatabase.databasePath}:${activeMode}`}
      database={store.streamDatabase}
      filter={{
        agent: caps.agentFeed
          ? { showDebug: caps.agentShowDebug, searchQuery: feedSearch === "" ? null : feedSearch }
          : null,
        raw: caps.rawFeed ? rawFilter : null,
      }}
      liveState={caps.agentFeed ? agentUiState : null}
      {...(caps.eventInspector ? { onInspectEvent: panels.inspectEvent } : {})}
      {...(caps.agentFeed ? { onInspectLlmRequest: panels.inspectLlmRequest } : {})}
      emptyLabel={connectionLabel}
      projectSlug={projectSlug}
      isPending={agentUiState == null && snapshot.connectionStatus !== "subscribed"}
    />
  );

  const queuedUserMessages = caps.agentFeed ? (agentUiState?.queuedUserMessages ?? []) : [];

  // The feed column — mode body with overlays on top, composer below. One JSX
  // value so the split layout and the fullPanel Events sheet render the same
  // thing.
  const feedColumn = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {modeBody}
        <StreamInspectorOverlay caps={caps} panels={panels} database={store.streamDatabase} />
      </div>

      <div className="shrink-0 px-4 pb-2.5 pt-2.5">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5">
          <div>
            {/* Queued messages are part of the composer: the panel tucks
                behind the pill (painted first, overlapped via its negative
                bottom margin) and grows the composer column, which the feed's
                stick-to-bottom already follows on viewport resize. */}
            <QueuedMessagesPanel
              messages={queuedUserMessages}
              isInterrupting={interrupt?.isInterrupting ?? false}
              {...(interrupt == null ? {} : { onInterrupt: interrupt.run })}
            />
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
    </div>
  );

  const streamStateSheet = (
    <StreamStatePanel
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
      streamPath={streamPath}
      tokenUsage={caps.agentFeed ? (agentUiState?.tokenUsage ?? null) : null}
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
        {streamStateSheet}
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
      {streamStateSheet}
    </section>
  );
}

/**
 * The feed's right-edge inspector, or nothing. At most one inspector holds
 * the edge (useStreamViewPanels keeps their URL keys mutually exclusive):
 * the raw-event inspector when the mode offers it and `?event=` is set,
 * else the LLM request inspector when `?llmRequest=` is set — the latter in
 * EVERY mode, so a shared link works regardless of the viewer's tab. Both
 * read the RAW events mirror (not feed_items): the fold reads the journal,
 * the same source the processor read.
 */
function StreamInspectorOverlay({
  caps,
  panels,
  database,
}: {
  caps: ReturnType<typeof modeCapabilities>;
  panels: ReturnType<typeof useStreamViewPanels>;
  database: StreamBrowserDatabase;
}) {
  if (caps.eventInspector && panels.inspectedOffset != null) {
    return (
      <RawEventInspectorPanel
        database={database}
        offset={panels.inspectedOffset}
        onNavigate={panels.inspectEvent}
        onClose={panels.closeInspector}
      />
    );
  }
  if (panels.inspectedLlmRequestOffset != null) {
    return (
      <LlmRequestInspectorPanel
        database={database}
        llmRequestOffset={panels.inspectedLlmRequestOffset}
        onClose={panels.closeLlmRequestInspector}
      />
    );
  }
  return null;
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
        className="flex w-full flex-col gap-0 p-0 data-[side=right]:sm:w-[56vw] data-[side=right]:sm:max-w-[92vw]"
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
 * The processors sheet's on-demand debug accessors: server-side runtime state
 * for one processor subscription (plus the stream's max offset for lag math)
 * and for the stream itself. Dialed fresh per call — debug reads must see the
 * server's CURRENT state, not a cached snapshot.
 */
function useProcessorsPanelDebugState(args: {
  resolvedStreamSource: ItxStreamSource;
  store: StreamBrowserStore;
  streamPath: string;
}) {
  const { resolvedStreamSource, store, streamPath } = args;
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
  // Through the store's leader socket, not a fresh dial: the same call then
  // doubles as a transport-RTT sample for the header/panel metrics.
  const getStreamRuntimeState = useCallback(
    (): Promise<StreamRuntimeDebugState> => store.debugRuntimeState(),
    [store],
  );
  return { getProcessorRuntimeState, getStreamRuntimeState };
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
 * The browser-feed projector persists its reduced state — whose `agent` slice
 * holds the live activity with streaming text and the presence roster — to
 * `processor_progress` on every checkpoint; reading it reactively is how the
 * live tail re-renders per delta batch. Null until the projector's first
 * checkpoint lands.
 */
function useAgentUiReducedState(database: StreamBrowserDatabase): AgentUiState | null {
  const result = useStreamQuery(
    database,
    // subscription_key is part of the primary key, so multiple rows can exist
    // for the slug (e.g. after a key-format change); read the most advanced one.
    `SELECT reduced_state FROM processor_progress WHERE processor_slug = ?
     ORDER BY acknowledged_through_offset DESC LIMIT 1`,
    [BrowserFeedContract.slug],
  );
  return useMemo(() => {
    const raw = result.data[0]?.reduced_state;
    if (typeof raw !== "string") return null;
    try {
      return (JSON.parse(raw) as { agent?: AgentUiState }).agent ?? null;
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

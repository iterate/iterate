import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
  type ComponentProps,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { FilterIcon, XIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { useAuthClient } from "@iterate-com/auth/client";
import { Sheet, SheetContent, SheetTitle } from "@iterate-com/ui/components/sheet";
import { toast } from "@iterate-com/ui/components/sonner";
import {
  isAgentUiActivityWorking,
  type AgentUiLlmStep,
  type AgentUiRuntimeTransition,
  type AgentUiStep,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import { connectItx, connectIterateSession, reportTransportSuspicion } from "iterate/sdk/itx/react";
import { useLiveState } from "iterate/sdk/capnweb/react";
import type { Stream } from "../itx-api.generated.ts";
import type { FeedLiveState } from "~/domains/streams/feed-contract.ts";
import { useStreamQuery } from "~/domains/streams/client-libraries/browser/hooks/use-stream-query.ts";
import { useEventSynchronizedLiveState } from "~/domains/streams/client-libraries/browser/hooks/use-event-synchronized-live-state.ts";
import { useBrowserStreamStore } from "~/domains/streams/client-libraries/browser/hooks/use-browser-stream-store.ts";
import type { StreamBrowserDatabase } from "~/domains/streams/client-libraries/browser/stream-browser-db.ts";
import { asBrowserStreamClient } from "~/domains/streams/client-libraries/browser/stream-transport.ts";
import { QueuedMessagesPanel } from "~/components/agent-feed.tsx";
import { DeferredSurface } from "~/components/deferred-surface.tsx";
import { StreamFeedView } from "~/components/stream-feed-view.tsx";
import { RawEventInspectorContent } from "~/components/raw-event-inspector-panel.tsx";
import { LlmRequestInspectorContent } from "~/components/llm-request-inspector-panel.tsx";
import { ScriptExecutionInspectorContent } from "~/components/script-execution-inspector-panel.tsx";
import { StreamFeedFilterRow } from "~/components/stream-feed-filters.tsx";
import { StreamStatePanel } from "~/components/stream-state-panel.tsx";
import {
  StreamViewComposer,
  type StreamInterrupt,
  type StreamMessageComposer,
} from "~/components/stream-view-composer.tsx";
import {
  StreamModeTabs,
  StreamStateButton,
  StreamViewHeader,
} from "~/components/stream-view-header.tsx";
import { feedItemsFilterFromSearch } from "~/lib/stream-feed-filters.ts";
import { NULL_DURABLE_OBJECT_PROJECT_ID } from "~/lib/stream-navigation.ts";
import { useBrowserStreamMetrics, type BrowserStreamMetricsView } from "~/lib/stream-presence.ts";
import {
  modeCapabilities,
  streamViewMode,
  useStreamViewPanels,
  useStreamViewSearch,
} from "~/lib/stream-view-search.ts";
import type { BrowserStreamSubscriberUser } from "~/domains/streams/client-libraries/browser/browser-subscriber.ts";

type ItxStreamSource = (streamPath: string) => Stream | Promise<Stream>;

type ProjectStreamViewProps = {
  /**
   * Runtime supplied by a parent which already listens to the selected agent's
   * live state. `undefined` lets this generic stream view open its own listener;
   * `null` means the parent has no transition yet.
   */
  agentRuntimeTransition?: AgentUiRuntimeTransition | null;
  autoFocusMessageComposer?: boolean;
  /** Domain identity shown directly below the generic stream header. */
  contextHeader?: ReactNode;
  defaultComposerMode?: "message" | "raw";
  emptyLabel?: string | null;
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
};

const EMPTY_STREAM_METRICS: BrowserStreamMetricsView = {
  spark: [],
  transportRttMs: null,
  eventConsumption: undefined,
};

/**
 * The stream view: every domain page's main pane. Renders mode-owned feed
 * surfaces under the shared header (Pretty / Pretty+raw / Raw on agents),
 * with the composer below and standard right-edge sheets (inspectors and
 * processor state) on top.
 *
 * This component renders server-owned feed state and immutable publications
 * synchronized into local SQLite. All view state (mode, filters, open panels) lives in the URL —
 * see ~/lib/stream-view-search.ts — so children read it themselves; the
 * component stays mounted across ⌘K stream switches (the switcher navigates
 * with an empty search, resetting the view to the new stream's defaults).
 */
export function ProjectStreamView(props: ProjectStreamViewProps) {
  if (props.layout === "fullPanel") return <FullPanelProjectStreamView {...props} />;
  return <BrowserDatabaseProjectStreamView {...props} />;
}

/**
 * Full-panel domain pages keep their stream available as a secondary Events
 * sheet without paying for its historical download, local SQLite database, or
 * open event connection while that sheet is closed.
 */
function FullPanelProjectStreamView({
  contextHeader,
  panel,
  streamPath,
  ...databaseProps
}: ProjectStreamViewProps) {
  const panels = useStreamViewPanels();
  const databaseActive = panels.eventsSheetOpen || panels.processorsPanelOpen;

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-background">
      <StreamViewHeader
        agentBusy={false}
        eventsToggle={{}}
        metrics={EMPTY_STREAM_METRICS}
        presence={[]}
        streamPath={streamPath}
      />
      {contextHeader}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{panel}</div>
      <DeferredSurface active={databaseActive}>
        <BrowserDatabaseProjectStreamView
          {...databaseProps}
          contextHeader={contextHeader}
          layout="fullPanel"
          panel={panel}
          streamPath={streamPath}
        />
      </DeferredSurface>
    </section>
  );
}

function BrowserDatabaseProjectStreamView({
  agentRuntimeTransition: suppliedAgentRuntimeTransition,
  autoFocusMessageComposer = false,
  defaultComposerMode,
  emptyLabel = "No events in this stream yet.",
  contextHeader,
  layout = "split",
  messageComposer,
  panel,
  projectId,
  projectSlug,
  resetStreamSourceTransport,
  showHeader = true,
  streamSource,
  streamPath,
}: ProjectStreamViewProps) {
  const subscriberUser = useStreamSubscriberUser();
  const streamData = useProjectStreamData({
    projectId,
    resetStreamSourceTransport,
    subscriberUser,
    streamSource,
    streamPath,
  });
  const { resolvedStreamSource, store, snapshot, eventCount, feed, presentedFeed } = streamData;

  useClaimReplyPresented({ database: store.streamDatabase, projectId, streamPath });
  const agentUiState = presentedFeed?.agent ?? null;
  // Real, browser-measured: transport RTT from RPCs the store already makes,
  // plus the hosted processor's self-measured consumption report.
  const metrics = useBrowserStreamMetrics(store);

  const { search } = useStreamViewSearch();
  const panels = useStreamViewPanels();
  const caps = modeCapabilities(search, streamPath);
  // The server is about to append: verify deliveries actually arrive and
  // reconnect within seconds if the event connection died silently — instead of
  // the user's message not appearing until the next paced probe (or a reload).
  const nudgeDeliveries = useCallback(() => {
    void store.nudge();
  }, [store]);

  const agentRuntimeTransition = suppliedAgentRuntimeTransition ?? presentedFeed?.runtimeChange;
  const agentRuntime = agentRuntimeTransition?.runtime;

  const runningLlmRequestId = agentUiState?.live?.steps.find(isRunningLlmStep)?.llmRequestOffset;
  const interrupt = useAgentInterrupt({
    onInterrupt: messageComposer?.onInterrupt,
    runningLlmRequestId,
    onNudgeDeliveries: nudgeDeliveries,
  });

  async function clearClientDatabases() {
    // One local database now: clear the event cache and synchronization cursor, then reload.
    await store.clearLocalDatabase();
    window.location.reload();
  }

  const { getProcessorRuntimeState } = useProcessorsPanelDebugState({
    resolvedStreamSource,
    streamPath,
  });

  // Live state uses this tab's transport even when another tab owns event sync.
  // Database ownership alone says nothing about whether writes can reach the server.
  const streamTransportReady = feed.status === "live";
  // Busy = work is actively running, independent of chat-message timing.
  const agentBusy = isAgentUiActivityWorking(agentUiState?.live ?? null, agentRuntime);
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

  const feedColumn = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <ProjectStreamFeed
          data={streamData}
          runtime={agentRuntime}
          emptyLabel={emptyLabel}
          streamPath={streamPath}
          projectSlug={projectSlug}
        />
        <StreamInspectorSheet
          agentUiState={agentUiState}
          streamSource={resolvedStreamSource}
          streamPath={streamPath}
          caps={caps}
          panels={panels}
          database={store.streamDatabase}
        />
      </div>

      {layout === "fullPanel" ? null : (
        <StreamComposerFooter
          autoFocusMessage={autoFocusMessageComposer}
          defaultComposerMode={defaultComposerMode}
          interrupt={interrupt}
          messageComposer={messageComposer}
          onNudgeDeliveries={nudgeDeliveries}
          presence={presence}
          store={store}
          disabled={!streamTransportReady}
          agentFeed={caps.agentFeed}
          agentUiState={agentUiState}
          eventCount={eventCount}
          connectionStatus={snapshot.connectionStatus}
          connectionError={snapshot.connectionError}
        />
      )}
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
      projectId={projectId}
      streamPath={streamPath}
      tokenUsage={caps.agentFeed ? (agentUiState?.tokenUsage ?? null) : null}
    />
  );

  if (layout === "fullPanel") {
    return (
      <>
        {streamStateSheet}
        <StreamEventsSheet streamPath={streamPath} metrics={metrics}>
          {filterRow}
          {feedColumn}
        </StreamEventsSheet>
      </>
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
      {showHeader ? contextHeader : null}
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

/** Reads URL-owned modes and filters against the synchronized stream presentation. */
function ProjectStreamFeed({
  data,
  runtime,
  emptyLabel,
  streamPath,
  projectSlug,
}: {
  data: ReturnType<typeof useProjectStreamData>;
  runtime: AgentUiRuntimeTransition["runtime"] | undefined;
  emptyLabel: ProjectStreamViewProps["emptyLabel"];
  streamPath: string;
  projectSlug: ProjectStreamViewProps["projectSlug"];
}) {
  const { store, snapshot, eventCount, feed, presentedFeed } = data;
  const agentUiState = presentedFeed?.agent ?? null;
  const { search } = useStreamViewSearch();
  const panels = useStreamViewPanels();
  const activeMode = streamViewMode(search, streamPath);
  const caps = modeCapabilities(search, streamPath);
  const feedSearch = (search.q ?? "").trim();
  const rawFilter = feedItemsFilterFromSearch(search, streamPath);
  // Cached rows can paint immediately. Readers share the writer's database;
  // an empty writer waits until reconciliation and callback setup complete.
  const streamContentsReady =
    eventCount > 0 ||
    snapshot.databaseRole === "reader" ||
    snapshot.connectionStatus === "receiving-events";
  const error = snapshot.connectionError ?? feed.error;
  return (
    <StreamFeedView
      key={`${store.streamDatabase.databasePath}:${activeMode}`}
      database={store.streamDatabase}
      filter={{
        agent: caps.agentFeed
          ? { showDebug: caps.agentShowDebug, searchQuery: feedSearch || null }
          : null,
        raw: caps.rawFeed ? rawFilter : null,
      }}
      liveState={agentUiState}
      runtime={runtime}
      onInspectEvent={panels.inspectEvent}
      onInspectLlmRequest={panels.inspectLlmRequest}
      onInspectScriptExecution={panels.inspectScriptExecution}
      emptyLabel={error ?? (streamContentsReady ? emptyLabel : snapshot.connectionStatus)}
      projectSlug={projectSlug}
      isPending={caps.agentFeed ? agentUiState == null : !streamContentsReady}
      pendingLabel={error ?? (caps.agentFeed ? "Initializing agent" : undefined)}
    />
  );
}

/** Keeps cached-connection feedback and queued input attached to the composer. */
function StreamComposerFooter({
  agentFeed,
  agentUiState,
  defaultComposerMode,
  eventCount,
  connectionStatus,
  connectionError,
  ...composer
}: Omit<ComponentProps<typeof StreamViewComposer>, "defaultMode"> & {
  agentFeed: boolean;
  agentUiState: FeedLiveState["agent"] | null;
  defaultComposerMode: ProjectStreamViewProps["defaultComposerMode"];
  eventCount: number;
  connectionStatus: string;
  connectionError: string | undefined;
}) {
  const defaultMode = defaultComposerMode ?? (agentFeed ? "message" : "raw");
  const queuedMessages = agentFeed ? (agentUiState?.queuedUserMessages ?? []) : [];
  return (
    <div className="shrink-0 px-4 pb-2.5 pt-2.5">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5">
        {eventCount > 0 && composer.disabled ? (
          <p
            className="px-4 text-xs text-muted-foreground"
            data-testid="stream-cache-status"
            role="status"
          >
            Showing cached events while
            {connectionStatus === "reconnecting" || connectionError != null
              ? " reconnecting…"
              : " connecting…"}
          </p>
        ) : null}
        <div>
          {/* Queued input grows the composer column, which the feed follows on resize. */}
          <QueuedMessagesPanel
            messages={queuedMessages}
            isInterrupting={composer.interrupt?.isInterrupting ?? false}
            onInterrupt={composer.disabled ? undefined : composer.interrupt?.run}
          />
          <StreamViewComposer defaultMode={defaultMode} {...composer} />
        </div>
      </div>
    </div>
  );
}

function useStreamSubscriberUser() {
  const { session: authSession } = useAuthClient();
  const subscriberUser = useMemo<BrowserStreamSubscriberUser | undefined>(() => {
    if (!authSession?.authenticated) return undefined;
    const name = authSession.user.name?.trim();
    const picture = authSession.user.picture?.trim();
    return {
      id: authSession.user.id,
      email: authSession.user.email,
      ...(name === undefined || name === "" ? {} : { name }),
      ...(picture === undefined || picture === "" ? {} : { picture }),
    };
  }, [authSession]);
  return subscriberUser;
}

/** Owns the server live snapshot and local event mirror, including their publication barrier. */
function useProjectStreamData({
  projectId,
  resetStreamSourceTransport,
  streamSource,
  subscriberUser,
  streamPath,
}: Pick<
  ProjectStreamViewProps,
  "projectId" | "resetStreamSourceTransport" | "streamSource" | "streamPath"
> & { subscriberUser?: BrowserStreamSubscriberUser }) {
  const streamRuntimeProjectKey = projectId ?? NULL_DURABLE_OBJECT_PROJECT_ID;
  // The browser stream database receives events over the ONE shared session socket — the same connection
  // the page's ordinary queries use. It can page tens of thousands of historical
  // events and owns an aggressive reconnect loop, but it NEVER closes the shared
  // socket itself: on a suspected half-open transport it REPORTS the suspicion to
  // the socket-owned verifier ({@link reportTransportSuspicion}), the only thing
  // that may retire the shared socket — and only after two failed probes against
  // the same generation.
  //
  // Resolve the session PER CALL (never `useItx()`): these runtimes outlive the
  // render, so capturing a capnweb stub would pin a dead transport after resume.
  const resolvedStreamSource = useMemo<ItxStreamSource>(
    () =>
      streamSource ??
      (async (path) =>
        projectId == null
          ? (await connectIterateSession()).streams.get(path)
          : (await connectItx(projectId)).streams.get(path)),
    [projectId, streamSource],
  );
  const streamClientFactory = useMemo(() => {
    if (streamSource !== undefined) {
      return async (input: { streamPath: string }) => {
        const stub = await streamSource(input.streamPath);
        return asBrowserStreamClient(stub, () => (stub as Partial<Disposable>)[Symbol.dispose]?.());
      };
    }
    return async (input: { streamPath: string }) => {
      const stub =
        projectId == null
          ? (await connectIterateSession()).streams.get(input.streamPath)
          : (await connectItx(projectId)).streams.get(input.streamPath);
      return asBrowserStreamClient(
        stub,
        () => (stub as Partial<Disposable>)[Symbol.dispose]?.(),
        // Report suspicion; the socket-owned verifier alone may retire the
        // shared socket, and only after proving it is genuinely half-open.
        reportTransportSuspicion,
      );
    };
  }, [projectId, streamSource]);
  const resetTransport = useMemo(
    () =>
      resetStreamSourceTransport ??
      (streamSource === undefined ? reportTransportSuspicion : undefined),
    [resetStreamSourceTransport, streamSource],
  );
  // One event mirror is shared by every view of this stream in the tab.
  const browserStore = useBrowserStreamStore({
    createStreamClient: streamClientFactory,
    ...(resetTransport === undefined ? {} : { resetTransport }),
    projectId: streamRuntimeProjectKey,
    ...(subscriberUser === undefined ? {} : { subscriberUser }),
    streamPath,
  });
  const { store } = browserStore;
  // Trigger-maintained counts (O(#types)) instead of COUNT(*) (full local-table
  // scan): this query re-runs after every delivered batch and shares the one
  // OPFS connection with ingest writes — see the event mirror schema.
  const countResult = useStreamQuery(
    store.streamDatabase,
    `SELECT COALESCE(SUM(n), 0) AS count FROM event_type_counts`,
  );
  const eventCount = Number(countResult.data[0]?.count ?? 0);
  const makeFeedConnection = useCallback(
    () => resolvedStreamSource(streamPath),
    [resolvedStreamSource, streamPath],
  );
  const feed = useLiveState(
    (stream: Stream) => stream.feedLiveState,
    (state) => state,
    [streamPath],
    { makeConnection: makeFeedConnection },
  );
  const presentedFeed = useEventSynchronizedLiveState(store.streamDatabase, feed.value);
  return { resolvedStreamSource, ...browserStore, eventCount, feed, presentedFeed };
}

/**
 * The feed's standard right-edge inspector sheet. At most one inspector holds
 * the edge (useStreamViewPanels keeps their URL keys mutually exclusive):
 * the raw-event inspector when the mode offers it and `?event=` is set,
 * else an LLM or script inspector when its deep-link parameter is set — in
 * EVERY mode, so a shared link works regardless of the viewer's tab. All
 * inspectors read the raw `events` table (not `feed_items`): the fold reads the journal,
 * the same source the processor read.
 */
function StreamInspectorSheet({
  agentUiState,
  streamSource,
  streamPath,
  caps,
  panels,
  database,
}: {
  agentUiState: FeedLiveState["agent"] | null;
  streamSource: ItxStreamSource;
  streamPath: string;
  caps: ReturnType<typeof modeCapabilities>;
  panels: ReturnType<typeof useStreamViewPanels>;
  database: StreamBrowserDatabase;
}) {
  const activeInspector = useMemo<
    | { kind: "event"; offset: number }
    | { kind: "llm"; offset: number }
    | { kind: "script"; executionId: string }
    | null
  >(() => {
    if (caps.eventInspector && panels.inspectedOffset != null) {
      return { kind: "event", offset: panels.inspectedOffset };
    }
    if (panels.inspectedLlmRequestOffset != null) {
      return { kind: "llm", offset: panels.inspectedLlmRequestOffset };
    }
    if (panels.inspectedScriptExecutionId != null) {
      return { kind: "script", executionId: panels.inspectedScriptExecutionId };
    }
    return null;
  }, [
    caps.eventInspector,
    panels.inspectedLlmRequestOffset,
    panels.inspectedOffset,
    panels.inspectedScriptExecutionId,
  ]);
  const activeInspectorContext = useMemo(
    () =>
      activeInspector == null
        ? null
        : {
            inspector: activeInspector,
            database,
            agentUiState,
            streamSource,
            streamPath,
          },
    [activeInspector, agentUiState, database, streamSource, streamPath],
  );
  const [retainedInspectorContext, setRetainedInspectorContext] = useState(activeInspectorContext);
  const activeInspectorKey =
    activeInspector?.kind === "script"
      ? `script:${activeInspector.executionId}`
      : activeInspector == null
        ? null
        : `${activeInspector.kind}:${activeInspector.offset}`;
  // Base UI reports dismissal before TanStack Router commits the URL search
  // update. Suppress that exact inspector immediately so retained exit content
  // cannot navigate and write its deep link back during the closing frame.
  // Keep suppression latched past animation completion if the router is slow;
  // release it only after the URL actually leaves this selection.
  const [dismissedInspectorKey, setDismissedInspectorKey] = useState<string | null>(null);
  const inspectorOpen = activeInspectorKey != null && activeInspectorKey !== dismissedInspectorKey;

  useEffect(() => {
    if (dismissedInspectorKey != null && activeInspectorKey !== dismissedInspectorKey) {
      setDismissedInspectorKey(null);
    }
  }, [activeInspectorKey, dismissedInspectorKey]);

  // Base UI keeps the popup mounted for its exit transition. Retain the last
  // target and the stream data it belongs to while URL-driven navigation
  // closes the sheet, so a stream switch cannot briefly query the new stream
  // with the previous stream's inspector identifier.
  useEffect(() => {
    if (activeInspectorContext != null) setRetainedInspectorContext(activeInspectorContext);
  }, [activeInspectorContext]);

  const inspectorContext = activeInspectorContext ?? retainedInspectorContext;
  let content: ReactNode = null;
  let testId: string | undefined;

  if (inspectorContext != null) {
    const { inspector } = inspectorContext;
    if (inspector.kind === "event") {
      testId = "raw-event-inspector";
      content = (
        <RawEventInspectorContent
          database={inspectorContext.database}
          navigationEnabled={inspectorOpen && activeInspector?.kind === "event"}
          offset={inspector.offset}
          onNavigate={panels.inspectEvent}
        />
      );
    } else if (inspector.kind === "llm") {
      const liveStep = inspectorContext.agentUiState?.live?.steps.find(
        (step): step is AgentUiLlmStep =>
          step.kind === "llm" &&
          step.llmRequestOffset === inspector.offset &&
          step.status === "running",
      );
      testId = "llm-request-inspector";
      content = (
        <LlmRequestInspectorContent
          streamSource={inspectorContext.streamSource}
          streamPath={inspectorContext.streamPath}
          database={inspectorContext.database}
          {...(liveStep == null ? {} : { liveStep })}
          llmRequestOffset={inspector.offset}
        />
      );
    } else {
      testId = "script-execution-inspector";
      content = (
        <ScriptExecutionInspectorContent
          database={inspectorContext.database}
          executionId={inspector.executionId}
        />
      );
    }
  }

  return (
    <Sheet
      open={inspectorOpen}
      onOpenChange={(open) => {
        if (!open) {
          setDismissedInspectorKey(activeInspectorKey);
          panels.closeInspector();
        }
      }}
      onOpenChangeComplete={(open) => {
        if (!open) {
          setRetainedInspectorContext(null);
        }
      }}
    >
      <SheetContent
        side="right"
        className="w-full gap-0 p-0 data-[side=right]:sm:w-[min(92vw,72rem)] data-[side=right]:sm:max-w-[92vw]"
        data-testid={testId}
        inert={!inspectorOpen}
      >
        {content}
      </SheetContent>
    </Sheet>
  );
}

/**
 * Full-panel layouts relegate the feed to this right-edge sheet behind the
 * header's Events button (`?events=true`). Children are the filter row +
 * feed column the split layout renders inline. The strip carries the same
 * stream-state/latency button as the page header — the processors sheet
 * stacks on top of this one.
 */
function StreamEventsSheet({
  children,
  metrics,
  streamPath,
}: {
  children: ReactNode;
  metrics: BrowserStreamMetricsView;
  streamPath: string;
}) {
  const { search, setSearch } = useStreamViewSearch();
  const { eventsSheetOpen, openEventsSheet, closeEventsSheet } = useStreamViewPanels();
  return (
    <Sheet
      open={eventsSheetOpen}
      onOpenChange={(open) => (open ? openEventsSheet() : closeEventsSheet())}
    >
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 data-[side=right]:sm:w-[min(92vw,72rem)] data-[side=right]:sm:max-w-[92vw]"
        showCloseButton={false}
      >
        <SheetTitle className="sr-only">Stream events for {streamPath}</SheetTitle>
        <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
            {streamPath}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <StreamStateButton metrics={metrics} />
            <StreamModeTabs streamPath={streamPath} />
            <Button
              variant="ghost"
              size="icon"
              title="Search & filter"
              aria-label="Search and filter stream events"
              aria-expanded={search.filter === true}
              onClick={() => setSearch({ filter: search.filter === true ? undefined : true })}
              className="rounded-full text-muted-foreground"
            >
              <FilterIcon aria-hidden="true" className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              title="Close events"
              aria-label="Close stream events"
              onClick={closeEventsSheet}
              className="rounded-full text-muted-foreground"
            >
              <XIcon aria-hidden="true" className="size-3.5" />
            </Button>
          </div>
        </div>
        {children}
      </SheetContent>
    </Sheet>
  );
}

/**
 * The processors sheet's one on-demand debug accessor: reduced state for the
 * focused processor subscription, addressed by its name. Stream runtime
 * diagnostics arrive separately through the LiveState listener, including the
 * head offset used for lag math.
 */
function useProcessorsPanelDebugState(args: {
  resolvedStreamSource: ItxStreamSource;
  streamPath: string;
}) {
  const { resolvedStreamSource, streamPath } = args;
  const getProcessorRuntimeState = useCallback(
    async (name: string) => {
      const stream = await resolvedStreamSource(streamPath);
      return stream.getProcessorRuntimeState({ name });
    },
    [resolvedStreamSource, streamPath],
  );
  return { getProcessorRuntimeState };
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
  runningLlmRequestId: number | undefined;
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
 * Claim the newest agent reply in this thread as "on screen": a
 * `project/agent-reply-presented` claim that lands inside the device
 * processor's reply grace window settles the pending push `suppressed` on
 * every enrolled device, and a late claim is a harmless no-op (the push
 * simply goes out — the designed fallback), so failures are ignored. One
 * claim per reply per mount (useQuery keyed on the reply offset; the
 * idempotency key makes any refire a stream-level no-op). Only a visible tab
 * may claim — the queryFn WAITS for visibility, so a reply that arrives in a
 * hidden tab is deliberately not claimed: the push is exactly what should
 * happen then.
 */
function useClaimReplyPresented(args: {
  database: StreamBrowserDatabase;
  projectId: string | null;
  streamPath: string;
}) {
  const { database, projectId, streamPath } = args;
  const newestReply = useStreamQuery(
    database,
    `SELECT MAX(offset) AS offset FROM events
     WHERE type = 'events.iterate.com/agents/web-message-sent'`,
  );
  const replyOffset = Number(newestReply.data[0]?.offset ?? 0) || null;
  useQuery({
    queryKey: ["agent-reply-presented", projectId, streamPath, replyOffset],
    enabled: projectId !== null && replyOffset !== null && streamPath.startsWith("/agents/"),
    queryFn: async () => {
      await documentVisible();
      const itx = await connectItx(projectId!);
      await itx.streams.get("/").append({
        type: "events.iterate.com/project/agent-reply-presented",
        idempotencyKey: `project/agent-reply-presented:${streamPath}:${replyOffset}`,
        payload: { path: streamPath, replyEventOffset: replyOffset! },
      });
      return true;
    },
    staleTime: Infinity,
    retry: false,
  });
}

/** Resolves once this tab is visible — immediately when it already is.
 * One-shot: the listener removes itself on the first visible transition. */
function documentVisible(): Promise<void> {
  if (document.visibilityState === "visible") return Promise.resolve();
  return new Promise((resolve) => {
    const onChange = () => {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", onChange);
      resolve();
    };
    document.addEventListener("visibilitychange", onChange);
  });
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

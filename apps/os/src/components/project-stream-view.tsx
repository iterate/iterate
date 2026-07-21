import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { FilterIcon, XIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { useAuthClient } from "@iterate-com/auth/client";
import { Sheet, SheetContent, SheetTitle } from "@iterate-com/ui/components/sheet";
import { toast } from "@iterate-com/ui/components/sonner";
import {
  isAgentUiActivityWorking,
  reduceAgentUiRuntime,
  type AgentUiLlmStep,
  type AgentUiRuntimeTransition,
  type AgentUiState,
  type AgentUiStep,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import {
  connectItx,
  connectIterateSession,
  reportTransportSuspicion,
  useLiveState,
} from "iterate/sdk/itx/react";
import type { Stream } from "../itx-api.generated.ts";
import { useStreamQuery } from "~/domains/streams/client-libraries/browser/hooks/use-stream-query.ts";
import { useStreamMirror } from "~/domains/streams/client-libraries/browser/hooks/use-stream-mirror.ts";
import type { StreamBrowserDatabase } from "~/domains/streams/client-libraries/browser/stream-browser-db.ts";
import type { StreamBrowserStore } from "~/domains/streams/client-libraries/browser/stream-browser-store.ts";
import { asBrowserStreamClient } from "~/domains/streams/client-libraries/browser/stream-transport.ts";
import { BrowserFeedContract } from "~/domains/streams/client-libraries/processors/browser-feed/implementation.ts";
import { isCurrentBrowserFeedState } from "~/domains/streams/client-libraries/processors/browser-feed/projector.ts";
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
import { StreamModeTabs, StreamViewHeader } from "~/components/stream-view-header.tsx";
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
   * Runtime supplied by a parent which already owns the selected agent's live
   * subscription. `undefined` lets this generic stream view subscribe itself;
   * `null` means the parent has no transition yet.
   */
  agentRuntimeTransition?: AgentUiRuntimeTransition | null;
  autoFocusMessageComposer?: boolean;
  /** Domain identity shown directly below the generic stream header. */
  contextHeader?: ReactNode;
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
};

const EMPTY_STREAM_METRICS: BrowserStreamMetricsView = {
  spark: [],
  transportRttMs: null,
  subscriber: undefined,
};

/**
 * The stream view: every domain page's main pane. Renders mode-owned feed
 * surfaces under the shared header (Pretty / Pretty+raw / Raw on agents),
 * with the composer below and standard right-edge sheets (inspectors and
 * processor state) on top.
 *
 * This component is the orchestrator: it owns the two browser-hosted
 * processors that mirror the stream into local SQLite (the raw `events` log
 * and the single `feed_items` projection) and hands their stores/databases to
 * focused child components. All view state (mode, filters, open panels) lives in the URL —
 * see ~/lib/stream-view-search.ts — so children read it themselves; the
 * component stays mounted across ⌘K stream switches (the switcher navigates
 * with an empty search, resetting the view to the new stream's defaults).
 */
export function ProjectStreamView(props: ProjectStreamViewProps) {
  if (props.layout === "fullPanel") return <FullPanelProjectStreamView {...props} />;
  return <MirroredProjectStreamView {...props} />;
}

/**
 * Full-panel domain pages keep their stream available as a secondary Events
 * sheet without paying for its historical download, SQLite mirror, or live
 * subscription while that sheet is closed.
 */
function FullPanelProjectStreamView({
  contextHeader,
  panel,
  streamPath,
  ...mirrorProps
}: ProjectStreamViewProps) {
  const panels = useStreamViewPanels();
  const mirrorActive = panels.eventsSheetOpen || panels.processorsPanelOpen;

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
      <DeferredSurface active={mirrorActive}>
        <MirroredProjectStreamView
          {...mirrorProps}
          contextHeader={contextHeader}
          layout="fullPanel"
          panel={panel}
          streamPath={streamPath}
        />
      </DeferredSurface>
    </section>
  );
}

function MirroredProjectStreamView({
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
  const { resolvedStreamSource, store, snapshot } = useProjectStreamMirror({
    projectId,
    resetStreamSourceTransport,
    subscriberUser,
    streamSource,
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
  const agentUiState = useAgentUiReducedState(store.streamDatabase, store, snapshot.liveRevision);
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

  const subscribedAgentRuntimeTransition = useLiveState(
    (itx) => itx.agents.get(streamPath).liveState,
    (state) => state.runtimeChange,
    [streamPath],
    {
      slug: projectId ?? "",
      enabled:
        suppliedAgentRuntimeTransition === undefined &&
        projectId !== null &&
        streamPath.startsWith("/agents/"),
    },
  ).value;
  const agentRuntimeTransition =
    suppliedAgentRuntimeTransition === undefined
      ? subscribedAgentRuntimeTransition
      : (suppliedAgentRuntimeTransition ?? undefined);
  const agentPresentation = useMemo(() => {
    if (agentUiState == null || agentRuntimeTransition == null) {
      return { state: agentUiState, transientItems: [] };
    }
    const projected = reduceAgentUiRuntime(agentUiState, agentRuntimeTransition);
    return { state: projected.endState, transientItems: projected.items };
  }, [agentUiState, agentRuntimeTransition]);
  const presentedAgentUiState = agentPresentation.state;
  const agentRuntime = agentRuntimeTransition?.runtime;

  const runningLlmRequestId =
    presentedAgentUiState?.live?.steps.find(isRunningLlmStep)?.llmRequestOffset ?? null;
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

  const { getProcessorRuntimeState } = useProcessorsPanelDebugState({
    resolvedStreamSource,
    streamPath,
  });

  const streamIsLive =
    snapshot.connectionStatus === "subscribed" ||
    (snapshot.connectionStatus === "connected" && snapshot.subscriptionStatus === "follower");
  const connectionLabel =
    snapshot.connectionError ?? (streamIsLive ? emptyLabel : snapshot.connectionStatus);
  // Busy = work is actively running, independent of chat-message timing.
  const agentBusy = isAgentUiActivityWorking(presentedAgentUiState?.live ?? null, agentRuntime);
  const presence = presentedAgentUiState?.presence ?? [];
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
      liveState={caps.agentFeed ? presentedAgentUiState : null}
      transientAgentItems={caps.agentFeed ? agentPresentation.transientItems : []}
      runtime={agentRuntime}
      {...(caps.eventInspector ? { onInspectEvent: panels.inspectEvent } : {})}
      {...(caps.agentFeed ? { onInspectLlmRequest: panels.inspectLlmRequest } : {})}
      {...(caps.agentFeed ? { onInspectScriptExecution: panels.inspectScriptExecution } : {})}
      emptyLabel={connectionLabel}
      projectSlug={projectSlug}
      isPending={agentUiState == null && !streamIsLive}
    />
  );

  const queuedUserMessages = caps.agentFeed
    ? (presentedAgentUiState?.queuedUserMessages ?? [])
    : [];

  // The feed column — mode body with inspectors on top, composer below. One JSX
  // value so the split layout and the fullPanel Events sheet render the same
  // thing.
  const feedColumn = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {modeBody}
        <StreamInspectorSheet
          agentUiState={presentedAgentUiState}
          caps={caps}
          panels={panels}
          database={store.streamDatabase}
        />
      </div>

      <div className="shrink-0 px-4 pb-2.5 pt-2.5">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5">
          {eventCount > 0 && !streamIsLive ? (
            <p
              className="px-4 text-xs text-muted-foreground"
              data-testid="stream-cache-status"
              role="status"
            >
              Showing cached events while
              {snapshot.connectionStatus === "reconnecting" || snapshot.connectionError != null
                ? " reconnecting…"
                : " connecting…"}
            </p>
          ) : null}
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
              disabled={!streamIsLive}
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
      projectId={projectId}
      streamPath={streamPath}
      tokenUsage={caps.agentFeed ? (presentedAgentUiState?.tokenUsage ?? null) : null}
    />
  );

  if (layout === "fullPanel") {
    return (
      <>
        {streamStateSheet}
        <StreamEventsSheet streamPath={streamPath}>
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

/** Owns transport generation, recovery, and the one local mirror for a stream. */
function useProjectStreamMirror({
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
  // The stream mirror rides the ONE shared session socket — the same connection
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
  // One download fans out into the raw-event mirror and browser-feed projector.
  const mirror = useStreamMirror({
    createStreamClient: streamClientFactory,
    ...(resetTransport === undefined ? {} : { resetTransport }),
    projectId: streamRuntimeProjectKey,
    ...(subscriberUser === undefined ? {} : { subscriberUser }),
    streamPath,
  });
  return { resolvedStreamSource, ...mirror };
}

/**
 * The feed's standard right-edge inspector sheet. At most one inspector holds
 * the edge (useStreamViewPanels keeps their URL keys mutually exclusive):
 * the raw-event inspector when the mode offers it and `?event=` is set,
 * else an LLM or script inspector when its deep-link parameter is set — in
 * EVERY mode, so a shared link works regardless of the viewer's tab. All
 * inspectors read the RAW events mirror (not feed_items): the fold reads the journal,
 * the same source the processor read.
 */
function StreamInspectorSheet({
  agentUiState,
  caps,
  panels,
  database,
}: {
  agentUiState: AgentUiState | null;
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
          },
    [activeInspector, agentUiState, database],
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
        className="flex w-full flex-col gap-0 p-0 data-[side=right]:sm:w-[min(92vw,72rem)] data-[side=right]:sm:max-w-[92vw]"
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
 * focused processor. Stream runtime diagnostics arrive separately through
 * the LiveState subscription, including the head offset used for lag math.
 */
function useProcessorsPanelDebugState(args: {
  resolvedStreamSource: ItxStreamSource;
  streamPath: string;
}) {
  const { resolvedStreamSource, streamPath } = args;
  const getProcessorRuntimeState = useCallback(
    async (subscriptionKey: string) => {
      const stream = await resolvedStreamSource(streamPath);
      return stream.getProcessorRuntimeState({ subscriptionKey });
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
 * The browser-feed projector persists the durable `agent` slice to
 * `processor_progress`. Genuinely live ephemeral chunks stay in the store's
 * in-memory tail; `liveRevision` makes those batches reactive without ever
 * writing or replaying them. Null until either source has produced state.
 */
function useAgentUiReducedState(
  database: StreamBrowserDatabase,
  store: StreamBrowserStore,
  liveRevision: number,
): AgentUiState | null {
  const result = useStreamQuery(
    database,
    // subscription_key is part of the primary key, so multiple rows can exist
    // for the slug (e.g. after a key-format change); read the most advanced one.
    `SELECT reduced_state FROM processor_progress WHERE processor_slug = ?
     ORDER BY acknowledged_through_offset DESC LIMIT 1`,
    [BrowserFeedContract.slug],
  );
  return useMemo(() => {
    // Volatile live batches do not write SQLite; the revision is the reactive
    // signal that makes this snapshot read run again.
    void liveRevision;
    const live = store.agentUiState();
    if (live !== null) return live;
    const raw = result.data[0]?.reduced_state;
    if (typeof raw !== "string") return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isCurrentBrowserFeedState(parsed) ? parsed.agent : null;
    } catch {
      return null;
    }
  }, [liveRevision, result.data, store]);
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

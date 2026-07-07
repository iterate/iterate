import { useCallback, useMemo, useState, type ReactNode } from "react";
import type {
  AgentUiLlmStep,
  AgentUiState,
  AgentUiStep,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
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
import type { Stream } from "~/types.ts";
import { AgentFeedView } from "~/components/agent-feed.tsx";
import { FeedItemsView } from "~/components/feed-items-view.tsx";
import { RawEventInspectorPanel } from "~/components/raw-event-inspector-panel.tsx";
import { StreamFeedFilterRow } from "~/components/stream-feed-filters.tsx";
import { StreamProcessorsPanel } from "~/components/stream-processors-panel.tsx";
import { StreamStateView } from "~/components/stream-state-view.tsx";
import {
  StreamViewComposer,
  type StreamInterrupt,
  type StreamMessageComposer,
} from "~/components/stream-view-composer.tsx";
import { StreamViewHeader } from "~/components/stream-view-header.tsx";
import { presetsForStream } from "~/lib/stream-feed-filters.ts";
import { NULL_DURABLE_OBJECT_PROJECT_ID } from "~/lib/stream-navigation.ts";
import { useItx } from "~/itx/itx-react.tsx";
import { useSimulatedRttMetrics } from "~/lib/stream-presence.ts";
import {
  streamViewTab,
  useStreamViewPanels,
  useStreamViewSearch,
} from "~/lib/stream-view-search.ts";

type ItxStreamSource = (streamPath: string) => Stream | Promise<Stream>;

/**
 * The stream view: every domain page's main pane. Renders one stream's Feed
 * and State tabs under the shared header, with the composer below and the
 * right-edge overlays (raw-event inspector, processors sidebar) on top.
 *
 * This component is the orchestrator: it owns the three browser-hosted
 * processors that mirror the stream into local SQLite (raw events, agent UI,
 * grouped feed items) and hands their stores/databases to focused child
 * components. All view state (tab, filters, open panels) lives in the URL —
 * see ~/lib/stream-view-search.ts — so children read it themselves; the
 * component stays mounted across ⌘K stream switches (the switcher navigates
 * with an empty search, resetting the view to the new stream's defaults).
 */
export function ProjectStreamView({
  autoFocusMessageComposer = false,
  defaultComposerMode,
  emptyLabel = "No events in this stream yet.",
  messageComposer,
  panel,
  projectId,
  projectSlug,
  streamSource,
  streamPath,
}: {
  autoFocusMessageComposer?: boolean;
  defaultComposerMode?: "message" | "raw";
  emptyLabel?: string;
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
  const agentPauseState = useStreamPauseState(store.streamDatabase);
  const metrics = useSimulatedRttMetrics();
  const [pauseMutationPending, setPauseMutationPending] = useState(false);

  const { search } = useStreamViewSearch();
  const panels = useStreamViewPanels();
  const activeTab = streamViewTab(search);
  // WHAT the feed shows is the preset's job; the stream path decides which
  // presets exist and which one is the domain default (the first). A
  // stale/hand-edited preset id falls back to the default.
  const presets = useMemo(() => presetsForStream(streamPath), [streamPath]);
  const defaultPreset = presets[0]!;
  const activePreset = presets.find((preset) => preset.id === search.preset) ?? defaultPreset;
  const feedSearch = search.q ?? "";

  // The server is about to append: verify deliveries actually arrive and
  // reconnect within seconds if a subscription died silently — instead of
  // the user's message not appearing until the next paced probe (or a reload).
  const nudgeDeliveries = useCallback(() => {
    void store.nudge();
    void agentStore.nudge();
    void feedStore.nudge();
  }, [store, agentStore, feedStore]);

  const runningLlmRequestId =
    agentUiState?.live?.steps.find(isRunningLlmStep)?.llmRequestId ?? null;
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
      const [runtimeState, streamRuntimeState] = await Promise.all([
        store.getProcessorRuntimeState({ subscriptionKey }),
        store.runtimeState(),
      ]);
      return {
        runtimeState,
        // The itx Stream.runtimeState() types coreProcessorState as
        // unknown; parse out the slice this panel needs.
        streamMaxOffset: parseBrowserCoreProcessorState(streamRuntimeState.coreProcessorState)
          .maxOffset,
      };
    },
    [store],
  );

  const connectionLabel =
    snapshot.connectionError ??
    (snapshot.connectionStatus === "subscribed" ? emptyLabel : snapshot.connectionStatus);
  // Busy = work is actively running, independent of chat-message timing.
  const agentBusy = agentUiState?.live?.steps.some((step) => step.status === "running") ?? false;
  const presence = agentUiState?.presence ?? [];
  const agentPauseControl = streamPath.startsWith("/agents/")
    ? {
        paused: agentPauseState.paused,
        reason: agentPauseState.reason,
        pending: pauseMutationPending,
        setPaused: async (paused: boolean) => {
          if (pauseMutationPending) return;
          setPauseMutationPending(true);
          try {
            const stream = await resolvedStreamSource(streamPath);
            await stream.append({
              type: paused
                ? "events.iterate.com/stream/paused"
                : "events.iterate.com/stream/resumed",
              payload: {
                reason: paused ? "Paused by operator from the agent UI." : "Resumed by operator.",
              },
            });
            nudgeDeliveries();
          } finally {
            setPauseMutationPending(false);
          }
        },
      }
    : undefined;

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-background">
      <StreamViewHeader
        agentBusy={agentBusy}
        agentPause={agentPauseControl}
        metrics={metrics}
        presence={presence}
        streamPath={streamPath}
      />
      {search.filter !== true ? null : activeTab === "feed" ? (
        <StreamFeedFilterRow
          activePreset={activePreset}
          defaultPresetId={defaultPreset.id}
          eventCount={eventCount}
          connectionStatus={snapshot.connectionStatus}
          feedDatabase={feedStore.streamDatabase}
          presets={presets}
        />
      ) : (
        <div className="flex shrink-0 items-center justify-end px-4 pb-1.5 pt-1">
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {eventCount.toLocaleString()} events · {snapshot.connectionStatus}
          </span>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
        {panel == null ? null : (
          <aside className="max-h-[45svh] min-h-0 shrink-0 overflow-y-auto border-b lg:max-h-none lg:w-[26rem] lg:border-b-0 lg:border-r">
            <div className="flex flex-col gap-4 p-4">{panel}</div>
          </aside>
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            {activeTab === "state" ? (
              <StreamStateView store={store} />
            ) : activePreset.kind === "agent-chat" ? (
              <AgentFeedView
                {...(interrupt != null && (agentUiState?.queuedUserMessages ?? []).length > 0
                  ? { onInterruptQueuedMessages: interrupt.run }
                  : {})}
                // Fresh virtualizer state per stream mirror (see AgentFeedView docs).
                key={store.streamDatabase.databasePath}
                database={store.streamDatabase}
                liveState={agentUiState}
                search={feedSearch}
                emptyLabel={connectionLabel}
                isInterruptingQueuedMessages={interrupt?.isInterrupting ?? false}
                projectSlug={projectSlug}
                // The reduced-state row only exists once the processor has
                // checkpointed; an already-subscribed empty stream is "nothing
                // here yet", not "connecting".
                isPending={agentUiState == null && agentSnapshot.connectionStatus !== "subscribed"}
              />
            ) : (
              <FeedItemsView
                // Fresh virtualizer state per stream mirror (see FeedItemsView
                // docs); filter changes are handled inside without remounting.
                key={feedStore.streamDatabase.databasePath}
                database={feedStore.streamDatabase}
                emptyLabel={connectionLabel}
                filter={{
                  eventTypes: search.types ?? null,
                  eventTypePrefix: activePreset.eventTypePrefix ?? null,
                  searchQuery: feedSearch === "" ? null : feedSearch,
                  offsetFrom: search.from ?? null,
                  offsetTo: search.to ?? null,
                }}
                onInspectEvent={panels.inspectEvent}
              />
            )}
            {panels.inspectedOffset != null ? (
              <RawEventInspectorPanel
                database={store.streamDatabase}
                offset={panels.inspectedOffset}
                onNavigate={panels.inspectEvent}
                onClose={panels.closeInspector}
              />
            ) : null}
            {panels.processorsPanelOpen ? (
              <StreamProcessorsPanel
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
              />
            ) : null}
          </div>

          {activeTab === "state" ? null : (
            <div className="shrink-0 px-4 pb-4 pt-2.5">
              <StreamViewComposer
                autoFocusMessage={autoFocusMessageComposer}
                {...(defaultComposerMode == null ? {} : { defaultMode: defaultComposerMode })}
                interrupt={interrupt}
                {...(messageComposer == null ? {} : { messageComposer })}
                onNudgeDeliveries={nudgeDeliveries}
                presence={presence}
                store={store}
              />
            </div>
          )}
        </div>
      </div>
    </section>
  );
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
  onInterrupt: ((llmRequestId: number) => Promise<void>) | undefined;
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

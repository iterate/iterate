import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { FilterIcon, SearchIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@iterate-com/ui/components/select";
import { Tabs, TabsList, TabsTrigger } from "@iterate-com/ui/components/tabs";
import type {
  AgentUiLlmStep,
  AgentUiState,
  AgentUiStep,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import { cn } from "@iterate-com/ui/lib/utils";
import { parse as parseYaml } from "yaml";
import {
  AGENT_UI_FEED_TABLE,
  AGENT_UI_SCHEMA_VERSION,
  AgentUiProcessor,
  AgentUiProcessorContract,
} from "~/domains/streams/client-libraries/processors/agent-ui-processor.ts";
import { parseBrowserCoreProcessorState } from "~/domains/streams/client-libraries/browser/core-processor-state.ts";
import { useStreamQuery } from "~/domains/streams/client-libraries/browser/hooks/use-stream-query.ts";
import { browserProcessorStateStorage } from "~/domains/streams/client-libraries/browser/processor-state-storage.ts";
import type { StreamBrowserDatabase } from "~/domains/streams/client-libraries/browser/stream-browser-db.ts";
import {
  acquireStreamRuntime,
  asBrowserStreamClient,
  type StreamBrowserStore,
  type StreamRuntimeState,
} from "~/domains/streams/client-libraries/browser/stream-browser-store.ts";
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
import type { FeedItemData } from "~/domains/streams/client-libraries/processors/browser-event-feed/grouping.ts";
import { StreamEventInput } from "~/domains/streams/schemas.ts";
import type { Stream } from "~/types.ts";
import { AgentFeedView } from "~/components/agent-feed.tsx";
import { AgentPillComposer, type AgentComposerMode } from "~/components/agent-pill-composer.tsx";
import { ExampleEventsPanel } from "~/components/example-events-panel.tsx";
import { PresenceAvatar, StreamProcessorsPanel } from "~/components/stream-processors-panel.tsx";
import { NULL_DURABLE_OBJECT_PROJECT_ID } from "~/lib/stream-navigation.ts";
import { useItx } from "~/itx/itx-react.tsx";
import { presenceLabel, sparklinePoints, useSimulatedRttMetrics } from "~/lib/stream-presence.ts";
import { useStreamViewSearch } from "~/lib/stream-view-search.ts";

const DEFAULT_RAW_EVENT_YAML =
  "type: events.iterate.com/os/manual-event\npayload:\n  message: Hello from OS\n";

const MAX_PRESENCE_AVATARS = 4;

type ProjectStreamViewTab = "feed" | "state";
type ItxStreamSource = (streamPath: string) => Stream | Promise<Stream>;

/**
 * One named configuration of the Feed tab. The feed always renders a feed-item
 * collection from the local SQLite mirror — never the raw events table — and a
 * preset picks WHICH collection and how it is filtered:
 *   - `agent-chat` renders the agent_feed_items collection (the chat view);
 *   - `feed-items` renders the grouped feed_items collection, optionally
 *     filtered to one event-type prefix (the domain presets).
 * The preset selector is the one filter UI element every stream view shares;
 * each domain contributes its own presets and default via the stream path.
 */
type StreamFeedPreset = { id: string; label: string } & (
  | { kind: "agent-chat" }
  | { kind: "feed-items"; eventTypePrefix?: string }
);

const EVERYTHING_PRESET: StreamFeedPreset = {
  id: "everything",
  label: "Everything",
  kind: "feed-items",
};

/** The domain-specific event-type prefix presets, keyed by stream-path prefix. */
const DOMAIN_PRESETS: { pathPrefix: string; preset: StreamFeedPreset }[] = [
  {
    pathPrefix: "/agents/",
    preset: {
      id: "agent-events",
      label: "Agent events",
      kind: "feed-items",
      eventTypePrefix: "events.iterate.com/agent/",
    },
  },
  {
    pathPrefix: "/secrets/",
    preset: {
      id: "secret-events",
      label: "Secret events",
      kind: "feed-items",
      eventTypePrefix: "events.iterate.com/secret/",
    },
  },
  {
    pathPrefix: "/repos/",
    preset: {
      id: "repo-events",
      label: "Repo events",
      kind: "feed-items",
      eventTypePrefix: "events.iterate.com/repo/",
    },
  },
  {
    pathPrefix: "/integrations/slack",
    preset: {
      id: "slack-events",
      label: "Slack events",
      kind: "feed-items",
      eventTypePrefix: "events.iterate.com/slack/",
    },
  },
];

/**
 * The presets available on a stream, in order — the FIRST one is the domain's
 * default. Agent streams default to the chat view; other domains default to
 * their own event family; everything else defaults to the unfiltered feed.
 */
function presetsForStream(streamPath: string): StreamFeedPreset[] {
  const presets: StreamFeedPreset[] = [];
  if (streamPath.startsWith("/agents/")) {
    presets.push({ id: "agent-chat", label: "Agent chat", kind: "agent-chat" });
  }
  for (const { pathPrefix, preset } of DOMAIN_PRESETS) {
    if (streamPath.startsWith(pathPrefix)) presets.push(preset);
  }
  presets.push(EVERYTHING_PRESET);
  return presets;
}

type ProjectStreamMessageComposer = {
  placeholder?: string;
  onInterrupt?: (llmRequestId: number) => Promise<void>;
  onSubmit: (message: string) => Promise<void>;
};

export function ProjectStreamView({
  autoFocusMessageComposer = false,
  defaultComposerMode,
  emptyLabel = "No events in this stream yet.",
  messageComposer,
  projectId,
  streamSource,
  streamPath,
}: {
  autoFocusMessageComposer?: boolean;
  defaultComposerMode?: "message" | "raw";
  emptyLabel?: string;
  messageComposer?: ProjectStreamMessageComposer;
  projectId: string | null;
  streamSource?: ItxStreamSource;
  streamPath: string;
}) {
  const itx = useItx();
  const streamPathText = streamPath;
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
  const store = useMemo(
    () =>
      acquireStreamRuntime({
        createStreamClient: streamClientFactory,
        projectId: streamRuntimeProjectKey,
        streamPath: streamPathText,
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
            stream,
            sql,
            readState: storage.readState,
            writeState: storage.writeState,
          });
        },
      }),
    [streamRuntimeProjectKey, streamClientFactory, streamPathText],
  );
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
  const countResult = useStreamQuery(store.streamDatabase, `SELECT COUNT(*) AS count FROM events`);
  const eventCount = Number(countResult.data[0]?.count ?? 0);

  // A second browser-hosted processor on the same stream (and same per-path
  // SQLite database): folds agent events into settled `agent_feed_items` rows
  // plus a live in-flight activity persisted in its reduced state. Runs at
  // this level (not inside the agent tab) because the header chrome —
  // presence avatars, busy indicator — derives from the same state.
  const agentStore = useMemo(
    () =>
      acquireStreamRuntime({
        createStreamClient: streamClientFactory,
        projectId: streamRuntimeProjectKey,
        streamPath: streamPathText,
        slug: AgentUiProcessorContract.slug,
        schemaVersion: AGENT_UI_SCHEMA_VERSION,
        resetOnSchemaVersionChange: true,
        tables: [AGENT_UI_FEED_TABLE],
        createProcessor({ stream, sql, subscriptionKey }) {
          const storage = browserProcessorStateStorage<AgentUiState>({
            sql,
            processorSlug: AgentUiProcessorContract.slug,
            subscriptionKey,
          });
          return new AgentUiProcessor({
            stream,
            sql,
            readState: storage.readState,
            writeState: storage.writeState,
          });
        },
      }),
    [streamRuntimeProjectKey, streamClientFactory, streamPathText],
  );
  const agentSnapshot = useSyncExternalStore(
    agentStore.subscribe,
    agentStore.getSnapshot,
    agentStore.getServerSnapshot,
  );
  // Third browser-hosted processor: folds every event into grouped feed_items
  // rows — the collection the Feed tab's presets filter over.
  const feedStore = useMemo(
    () =>
      acquireStreamRuntime({
        createStreamClient: streamClientFactory,
        projectId: streamRuntimeProjectKey,
        streamPath: streamPathText,
        slug: BrowserEventFeedContract.slug,
        schemaVersion: BROWSER_EVENT_FEED_SCHEMA_VERSION,
        tables: [BROWSER_EVENT_FEED_TABLE],
        createProcessor({ stream, sql, subscriptionKey }) {
          const storage = browserProcessorStateStorage<BrowserEventFeedState>({
            sql,
            processorSlug: BrowserEventFeedContract.slug,
            subscriptionKey,
          });
          return new BrowserEventFeedProcessor({
            stream,
            sql,
            readState: storage.readState,
            writeState: storage.writeState,
          });
        },
      }),
    [streamRuntimeProjectKey, streamClientFactory, streamPathText],
  );
  // Subscribing is what STARTS a store's connection (stream-browser-store
  // refcounts listeners); without this the feed processor never folds.
  useSyncExternalStore(feedStore.subscribe, feedStore.getSnapshot, feedStore.getServerSnapshot);
  const agentUiState = useAgentUiReducedState(store.streamDatabase);
  const metrics = useSimulatedRttMetrics();

  // Tab, filter, and processor-sidebar state all live in the URL so any view is
  // shareable (see ~/lib/stream-view-search.ts). The component stays mounted
  // across stream navigations (e.g. ⌘K); each stream switch resets these params
  // (the switcher navigates with an empty search), so a new stream shows its own
  // default tab and fresh filters.
  const { search, setSearch } = useStreamViewSearch();

  // Two tabs everywhere: Feed (default) and State. WHAT the feed shows is the
  // preset's job; the stream path decides which presets exist and which one is
  // the domain default (the first). A stale/hand-edited preset id falls back.
  const activeTab: ProjectStreamViewTab = search.tab ?? "feed";
  const presets = useMemo(() => presetsForStream(streamPathText), [streamPathText]);
  const defaultPreset = presets[0]!;
  const activePreset = presets.find((preset) => preset.id === search.preset) ?? defaultPreset;
  const toolsOpen = search.filter === true;
  const feedSearch = search.q ?? "";
  // Signal active filters on the toggle even while the panel is closed — a
  // filtered feed with no visible cue reads as missing events.
  const filtersActive =
    activePreset.id !== defaultPreset.id || feedSearch !== "" || search.type != null;
  const focusedProcessorKey = search.processor ?? null;
  const procPanelOpen = search.panel === true || focusedProcessorKey != null;
  // Focusing a processor implies the sidebar is open; the metrics button opens
  // it on the overview (no focus); closing clears both.
  const focusProcessor = (subscriptionKey: string) =>
    setSearch({ panel: true, processor: subscriptionKey });
  const openProcessorsOverview = () => setSearch({ panel: true, processor: undefined });
  const feedSearchInputRef = useRef<HTMLInputElement>(null);
  const [composerMode, setComposerMode] = useState<AgentComposerMode>(
    defaultComposerMode ?? (messageComposer ? "message" : "raw"),
  );
  const [messageText, setMessageText] = useState("");
  const [rawText, setRawText] = useState(DEFAULT_RAW_EVENT_YAML);
  const [submitError, setSubmitError] = useState<string | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isInterrupting, setIsInterrupting] = useState(false);
  useEffect(() => {
    if (toolsOpen) feedSearchInputRef.current?.focus();
  }, [toolsOpen]);

  async function runSubmit(action: () => Promise<void>) {
    setIsSubmitting(true);
    setSubmitError(undefined);
    try {
      await action();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  // The server is about to append: verify deliveries actually arrive and
  // reconnect within seconds if the subscription died silently — instead of
  // the user's message not appearing until the next paced probe (or a reload).
  function nudgeDeliveries() {
    void store.nudge();
    void agentStore.nudge();
    void feedStore.nudge();
  }

  async function submitMessage() {
    const trimmed = messageText.trim();
    if (!trimmed || messageComposer == null) return;
    await runSubmit(async () => {
      await messageComposer.onSubmit(trimmed);
      setMessageText("");
      nudgeDeliveries();
    });
  }

  const runningLlmRequestId =
    agentUiState?.live?.steps.find(isRunningLlmStep)?.llmRequestId ?? null;

  async function interruptMessage() {
    if (messageComposer?.onInterrupt == null || isInterrupting) return;
    if (runningLlmRequestId == null) return;
    setIsInterrupting(true);
    setSubmitError(undefined);
    try {
      await messageComposer.onInterrupt(runningLlmRequestId);
      nudgeDeliveries();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsInterrupting(false);
    }
  }

  async function clearClientDatabases() {
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

  async function submitRawEvents() {
    const trimmed = rawText.trim();
    if (!trimmed) return;
    await runSubmit(async () => {
      const parsed = parseYaml(trimmed) as unknown;
      const events = (Array.isArray(parsed) ? parsed : [parsed]).map((event) =>
        StreamEventInput.parse(event),
      );
      await store.appendBatch({ events });
      nudgeDeliveries();
    });
  }

  const connectionLabel =
    snapshot.connectionError ??
    (snapshot.connectionStatus === "subscribed" ? emptyLabel : snapshot.connectionStatus);
  // Busy = a turn is actively running. A "waiting" activity (agent idle
  // between rounds, not yet settled by a chat message) is not busy — the live
  // feed already parks its spinner there, so the header must match.
  const agentBusy = agentUiState?.live?.status === "running";
  const presence = agentUiState?.presence ?? [];

  // Picking an example drops the user into the raw editor with the YAML loaded.
  function loadRawExample(yaml: string) {
    setRawText(yaml);
    setComposerMode("raw");
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-4 pb-1 pt-2.5">
        <Tabs
          value={activeTab}
          onValueChange={(value) => {
            const tab = value as ProjectStreamViewTab;
            setSearch({ tab: tab === "feed" ? undefined : tab });
          }}
        >
          <TabsList className="h-8">
            <TabsTrigger value="feed" className="px-3 text-xs">
              Feed
            </TabsTrigger>
            <TabsTrigger value="state" className="px-3 text-xs">
              State
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="ml-auto flex items-center gap-3">
          {presence.length === 0 ? null : (
            <div className="flex items-center pl-1.5">
              {presence.slice(0, MAX_PRESENCE_AVATARS).map((entry) => {
                const selected = entry.subscriptionKey === focusedProcessorKey;
                return (
                  <button
                    key={entry.subscriptionKey}
                    type="button"
                    title={`${presenceLabel(entry)} — open processor`}
                    onClick={() => focusProcessor(entry.subscriptionKey)}
                    // The selected ring renders outside the avatar; lift it above
                    // the overlapping siblings so it isn't clipped.
                    className={cn("-ml-1.5 rounded-full", selected && "relative z-10")}
                  >
                    <PresenceAvatar
                      entry={entry}
                      busy={agentBusy}
                      // The avatar already reserves a 2px border to separate
                      // overlapping siblings; recolor that same border for the
                      // selected one instead of stacking a ring outside it.
                      className={cn(
                        "border-2",
                        selected ? "border-foreground" : "border-background",
                      )}
                    />
                  </button>
                );
              })}
              {presence.length > MAX_PRESENCE_AVATARS ? (
                <button
                  type="button"
                  title="All processors"
                  onClick={openProcessorsOverview}
                  className="-ml-1.5 grid size-6 place-items-center rounded-full border-2 border-background bg-muted font-mono text-[9px] font-bold text-muted-foreground"
                >
                  +{presence.length - MAX_PRESENCE_AVATARS}
                </button>
              ) : null}
            </div>
          )}
          <Button
            variant="ghost"
            size="sm"
            title="Stream health & metrics"
            onClick={openProcessorsOverview}
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
          <Button
            variant="ghost"
            size="icon"
            title="Search & filter"
            aria-expanded={toolsOpen}
            onClick={() => setSearch({ filter: toolsOpen ? undefined : true })}
            className="relative rounded-full text-muted-foreground"
          >
            <FilterIcon className="size-3.5" />
            {filtersActive ? (
              <span
                aria-hidden="true"
                className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-primary"
              />
            ) : null}
          </Button>
        </div>
      </header>
      {toolsOpen ? (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-1.5 pt-1">
          {activeTab === "feed" ? (
            <div
              className="flex flex-wrap items-center gap-1.5"
              role="radiogroup"
              aria-label="Feed preset"
              data-testid="stream-feed-preset"
            >
              {presets.map((preset) => {
                const active = preset.id === activePreset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() =>
                      setSearch({
                        preset: preset.id === defaultPreset.id ? undefined : preset.id,
                        // The event-type list is scoped to a preset's event
                        // family; a type from the old preset would silently
                        // empty the new one.
                        type: undefined,
                      })
                    }
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-xs transition-colors",
                      active
                        ? "border-transparent bg-foreground text-background"
                        : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
          ) : null}
          {activeTab === "feed" ? (
            <div className="flex h-8 min-w-0 max-w-xs flex-1 items-center gap-2 rounded-full bg-muted px-3">
              <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                ref={feedSearchInputRef}
                value={feedSearch}
                onChange={(event) => setSearch({ q: event.target.value || undefined })}
                placeholder="Search feed…"
                aria-label="Search feed"
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
          ) : null}
          {activeTab === "feed" && activePreset.kind === "feed-items" ? (
            <FeedEventTypeSelect
              database={feedStore.streamDatabase}
              eventTypePrefix={activePreset.eventTypePrefix ?? null}
              value={search.type ?? null}
              onChange={(type) => setSearch({ type: type ?? undefined })}
            />
          ) : null}
          <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
            {eventCount.toLocaleString()} events · {snapshot.connectionStatus}
          </span>
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {activeTab === "state" ? (
          <ProjectStreamStateView store={store} />
        ) : activePreset.kind === "agent-chat" ? (
          <AgentFeedView
            {...(runningLlmRequestId != null &&
            (agentUiState?.queuedUserMessages ?? []).length > 0 &&
            messageComposer?.onInterrupt != null
              ? { onInterruptQueuedMessages: interruptMessage }
              : {})}
            // Fresh virtualizer state per stream mirror (see AgentFeedView docs).
            key={store.streamDatabase.databasePath}
            database={store.streamDatabase}
            liveState={agentUiState}
            search={feedSearch}
            emptyLabel={connectionLabel}
            isInterruptingQueuedMessages={isInterrupting}
            // The reduced-state row only exists once the processor has
            // checkpointed; an already-subscribed empty stream is "nothing
            // here yet", not "connecting".
            isPending={agentUiState == null && agentSnapshot.connectionStatus !== "subscribed"}
          />
        ) : (
          <FeedItemsView
            database={feedStore.streamDatabase}
            emptyLabel={connectionLabel}
            eventType={search.type ?? null}
            eventTypePrefix={activePreset.eventTypePrefix ?? null}
            searchQuery={feedSearch === "" ? null : feedSearch}
          />
        )}
        {procPanelOpen ? (
          <StreamProcessorsPanel
            presence={presence}
            metrics={metrics}
            eventCount={eventCount}
            busy={agentBusy}
            focusedKey={focusedProcessorKey}
            onFocus={focusProcessor}
            onBack={openProcessorsOverview}
            onClose={() => setSearch({ panel: undefined, processor: undefined })}
            onClearClientDatabase={clearClientDatabases}
            getProcessorRuntimeState={getProcessorRuntimeState}
          />
        ) : null}
      </div>

      {activeTab === "state" ? null : (
        <div className="shrink-0 px-4 pb-4 pt-2.5">
          <AgentPillComposer
            mode={composerMode}
            onModeChange={setComposerMode}
            autoFocusMessage={autoFocusMessageComposer}
            examples={<ExampleEventsPanel presence={presence} onLoadExample={loadRawExample} />}
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
                  ...(runningLlmRequestId != null && messageComposer.onInterrupt != null
                    ? { onInterrupt: interruptMessage, isInterrupting }
                    : {}),
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
    </section>
  );
}

function isRunningLlmStep(step: AgentUiStep): step is AgentUiLlmStep {
  return step.kind === "llm" && step.status === "running";
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

// ---------------------------------------------------------------------------
// Feed view: the grouped feed_items collection, filtered by the active preset
// ---------------------------------------------------------------------------

/** How many rows past the virtualizer's window the tail query prefetches. */
const TAIL_PREFETCH_ROWS = 32;

/**
 * The primary event type of a feed_items row — a group row's `data.eventType`,
 * a singleton's first event type. Every feed filter (preset prefix, exact
 * type) matches against this expression, entirely in SQL over the local mirror.
 */
const FEED_TYPE_EXPRESSION = `COALESCE(json_extract(data, '$.eventType'), json_extract(data, '$.events[0].type'))`;

/** Composed WHERE fragment + params for the feed filters; null when unfiltered. */
type FeedItemsFilter = { whereSql: string; params: string[] } | null;

function buildFeedItemsFilter(input: {
  eventType: string | null;
  eventTypePrefix: string | null;
  searchQuery: string | null;
}): FeedItemsFilter {
  const clauses: string[] = [];
  const params: string[] = [];
  if (input.eventTypePrefix != null) {
    clauses.push(`${FEED_TYPE_EXPRESSION} LIKE ?`);
    params.push(`${input.eventTypePrefix}%`);
  }
  if (input.eventType != null) {
    clauses.push(`${FEED_TYPE_EXPRESSION} = ?`);
    params.push(input.eventType);
  }
  if (input.searchQuery != null) {
    clauses.push(`json(data) LIKE ?`);
    params.push(`%${input.searchQuery}%`);
  }
  if (clauses.length === 0) return null;
  return { whereSql: clauses.join(" AND "), params };
}

/**
 * Renders the browser-event-feed processor's `feed_items` collection: one row
 * per specific-renderer singleton or per collapsed run of same-type events,
 * filtered by the active preset's event-type prefix, the exact event-type
 * filter, and the text search.
 *
 * Same virtualization scheme as the agent feed (agent-feed.tsx): TanStack
 * Virtual owns the tail (anchorTo end + followOnAppend), the row window is a
 * live SQL range query over dense positions, and the count query gates the
 * list so the virtualizer never sees a 0→N transition on mount.
 */
function FeedItemsView({
  database,
  emptyLabel,
  eventType,
  eventTypePrefix,
  searchQuery,
}: {
  database: StreamBrowserDatabase;
  emptyLabel: string;
  eventType: string | null;
  eventTypePrefix: string | null;
  searchQuery: string | null;
}) {
  const filter = buildFeedItemsFilter({ eventType, eventTypePrefix, searchQuery });
  const countResult = useStreamQuery(
    database,
    filter == null
      ? `SELECT COUNT(*) AS count FROM feed_items`
      : `SELECT COUNT(*) AS count FROM feed_items WHERE ${filter.whereSql}`,
    filter?.params ?? [],
  );
  const itemCount = Number(countResult.data[0]?.count ?? 0);
  const scrollRef = useRef<HTMLDivElement>(null);

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
        ) : (
          <VirtualFeedItems
            // Fresh virtualizer (measurements, end anchor) per mirror and per
            // filter — stale state from another list would misplace the scroll.
            key={`${database.databasePath}:${filter?.whereSql ?? ""}:${(filter?.params ?? []).join(" ")}`}
            database={database}
            filter={filter}
            itemCount={itemCount}
            scrollElementRef={scrollRef}
          />
        )}
      </div>
    </div>
  );
}

function VirtualFeedItems({
  database,
  filter,
  itemCount,
  scrollElementRef,
}: {
  database: StreamBrowserDatabase;
  filter: FeedItemsFilter;
  itemCount: number;
  scrollElementRef: RefObject<HTMLDivElement | null>;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const virtualizer = useVirtualizer({
    count: itemCount,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => 44,
    getItemKey: (index) => index,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 80,
    overscan: 16,
    directDomUpdates: true,
  });

  // Open at the newest items; later appends are followOnAppend's job (this
  // component mounts gated behind the count query, see agent-feed.tsx).
  useLayoutEffect(() => {
    virtualizer.scrollToEnd();
  }, [virtualizer]);

  const virtualItems = virtualizer.getVirtualItems();
  const first = virtualItems[0]?.index ?? 0;
  const last = virtualItems.at(-1)?.index ?? -1;
  const windowSize = Math.max(0, last + 1 + TAIL_PREFETCH_ROWS - first);
  const rowsResult = useStreamQuery(
    database,
    filter == null
      ? `SELECT local_index, component, first_offset, last_offset, event_count, json(data) AS data
         FROM feed_items WHERE local_index >= ? AND local_index < ?
         ORDER BY local_index ASC`
      : `SELECT local_index, component, first_offset, last_offset, event_count, json(data) AS data
         FROM feed_items WHERE ${filter.whereSql}
         ORDER BY local_index ASC LIMIT ? OFFSET ?`,
    filter == null ? [first, first + windowSize] : [...filter.params, windowSize, first],
  );
  // Retain the last committed rows across range re-queries so a shifting
  // window doesn't blank already-visible rows to skeletons (see agent-feed).
  const lastRowsRef = useRef<Map<number, Record<string, unknown>> | null>(null);
  const rowsByIndex = useMemo(() => {
    if (rowsResult.status !== "ok") {
      return lastRowsRef.current ?? new Map<number, Record<string, unknown>>();
    }
    const rows = new Map<number, Record<string, unknown>>();
    rowsResult.data.forEach((row, position) => {
      const index = filter == null ? Number(row.local_index) : first + position;
      if (Number.isFinite(index)) rows.set(index, row);
    });
    lastRowsRef.current = rows;
    return rows;
  }, [rowsResult.data, rowsResult.status, filter, first]);

  return (
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
  );
}

const FeedItemRow = memo(function FeedItemRow({
  expanded,
  onToggle,
  row,
}: {
  expanded: boolean;
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

  return (
    <div className="py-0.5">
      <button
        aria-expanded={expanded}
        onClick={onToggle}
        type="button"
        className={cn(
          "flex w-full cursor-pointer items-baseline gap-2.5 rounded-xl bg-muted/40 px-3.5 py-2 text-left",
          "font-mono text-xs text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground",
          expanded && "rounded-b-none bg-muted/70 text-foreground",
        )}
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
      {expanded ? (
        <div className="rounded-b-xl bg-muted/40 px-3.5 pb-3 pt-1">
          <SerializedObjectCodeBlock data={data?.events ?? row.data} />
        </div>
      ) : null}
    </div>
  );
});

/** `events.iterate.com/agent/input-added` → `agent/input-added` — the domain part carries the signal. */
function shortEventType(type: string): string {
  return type.startsWith("events.iterate.com/") ? type.slice("events.iterate.com/".length) : type;
}

/** Radix Select forbids the empty-string value; this stands in for "no type filter". */
const ALL_EVENT_TYPES = "__all__";

/**
 * Exact event-type filter for the feed-items presets: the distinct primary
 * event types currently in the local mirror (scoped to the active preset's
 * prefix so the offered types can actually match), with per-type event counts.
 */
function FeedEventTypeSelect({
  database,
  eventTypePrefix,
  onChange,
  value,
}: {
  database: StreamBrowserDatabase;
  eventTypePrefix: string | null;
  onChange: (eventType: string | null) => void;
  value: string | null;
}) {
  const typesResult = useStreamQuery(
    database,
    eventTypePrefix == null
      ? `SELECT ${FEED_TYPE_EXPRESSION} AS event_type, SUM(event_count) AS total
         FROM feed_items GROUP BY event_type ORDER BY event_type`
      : `SELECT ${FEED_TYPE_EXPRESSION} AS event_type, SUM(event_count) AS total
         FROM feed_items WHERE ${FEED_TYPE_EXPRESSION} LIKE ?
         GROUP BY event_type ORDER BY event_type`,
    eventTypePrefix == null ? [] : [`${eventTypePrefix}%`],
  );
  const types = typesResult.data.flatMap((row) =>
    typeof row.event_type === "string"
      ? [{ count: Number(row.total ?? 0), type: row.event_type }]
      : [],
  );
  // A stale URL value (hand-edited, or events not mirrored yet) must still
  // render as the selection so it can be cleared.
  const options =
    value != null && !types.some((entry) => entry.type === value)
      ? [{ count: 0, type: value }, ...types]
      : types;

  return (
    <Select
      value={value ?? ALL_EVENT_TYPES}
      onValueChange={(next) => onChange(next === ALL_EVENT_TYPES ? null : next)}
    >
      <SelectTrigger
        size="sm"
        className="max-w-56 font-mono text-xs"
        data-testid="stream-feed-event-type"
        title="Event type"
      >
        {/* Radix can only resolve the selected item's text once the content
            has mounted; render the label ourselves. */}
        <SelectValue>{value == null ? "All event types" : shortEventType(value)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_EVENT_TYPES} className="text-xs">
          All event types
        </SelectItem>
        {options.map((entry) => (
          <SelectItem key={entry.type} value={entry.type} className="font-mono text-xs">
            {shortEventType(entry.type)} · {entry.count.toLocaleString()}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function parseFeedItemData(raw: string): FeedItemData | null {
  try {
    return JSON.parse(raw) as FeedItemData;
  } catch {
    return null;
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

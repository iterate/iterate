import { useEffect, useMemo, useState } from "react";
import { ChevronLeftIcon, DatabaseZapIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { Avatar, AvatarFallback, AvatarImage } from "@iterate-com/ui/components/avatar";
import { Sheet, SheetContent, SheetTitle } from "@iterate-com/ui/components/sheet";
import { NativeSelect, NativeSelectOption } from "@iterate-com/ui/components/native-select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@iterate-com/ui/components/tooltip";
import type {
  AgentUiPresenceEntry,
  AgentUiProcessorAnnouncement,
  AgentUiTokenUsage,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
import { cn } from "@iterate-com/ui/lib/utils";
import { ageStreamThroughputMetrics, type ProcessorRuntimeState } from "iterate/processors";
import { useIterateSessionLiveState, useLiveState } from "iterate/sdk/itx/react";
// The Stream DO's real pushed shape, typed from the domain source of truth
// (the generated itx surface mirrors it).
import type { StreamRuntimeDebugState } from "../domains/streams/stream-runtime-state.ts";
import { readAgentTokenUsageVitals } from "~/lib/agent-token-usage.ts";
import { formatBytesPerSecond, formatFileSize } from "~/lib/feed-format.ts";
import {
  AgentPrettyState,
  CorePrettyState,
  RuntimeStateStat,
  SectionHeading,
} from "~/components/stream-processor-pretty-state.tsx";
import { readNumber, readRuntimeRecord } from "~/lib/runtime-record.ts";
import { useTickingNowMs } from "~/lib/use-ticking-now-ms.ts";
import {
  presenceColorClasses,
  presenceInitials,
  sparklinePoints,
  type BrowserStreamMetricsView,
} from "~/lib/stream-presence.ts";

type PresenceAvatarEntry = Pick<
  AgentUiPresenceEntry,
  "connected" | "description" | "processor" | "user"
> &
  ({ connectionKey: string } | { key: string });

function presenceLabel(entry: PresenceAvatarEntry): string {
  return (
    entry.processor?.slug ??
    entry.description ??
    ("connectionKey" in entry ? entry.connectionKey : entry.key)
  );
}

export function PresenceAvatar({
  entry,
  busy,
  className,
}: {
  entry: PresenceAvatarEntry;
  busy: boolean;
  className?: string;
}) {
  const label = presenceLabel(entry);
  const initialsLabel = entry.user?.name ?? entry.user?.email ?? label;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Avatar className={cn("size-6 font-mono text-[9px] font-bold", className)} />}
      >
        {entry.user?.picture ? <AvatarImage src={entry.user.picture} alt="" /> : null}
        <AvatarFallback className={cn("text-[9px] font-bold", presenceColorClasses(label))}>
          {presenceInitials(initialsLabel)}
        </AvatarFallback>
        <span
          className={cn(
            "absolute -bottom-px -right-px size-2 rounded-full border-[1.5px] border-background",
            entry.connected
              ? busy
                ? "animate-pulse bg-amber-500"
                : "bg-emerald-500"
              : "bg-zinc-300 dark:bg-zinc-600",
          )}
        />
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-80">
        {!entry.user ? (
          <span>
            {!entry.processor ? `${label} callback` : `${entry.processor.slug} processor`}
          </span>
        ) : (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-left">
            <dt>Name</dt>
            <dd className="min-w-0 break-all">{entry.user.name ?? "—"}</dd>
            <dt>Email address</dt>
            <dd className="min-w-0 break-all">{entry.user.email}</dd>
            <dt>User ID</dt>
            <dd className="min-w-0 break-all">{entry.user.id ?? "—"}</dd>
          </dl>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Rows — a stream serves subscriptions and connections; nothing else
// (docs/stream-subscription-model-redesign.md)
// ---------------------------------------------------------------------------

/** The receiver kinds a subscription can be configured with. */
type SubscriptionKind = "processor-wake" | "copy-to-stream" | "itx-call" | "webhook-post";

/** Durable delivery status of one subscription, in cursor-row vocabulary. */
type SubscriptionRowStatus = "active" | "halted";

/** Cursor row + in-memory delivery metrics for one subscription. */
type SubscriptionProgress = StreamRuntimeDebugState["runtime"]["subscriptions"][string];

/** One live callback channel (session or wake feed). */
type ConnectionRuntime = StreamRuntimeDebugState["runtime"]["connections"][string];

/**
 * One durable subscription: the catalog configuration joined with its cursor
 * row. Every receiver kind renders through this same row — kinds are data,
 * never schema.
 */
type SubscriptionRow = {
  name: string;
  kind: SubscriptionKind;
  /** Which contract runs — present iff `kind` is processor-wake. Derived from
   * the subscription name: the NAME is the contract selector (name ==
   * registered slug). */
  processorSlug?: string;
  /** The processor runs as a facet of this stream's own Durable Object. */
  facet: boolean;
  /** Durable facts outrank the mirrored runtime row; absent runtime = active. */
  status: SubscriptionRowStatus;
  /** A retry is scheduled: delivery is failing but has not halted yet. */
  backoff: boolean;
  configuredAtOffset?: number;
  /** Operator-facing note from the subscription payload (why it exists). */
  description?: string;
  /** The delivery target as the itx call, copy, or POST it actually is. */
  deliveryLabel?: string;
  destinationStream?: string;
  eventTypes?: string[];
  jsonataCondition?: string;
  jsonataTransform?: string;
  start?: "beginning" | "now";
  onFailingEvent?: "halt" | "skip";
  webhookUrl?: string;
  halted?: { afterOffset: number; attempts: number; error?: string };
  /** Absent until the runtime snapshot loads. */
  progress?: SubscriptionProgress;
  /** The open wake-feed connection serving this subscription, if one is live. */
  connection?: ConnectionRuntime;
};

/** One live channel: a caller-opened session or a stream-opened wake feed. */
type ConnectionRow = {
  key: string;
  kind: "session" | "hosted";
  /** The subscription a wake feed serves (hosted connections only). */
  subscriptionName?: string;
  connected: boolean;
  description?: string;
  user?: AgentUiPresenceEntry["user"];
  processor?: AgentUiProcessorAnnouncement;
  runtime?: ConnectionRuntime;
};

/** Focus sentinel for the stream's own reduced state (kept stable across reloads). */
const CORE_STATE_KEY = "__stream-core__";

/**
 * The Stream state sheet: the stream's vitals (age, storage, events, live
 * throughput/latency), every durable subscription as one uniform catalog row
 * (name, kind, status, lag = head − confirmed, last error), and every live
 * connection (sessions and wake feeds) — with REAL RTT/lag pushed from the
 * stream's runtime LiveState while this sheet is open. Clicking a row drills
 * into its configuration, delivery stats, and (for processors) the
 * reduced-state snapshot.
 */
export function StreamStatePanel({
  open,
  onOpenChange,
  presence,
  metrics,
  eventCount,
  busy,
  focusedKey,
  onFocus,
  onBack,
  onClose,
  onClearClientDatabase,
  getProcessorRuntimeState,
  projectId,
  streamPath,
  tokenUsage = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  presence: readonly AgentUiPresenceEntry[];
  metrics: BrowserStreamMetricsView;
  eventCount: number;
  busy: boolean;
  /** Subscription name, connection key, or the core sentinel; null = overview. */
  focusedKey: string | null;
  onFocus: (key: string) => void;
  onBack: () => void;
  onClose: () => void;
  onClearClientDatabase: () => Promise<void>;
  /** Reduced-state snapshot for one processor subscription, by name. */
  getProcessorRuntimeState: (name: string) => Promise<ProcessorRuntimeState | null>;
  projectId: string | null;
  streamPath: string;
  /** Agent context fullness + lifetime totals; shown in vitals when present. */
  tokenUsage?: AgentUiTokenUsage | null;
}) {
  const projectStreamRuntime = useLiveState(
    (itx) => itx.streams.get(streamPath).liveState,
    (state): StreamRuntimeDebugState => state,
    [streamPath],
    {
      enabled: open && !!projectId,
      ...(!projectId ? {} : { slug: projectId }),
    },
  );
  const deploymentStreamRuntime = useIterateSessionLiveState(
    (session) => session.streams.get(streamPath).liveState,
    (state): StreamRuntimeDebugState => state,
    [streamPath],
    { enabled: open && !projectId },
  );
  const streamRuntimeLiveState = !projectId ? deploymentStreamRuntime : projectStreamRuntime;
  const streamRuntime = streamRuntimeLiveState.value;
  const streamRuntimeError = streamRuntimeLiveState.error;
  const streamRuntimeFetching = streamRuntimeLiveState.status === "connecting";
  const streamMaxOffset = readNumber(streamRuntime?.coreProcessorState, "maxOffset");
  const subscriptionRows = useMemo(() => buildSubscriptionRows(streamRuntime), [streamRuntime]);
  const connectionRows = useMemo(
    () => buildConnectionRows(presence, streamRuntime),
    [presence, streamRuntime],
  );
  // A stale or never-configured key (e.g. after a reconnect) falls back to the
  // overview rather than a blank detail pane.
  const focusedSubscription = subscriptionRows.find((row) => row.name === focusedKey) ?? null;
  const focusedConnection = !focusedSubscription
    ? (connectionRows.find((row) => row.key === focusedKey) ?? null)
    : null;
  const focusedCore = focusedKey === CORE_STATE_KEY;

  const [runtimeStateLoad, setRuntimeStateLoad] = useState<ProcessorRuntimeStateLoad>({
    status: "idle",
  });
  const [refreshKey, setRefreshKey] = useState(0);
  const focusedProcessorName =
    focusedSubscription?.kind === "processor-wake" ? focusedSubscription.name : null;
  const focusedWakeFeedOpen = !!focusedSubscription?.connection;
  const coreRuntimeStateLoad = useMemo<ProcessorRuntimeStateLoad>(() => {
    // Error first: the LiveState hook deliberately keeps its last value through
    // reconnects, but a drill-in must still surface the transport failure
    // instead of silently presenting that retained value as current.
    if (streamRuntimeError) {
      return { status: "error", name: CORE_STATE_KEY, message: streamRuntimeError };
    }
    if (streamRuntime) {
      const coreState = streamRuntime.coreProcessorState;
      return {
        status: "loaded",
        name: CORE_STATE_KEY,
        runtimeState: {
          snapshot: { offset: readNumber(coreState, "maxOffset") ?? 0, state: coreState },
          runtime: streamRuntime.runtime,
        },
      };
    }
    return { status: "loading", name: CORE_STATE_KEY };
  }, [streamRuntime, streamRuntimeError]);
  const focusedRuntimeStateLoad = useMemo<ProcessorRuntimeStateLoad>(() => {
    if (!focusedProcessorName) return { status: "idle" };
    return runtimeStateLoad.status !== "idle" && runtimeStateLoad.name === focusedProcessorName
      ? runtimeStateLoad
      : { status: "loading", name: focusedProcessorName };
  }, [focusedProcessorName, runtimeStateLoad]);

  useEffect(() => {
    if (!open || !focusedProcessorName) return;

    // A sleeping processor holds no wake feed; do not wake it from a debug
    // panel just to read a snapshot.
    if (!focusedWakeFeedOpen) {
      setRuntimeStateLoad({
        status: "loaded",
        name: focusedProcessorName,
        runtimeState: null,
      });
      return;
    }

    let disposed = false;
    setRuntimeStateLoad({ status: "loading", name: focusedProcessorName });
    void getProcessorRuntimeState(focusedProcessorName)
      .then((runtimeState) => {
        if (!disposed) {
          setRuntimeStateLoad({
            status: "loaded",
            name: focusedProcessorName,
            runtimeState,
          });
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setRuntimeStateLoad({
            status: "error",
            name: focusedProcessorName,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });

    return () => {
      disposed = true;
    };
  }, [focusedProcessorName, focusedWakeFeedOpen, getProcessorRuntimeState, open, refreshKey]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="flex h-full w-full flex-col gap-0 p-0 data-[side=right]:sm:w-[56vw] data-[side=right]:sm:max-w-[92vw]"
      >
        <SheetTitle className="sr-only">
          {focusedCore
            ? "Stream reduced state"
            : focusedSubscription
              ? `Subscription ${focusedSubscription.name}`
              : focusedConnection
                ? `Connection ${connectionLabel(focusedConnection)}`
                : "Stream state"}
        </SheetTitle>
        {focusedCore ? (
          <CoreStateDetail
            runtimeStateLoad={coreRuntimeStateLoad}
            streamMaxOffset={streamMaxOffset}
            onRefreshRuntimeState={streamRuntimeLiveState.refresh}
            onBack={onBack}
            onClose={onClose}
          />
        ) : focusedSubscription ? (
          <SubscriptionDetailPane
            row={focusedSubscription}
            runtimeStateLoad={focusedRuntimeStateLoad}
            streamMaxOffset={streamMaxOffset}
            onRefreshRuntimeState={() => setRefreshKey((key) => key + 1)}
            onBack={onBack}
            onClose={onClose}
          />
        ) : focusedConnection ? (
          <ConnectionDetailPane
            row={focusedConnection}
            busy={busy}
            onBack={onBack}
            onClose={onClose}
          />
        ) : (
          <StreamOverview
            subscriptionRows={subscriptionRows}
            connectionRows={connectionRows}
            metrics={metrics}
            eventCount={eventCount}
            busy={busy}
            focusedKey={focusedKey}
            onFocus={onFocus}
            onClose={onClose}
            onClearClientDatabase={onClearClientDatabase}
            onRefreshStreamRuntime={streamRuntimeLiveState.refresh}
            streamRuntimeFetching={streamRuntimeFetching}
            streamRuntimeError={streamRuntimeError}
            streamRuntime={streamRuntime}
            tokenUsage={tokenUsage}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

type ProcessorRuntimeStateLoad =
  | { status: "idle" }
  | { status: "loading"; name: string }
  | {
      status: "loaded";
      name: string;
      runtimeState: ProcessorRuntimeState | null;
    }
  | { status: "error"; name: string; message: string };

function StreamOverview({
  subscriptionRows,
  connectionRows,
  metrics,
  eventCount,
  busy,
  focusedKey,
  onFocus,
  onClose,
  onClearClientDatabase,
  onRefreshStreamRuntime,
  streamRuntimeFetching,
  streamRuntimeError,
  streamRuntime,
  tokenUsage,
}: {
  subscriptionRows: readonly SubscriptionRow[];
  connectionRows: readonly ConnectionRow[];
  metrics: BrowserStreamMetricsView;
  eventCount: number;
  busy: boolean;
  focusedKey: string | null;
  onFocus: (key: string) => void;
  onClose: () => void;
  onClearClientDatabase: () => Promise<void>;
  onRefreshStreamRuntime: () => void;
  streamRuntimeFetching: boolean;
  streamRuntimeError: string | undefined;
  streamRuntime: StreamRuntimeDebugState | undefined;
  tokenUsage: AgentUiTokenUsage | null;
}) {
  const [clearState, setClearState] = useState<"idle" | "clearing" | "error">("idle");
  const [graphMode, setGraphMode] = useState<"throughput" | "latency">("throughput");
  const rtt = metrics.transportRttMs;
  const eventConsumption = metrics.eventConsumption;
  const throughputSnapshot = streamRuntime?.runtime.metrics;
  const throughputReportedAtMs = Date.parse(throughputSnapshot?.reportedAt ?? "");
  const canAgeThroughput = !!throughputSnapshot && Number.isFinite(throughputReportedAtMs);
  const throughputNowMs = useTickingNowMs(
    1_000,
    canAgeThroughput,
    canAgeThroughput ? throughputReportedAtMs + 60_000 : null,
  );
  const throughput = useMemo(
    () =>
      !throughputSnapshot
        ? undefined
        : ageStreamThroughputMetrics(throughputSnapshot, throughputNowMs),
    [throughputNowMs, throughputSnapshot],
  );
  const coreState = streamRuntime?.coreProcessorState;
  const createdAt = readRuntimeRecord(coreState)?.createdAt;
  const serverEventCount = readNumber(coreState, "eventCount");
  const headOffset = readNumber(coreState, "maxOffset");
  const storageSizeBytes = streamRuntime?.runtime.storageSizeBytes;
  const ephemeralEvents = streamRuntime?.runtime.ephemeralEvents;
  const latencyPoints = sparklinePoints(metrics.spark, 368, 44);
  const agentTokens = !tokenUsage ? null : readAgentTokenUsageVitals(tokenUsage);

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 px-5 pb-2 pt-4">
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold">Stream state</div>
          <div className="text-xs text-muted-foreground">
            vitals · metrics · subscriptions & connections
          </div>
        </div>
        <PanelCloseButton onClose={onClose} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5 pt-2">
        <div className="rounded-2xl bg-muted/40 px-4 py-3.5">
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            <MetricStat
              label="age"
              title={
                typeof createdAt === "string" ? `Created ${createdAt}` : "Stream creation time"
              }
              value={typeof createdAt === "string" ? sinceLabel(createdAt) : "—"}
            />
            <MetricStat
              label="events"
              title="Durable events reduced into the stream's core state"
              value={
                !Number.isFinite(serverEventCount)
                  ? `${eventCount}`
                  : serverEventCount.toLocaleString()
              }
            />
            <MetricStat
              label="head"
              title="Stream head offset"
              value={!Number.isFinite(headOffset) ? `#${eventCount}` : `#${headOffset}`}
            />
            <MetricStat
              label="storage"
              title="Stream Durable Object SQLite size (event log + sending cursors)"
              value={!Number.isFinite(storageSizeBytes) ? "—" : formatFileSize(storageSizeBytes)}
            />
            <MetricStat
              label="ephemeral memory"
              title={
                !ephemeralEvents
                  ? "Memory-only ephemeral events in the current Stream Durable Object incarnation"
                  : `Memory-only ephemeral events in the current Stream Durable Object incarnation; FIFO limit ${formatFileSize(ephemeralEvents.maxBytes)}`
              }
              value={
                !ephemeralEvents
                  ? "—"
                  : `${ephemeralEvents.eventCount.toLocaleString()} · ${formatFileSize(ephemeralEvents.bytes)}`
              }
            />
            <MetricStat
              label="ephemeral evicted"
              title="Memory-only ephemeral events forgotten by FIFO eviction since this Stream Durable Object incarnation began"
              value={
                !ephemeralEvents
                  ? "—"
                  : `${ephemeralEvents.evictedEventCount.toLocaleString()} · ${formatFileSize(ephemeralEvents.evictedBytes)}`
              }
            />
            <MetricStat
              label="in · 5s"
              title="Bytes appended per second, trailing 5s"
              value={!throughput ? "—" : formatBytesPerSecond(throughput.ingress.bytesPerSecond5s)}
            />
            <MetricStat
              label="out · 5s"
              title="Bytes sent through all connections and subscriptions per second, trailing 5s"
              value={!throughput ? "—" : formatBytesPerSecond(throughput.egress.bytesPerSecond5s)}
            />
            <MetricStat
              label="append · last"
              title="Most recent append call → commit acknowledged (this browser's own appends)"
              value={
                !eventConsumption?.appendRoundTripMs
                  ? "—"
                  : `${eventConsumption.appendRoundTripMs.last}ms`
              }
            />
            <MetricStat
              label="own loop · last"
              title="Most recent append call → this browser's event connection received the committed event"
              value={
                !eventConsumption?.consumeOwnAppendMs
                  ? "—"
                  : `${eventConsumption.consumeOwnAppendMs.last}ms`
              }
            />
            <MetricStat
              label="measuring"
              title={
                !throughput
                  ? "Metrics are in-memory and reset when the stream Durable Object restarts"
                  : `Since ${throughput.measuredSince} (in-memory; resets on stream restart)`
              }
              value={!throughput ? "—" : sinceLabel(throughput.measuredSince)}
            />
            {!agentTokens ? null : (
              <>
                <MetricStat
                  label="context"
                  title={agentTokens.breakdown}
                  value={agentTokens.contextLabel}
                  valueClassName={agentTokens.contextPercent >= 80 ? "text-destructive" : undefined}
                />
                <MetricStat
                  label="tokens · in"
                  title={agentTokens.breakdown}
                  value={agentTokens.inputLabel}
                />
                <MetricStat
                  label="tokens · out"
                  title={agentTokens.breakdown}
                  value={agentTokens.outputLabel}
                />
                <MetricStat label="model" title={agentTokens.breakdown} value={agentTokens.model} />
              </>
            )}
          </div>

          <div className="mt-3 flex items-center justify-between gap-2 border-t border-border/60 pt-3">
            <NativeSelect
              size="sm"
              aria-label="Graph metric"
              value={graphMode}
              onChange={(changeEvent) =>
                setGraphMode(changeEvent.target.value === "latency" ? "latency" : "throughput")
              }
              className="w-auto"
            >
              <NativeSelectOption value="throughput">Throughput</NativeSelectOption>
              <NativeSelectOption value="latency">Latency</NativeSelectOption>
            </NativeSelect>
            <span className="font-mono text-[10px] text-muted-foreground/70">
              {graphMode === "throughput"
                ? "appends (area) · deliveries (dashed) · 1s buckets · last 60s"
                : `this browser's RTT · measured RPCs · p50 ${!rtt ? "—" : `${rtt.p50}ms`} · p95 ${!rtt ? "—" : `${rtt.p95}ms`}`}
            </span>
          </div>
          <div className="mt-2 flex items-end gap-3">
            <span className="font-mono text-2xl font-semibold leading-none">
              {graphMode === "throughput" ? (
                <>
                  {!throughput ? "—" : formatRate(throughput.ingress.perSecond5s)}
                  <span className="text-xs text-muted-foreground">ev/s · 5s</span>
                </>
              ) : (
                <>
                  {!rtt ? "—" : rtt.last}
                  <span className="text-xs text-muted-foreground">ms</span>
                </>
              )}
            </span>
            {graphMode === "throughput" ? (
              !throughput ? (
                <span className="flex-1 pb-1 text-xs text-muted-foreground/70">measuring…</span>
              ) : (
                <ThroughputGraph
                  ingress={throughput.ingress.series.counts}
                  egress={throughput.egress.series.counts}
                />
              )
            ) : metrics.spark.length === 0 ? (
              <span className="flex-1 pb-1 text-xs text-muted-foreground/70">measuring…</span>
            ) : (
              <svg viewBox="0 0 368 44" className="h-11 min-w-0 flex-1" preserveAspectRatio="none">
                <polygon points={`2,42 ${latencyPoints} 366,42`} className="fill-emerald-500/10" />
                <polyline
                  points={latencyPoints}
                  fill="none"
                  className="stroke-emerald-600"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </div>
          <div className="mt-3 flex items-center justify-end">
            <Button
              variant="ghost"
              size="sm"
              title="The stream's own reduced state (head, children, subscriptions, breaker)"
              onClick={() => onFocus(CORE_STATE_KEY)}
              className="text-muted-foreground"
            >
              Reduced state
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={streamRuntimeFetching}
              onClick={onRefreshStreamRuntime}
              className="mr-2 text-muted-foreground"
            >
              <RefreshCwIcon className={cn("size-3.5", streamRuntimeFetching && "animate-spin")} />
              Refresh
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={clearState === "clearing"}
              onClick={() => {
                setClearState("clearing");
                void onClearClientDatabase().catch(() => setClearState("error"));
              }}
              className="border-red-200 bg-background text-red-700 hover:border-red-300 hover:bg-red-50 hover:text-red-800 dark:border-red-900/70 dark:text-red-300 dark:hover:bg-red-950/30"
            >
              <DatabaseZapIcon className="size-3.5" />
              {clearState === "clearing" ? "Clearing client DB..." : "Clear client DB"}
            </Button>
          </div>
          {clearState === "error" ? (
            <div className="mt-2 text-right text-xs text-red-600 dark:text-red-400">
              Could not clear local client data.
            </div>
          ) : null}
          {!streamRuntimeError ? null : (
            <div className="mt-2 text-right text-xs text-red-600 dark:text-red-400">
              {streamRuntimeError}
            </div>
          )}
        </div>

        <div>
          <div className="grid grid-cols-[minmax(0,1fr)_52px] gap-1.5 px-3 pb-2 text-[10px] uppercase tracking-wider text-muted-foreground/70">
            <span>Subscriptions</span>
            <span className="text-right" title="head − confirmed">
              Lag
            </span>
          </div>
          <div className="flex flex-col">
            {subscriptionRows.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                No durable subscriptions are configured.
              </p>
            ) : (
              subscriptionRows.map((row) => (
                <SubscriptionRowButton
                  key={row.name}
                  row={row}
                  focused={row.name === focusedKey}
                  onFocus={onFocus}
                />
              ))
            )}
          </div>
        </div>

        <div>
          <div className="grid grid-cols-[minmax(0,1fr)_52px_44px] gap-1.5 px-3 pb-2 text-[10px] uppercase tracking-wider text-muted-foreground/70">
            <span>Connections</span>
            <span className="text-right">RTT</span>
            <span className="text-right">Lag</span>
          </div>
          <div className="flex flex-col">
            {connectionRows.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                No live connections are open.
              </p>
            ) : (
              connectionRows.map((row) => (
                <ConnectionRowButton
                  key={row.key}
                  row={row}
                  busy={busy}
                  focused={row.key === focusedKey}
                  onFocus={onFocus}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Row construction
// ---------------------------------------------------------------------------

function buildSubscriptionRows(
  streamRuntime: StreamRuntimeDebugState | undefined,
): SubscriptionRow[] {
  // Reduced state crosses the itx boundary; read it defensively so a shape
  // miss degrades to an empty catalog, never a crash.
  const record = readRuntimeRecord(streamRuntime?.coreProcessorState);
  const subscriptions = readRuntimeRecord(record?.subscriptions);
  const outbound = readRuntimeRecord(subscriptions?.outbound);
  const byName = readRuntimeRecord(outbound?.byName) ?? {};
  return Object.entries(byName)
    .flatMap(([name, value]) => {
      const row = readSubscriptionRow(name, value, streamRuntime);
      return !row ? [] : [row];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function readSubscriptionRow(
  name: string,
  value: unknown,
  streamRuntime: StreamRuntimeDebugState | undefined,
): SubscriptionRow | null {
  const configured = readRuntimeRecord(value);
  const payload = readRuntimeRecord(configured?.configuration);
  const receiver = readRuntimeRecord(payload?.receiver);
  // The v31 model split `processor-wake` into `facet-processor` and
  // `wake-processor`; this panel still renders both as one "processor-wake"
  // kind, distinguished by the `facet` flag below.
  const action = receiver?.action;
  const kind =
    action === "facet-processor" || action === "wake-processor" ? "processor-wake" : action;
  if (
    kind !== "processor-wake" &&
    kind !== "copy-to-stream" &&
    kind !== "itx-call" &&
    kind !== "webhook-post"
  ) {
    return null;
  }

  const configuredAtOffset = readNumber(configured, "configuredAtOffset") ?? undefined;
  const haltedRecord = readRuntimeRecord(configured?.deliveryHalted);
  const haltedAfterOffset = readNumber(haltedRecord, "afterOffset");
  const haltedAttempts = readNumber(haltedRecord, "attempts");
  const halted: SubscriptionRow["halted"] =
    Number.isFinite(haltedAfterOffset) && Number.isFinite(haltedAttempts)
      ? {
          afterOffset: haltedAfterOffset,
          attempts: haltedAttempts,
          ...(typeof haltedRecord?.error === "string" && { error: haltedRecord.error }),
        }
      : undefined;

  const progress = streamRuntime?.runtime.subscriptions[name];
  const connection = Object.values(streamRuntime?.runtime.connections ?? {}).find(
    (candidate) => candidate.kind === "hosted" && candidate.name === name,
  );

  const facet = action === "facet-processor";
  const delivery = readRuntimeRecord(receiver?.delivery);
  const deliveryLabel =
    kind === "webhook-post"
      ? typeof receiver?.url === "string"
        ? `POST ${receiver.url}`
        : undefined
      : kind === "copy-to-stream"
        ? typeof receiver?.receivingStreamPath === "string"
          ? `copy to ${receiver.receivingStreamPath}`
          : undefined
        : facet
          ? "in-process facet dial"
          : formatItxExpression(receiver?.expression);
  const destinationStream =
    kind === "copy-to-stream" && typeof receiver?.receivingStreamPath === "string"
      ? receiver.receivingStreamPath
      : undefined;
  const filter = readRuntimeRecord(payload?.filter);
  const eventTypes = readStringArray(filter?.eventTypes);
  const jsonataCondition =
    typeof filter?.jsonataCondition === "string" && filter.jsonataCondition.trim() !== ""
      ? filter.jsonataCondition
      : undefined;
  const jsonataTransform =
    typeof receiver?.jsonataTransform === "string" && receiver.jsonataTransform.trim() !== ""
      ? receiver.jsonataTransform
      : undefined;
  const start =
    delivery?.start === "beginning" || delivery?.start === "now" ? delivery.start : undefined;
  const onFailingEvent =
    delivery?.onFailingEvent === "halt" || delivery?.onFailingEvent === "skip"
      ? delivery.onFailingEvent
      : undefined;
  const webhookUrl =
    kind === "webhook-post" && typeof receiver?.url === "string" ? receiver.url : undefined;
  const description =
    typeof payload?.description === "string" && payload.description.trim() !== ""
      ? payload.description.trim()
      : undefined;

  return {
    name,
    kind,
    ...(kind === "processor-wake" && { processorSlug: name }),
    facet,
    // Durable facts (reduced from committed events) outrank the mirrored
    // runtime row, which may not have loaded yet.
    status: halted ? "halted" : (progress?.status ?? "active"),
    backoff: Number.isFinite(progress?.nextAttemptAt),
    ...(!Number.isFinite(configuredAtOffset) ? {} : { configuredAtOffset }),
    ...(!description ? {} : { description }),
    ...(!deliveryLabel ? {} : { deliveryLabel }),
    ...(!destinationStream ? {} : { destinationStream }),
    ...(!eventTypes ? {} : { eventTypes }),
    ...(!jsonataCondition ? {} : { jsonataCondition }),
    ...(!jsonataTransform ? {} : { jsonataTransform }),
    ...(!start ? {} : { start }),
    ...(!onFailingEvent ? {} : { onFailingEvent }),
    ...(!webhookUrl ? {} : { webhookUrl }),
    ...(!halted ? {} : { halted }),
    ...(!progress ? {} : { progress }),
    ...(!connection ? {} : { connection }),
  };
}

function buildConnectionRows(
  presence: readonly AgentUiPresenceEntry[],
  streamRuntime: StreamRuntimeDebugState | undefined,
): ConnectionRow[] {
  const rows = new Map<string, ConnectionRow>();
  const runtimeConnections = streamRuntime?.runtime.connections;

  for (const entry of presence) {
    const runtime = runtimeConnections?.[entry.connectionKey];
    rows.set(entry.connectionKey, {
      key: entry.connectionKey,
      kind: runtime?.kind ?? entry.connectionKind ?? "session",
      ...(runtime?.kind === "hosted" && { subscriptionName: runtime.name }),
      // The pushed runtime table is authoritative once it has loaded. Before
      // that first snapshot, keep the reduced presence entry visible instead
      // of making every open session disappear from the panel.
      connected: !streamRuntime ? entry.connected : !!runtime,
      ...(!entry.description ? {} : { description: entry.description }),
      ...(!entry.processor ? {} : { processor: entry.processor }),
      ...(!entry.user ? {} : { user: entry.user }),
      ...(!runtime ? {} : { runtime }),
    });
  }

  // Connections the reduced roster doesn't carry exist only in the runtime
  // table. This browser's reduced presence may have started after the
  // connection-opened event, so the runtime table decides "open now".
  for (const [key, runtime] of Object.entries(runtimeConnections ?? {})) {
    if (rows.has(key)) continue;
    const openedBy = readRuntimeRecord(runtime.openedBy);
    const announcement = readAnnouncement(openedBy?.processor);
    const user = readSubscriberUser(openedBy?.user);
    rows.set(key, {
      key,
      kind: runtime.kind,
      ...(runtime.kind === "hosted" && { subscriptionName: runtime.name }),
      connected: true,
      ...(typeof openedBy?.description === "string" && { description: openedBy.description }),
      ...(!user ? {} : { user }),
      ...(!announcement ? {} : { processor: announcement }),
      runtime,
    });
  }

  // A connection row is only meaningful while its channel is open; durable
  // intent lives in the subscription rows.
  return [...rows.values()]
    .filter((row) => row.connected)
    .sort(
      (a, b) =>
        Number(b.kind === "hosted") - Number(a.kind === "hosted") ||
        connectionLabel(a).localeCompare(connectionLabel(b)) ||
        a.key.localeCompare(b.key),
    );
}

function connectionLabel(row: ConnectionRow): string {
  return row.processor?.slug ?? row.description ?? row.key;
}

// ---------------------------------------------------------------------------
// Overview rows
// ---------------------------------------------------------------------------

/** The uniform catalog row: name · kind · status | lag. */
function SubscriptionRowButton({
  row,
  focused,
  onFocus,
}: {
  row: SubscriptionRow;
  focused: boolean;
  onFocus: (key: string) => void;
}) {
  const lag = row.progress?.lag ?? null;
  const lastError = subscriptionLastError(row);
  return (
    <button
      type="button"
      onClick={() => onFocus(row.name)}
      className={cn(
        "grid w-full grid-cols-[minmax(0,1fr)_52px] items-start gap-1.5 rounded-xl px-3 py-2 text-left hover:bg-muted/40",
        focused && "bg-muted/60 ring-1 ring-inset ring-border",
      )}
    >
      <span className="min-w-0">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          {/*
            break-all rather than truncate: names and delivery targets can be
            long, and hiding them under ellipsis is exactly what this panel
            is for.
          */}
          <span className="break-all font-mono text-xs leading-snug">{row.name}</span>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
            {subscriptionKindLabel(row)}
          </span>
          <SubscriptionStatusBadge row={row} />
        </span>
        <span className={cn("block text-xs", subscriptionStatusTone(row))}>
          {subscriptionStatusLabel(row)}
        </span>
        {!lastError ? null : (
          <span className="block truncate text-[11px] text-destructive" title={lastError}>
            {lastError}
          </span>
        )}
        <ConfiguredFilterSummary row={row} />
      </span>
      <span
        className={cn(
          "pt-0.5 text-right font-mono text-xs",
          !Number.isFinite(lag) || lag === 0 ? "text-muted-foreground" : "text-amber-600",
        )}
        title="head − confirmed"
      >
        {!Number.isFinite(lag) ? "—" : String(lag)}
      </span>
    </button>
  );
}

function ConnectionRowButton({
  row,
  busy,
  focused,
  onFocus,
}: {
  row: ConnectionRow;
  busy: boolean;
  focused: boolean;
  onFocus: (key: string) => void;
}) {
  // Real numbers only: the ping RTT when the connection owner answers pings,
  // else the last commit→settled sample. "—" until data exists — never a
  // synthesized value.
  const rttMs = row.runtime?.pingRttMs?.last ?? row.runtime?.completionLatencyMs?.last ?? null;
  const lag = row.runtime?.lag ?? null;
  return (
    <button
      type="button"
      onClick={() => onFocus(row.key)}
      className={cn(
        "grid w-full grid-cols-[minmax(0,1fr)_52px_44px] items-start gap-1.5 rounded-xl px-3 py-2 text-left hover:bg-muted/40",
        focused && "bg-muted/60 ring-1 ring-inset ring-border",
      )}
    >
      <span className="flex min-w-0 items-start gap-2.5">
        <PresenceAvatar entry={row} busy={busy && isLlmish(row)} className="mt-0.5" />
        <span className="min-w-0">
          <span className="block break-all font-mono text-xs leading-snug">
            {connectionLabel(row)}
          </span>
          <span
            className={cn(
              "block text-xs",
              busy && isLlmish(row) ? "text-amber-600" : "text-emerald-600",
            )}
          >
            {busy && isLlmish(row)
              ? "processing"
              : row.kind === "hosted"
                ? `wake feed · ${row.subscriptionName ?? "?"}`
                : "session open"}
          </span>
        </span>
      </span>
      <span className="pt-0.5 text-right font-mono text-xs text-muted-foreground">
        {!Number.isFinite(rttMs) ? "—" : `${rttMs}ms`}
      </span>
      <span
        className={cn(
          "pt-0.5 text-right font-mono text-xs",
          !Number.isFinite(lag) || lag === 0 ? "text-muted-foreground" : "text-amber-600",
        )}
      >
        {!Number.isFinite(lag) ? "—" : String(lag)}
      </span>
    </button>
  );
}

function subscriptionLastError(row: SubscriptionRow): string | null {
  return row.halted?.error ?? row.progress?.lastError ?? null;
}

function subscriptionKindLabel(row: SubscriptionRow): string {
  const slug = !row.processorSlug ? "" : ` · ${row.processorSlug}`;
  const placement = row.facet ? " · facet" : "";
  return `${row.kind}${slug}${placement}`;
}

function SubscriptionStatusBadge({ row }: { row: SubscriptionRow }) {
  const badge =
    row.status === "halted"
      ? { label: "halted", className: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300" }
      : row.backoff
        ? {
            label: "backoff",
            className: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
          }
        : null;
  if (!badge) return null;
  return (
    <span
      className={cn(
        "shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[10px] leading-none",
        badge.className,
      )}
    >
      {badge.label}
    </span>
  );
}

/**
 * The two stopped-or-struggling states are distinct on purpose: halted =
 * delivery gave up after the retry ladder; backoff = failing and retrying,
 * not stopped yet.
 */
function subscriptionStatusLabel(row: SubscriptionRow): string {
  const configured = !Number.isFinite(row.configuredAtOffset)
    ? "configured"
    : `configured #${row.configuredAtOffset}`;
  if (row.status === "halted") {
    return !row.halted
      ? `${configured} · halted`
      : `${configured} · halted after #${row.halted.afterOffset} (${row.halted.attempts} attempts)`;
  }
  if (row.backoff) {
    return `${configured} · retry backoff (attempt ${row.progress?.attempt ?? 0})`;
  }
  if (row.kind === "processor-wake") {
    return !row.connection
      ? `${configured} · woken when events are waiting`
      : `${configured} · wake feed open`;
  }
  if (row.progress) {
    return row.progress.lag === 0 ? `${configured} · confirmed to head` : `${configured} · sending`;
  }
  return configured;
}

function subscriptionStatusTone(row: SubscriptionRow): string {
  if (row.status === "halted") return "text-destructive";
  if (row.backoff) return "text-amber-600";
  if (row.connection) return "text-emerald-600";
  return "text-muted-foreground";
}

/**
 * Labeled multi-line overview under a subscription row: note, destination,
 * event types, condition. Plain "a · b · c" made event types look like path
 * fragments — explicit labels + chips trade a bit of height for scannability.
 */
function ConfiguredFilterSummary({ row }: { row: SubscriptionRow }) {
  const hasEventFilter =
    !!row.eventTypes && row.eventTypes.length > 0 && !row.eventTypes.includes("*");
  const hasExtra =
    !!row.description || !!row.destinationStream || hasEventFilter || !!row.jsonataCondition;
  if (!hasExtra) return null;

  const eventTypes = hasEventFilter
    ? row.eventTypes!
    : row.destinationStream || row.jsonataCondition || row.description
      ? null // "all event types" shown as text, not chips
      : undefined;

  return (
    <span className="mt-1.5 flex flex-col gap-1 text-[11px] leading-snug text-muted-foreground">
      {!row.description ? null : (
        <span className="text-[11px] leading-snug text-foreground/75">{row.description}</span>
      )}
      {!row.destinationStream ? null : (
        <ConfiguredFilterLine label="to">
          <span className="break-all font-mono text-foreground/80">{row.destinationStream}</span>
        </ConfiguredFilterLine>
      )}
      {!eventTypes ? null : !eventTypes ? (
        <ConfiguredFilterLine label="types">
          <span className="text-foreground/70">all event types</span>
        </ConfiguredFilterLine>
      ) : (
        <ConfiguredFilterLine label="types">
          <span className="flex min-w-0 flex-wrap gap-1">
            {eventTypes.map((type) => (
              <span
                key={type}
                title={type}
                className="rounded-md bg-violet-50 px-1.5 py-0.5 font-mono text-[10px] text-violet-700 dark:bg-violet-950 dark:text-violet-300"
              >
                {shortEventType(type)}
              </span>
            ))}
          </span>
        </ConfiguredFilterLine>
      )}
      {!row.jsonataCondition ? null : (
        <ConfiguredFilterLine label="when">
          <span className="break-all font-mono text-foreground/80">
            {row.jsonataCondition.length > 80
              ? `${row.jsonataCondition.slice(0, 77)}…`
              : row.jsonataCondition}
          </span>
        </ConfiguredFilterLine>
      )}
    </span>
  );
}

function ConfiguredFilterLine({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="flex min-w-0 items-start gap-1.5">
      <span className="w-12 shrink-0 pt-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
        {label}
      </span>
      <span className="min-w-0">{children}</span>
    </span>
  );
}

function readAnnouncement(value: unknown): AgentUiProcessorAnnouncement | null {
  const processor = readRuntimeRecord(value);
  const announcement = readRuntimeRecord(processor?.announcement);
  if (!announcement) return null;
  const slug = typeof announcement.slug === "string" ? announcement.slug : null;
  const version = typeof announcement.version === "string" ? announcement.version : null;
  const description =
    typeof announcement.description === "string" ? announcement.description : null;
  if (!slug || !version || !description) return null;
  const consumes = Array.isArray(announcement.consumes)
    ? announcement.consumes.filter((item): item is string => typeof item === "string")
    : [];
  const emits = Array.isArray(announcement.emits)
    ? announcement.emits.filter((item): item is string => typeof item === "string")
    : [];
  const ownedEvents = Array.isArray(announcement.ownedEvents)
    ? announcement.ownedEvents.flatMap((item) => {
        const event = readRuntimeRecord(item);
        return typeof event?.type === "string"
          ? [
              {
                type: event.type,
                ...(typeof event.description === "string" && { description: event.description }),
              },
            ]
          : [];
      })
    : [];
  return { slug, version, description, consumes, emits, ownedEvents };
}

function readSubscriberUser(value: unknown): AgentUiPresenceEntry["user"] {
  const user = readRuntimeRecord(value);
  if (typeof user?.email !== "string") return undefined;
  return {
    ...(typeof user.id === "string" && { id: user.id }),
    email: user.email,
    ...(typeof user.name === "string" && { name: user.name }),
    ...(typeof user.picture === "string" && { picture: user.picture }),
  };
}

function isLlmish(entry: Pick<AgentUiPresenceEntry, "processor">): boolean {
  const slug = entry.processor?.slug ?? "";
  return ["agent", "capability-host"].includes(slug);
}

/**
 * Both throughput directions on one shared scale: ingress (appends) as the
 * filled area, egress (deliveries) as the dashed line — comparable at a
 * glance, and honest about which direction spiked.
 */
function ThroughputGraph({ ingress, egress }: { ingress: number[]; egress: number[] }) {
  const peak = Math.max(...ingress, ...egress);
  // The scale floors at 5/s so single events don't render as mountains; the
  // tooltip reports the TRUE peak, not the floored axis.
  const max = Math.max(5, peak);
  const ingressPoints = sparklinePoints(ingress, 368, 44, { max });
  const egressPoints = sparklinePoints(egress, 368, 44, { max });
  return (
    <svg viewBox="0 0 368 44" className="h-11 min-w-0 flex-1" preserveAspectRatio="none">
      <title>{`Appends (area) and deliveries (dashed) per second over the last 60s; peak ${peak}/s`}</title>
      <polygon points={`2,42 ${ingressPoints} 366,42`} className="fill-sky-500/15" />
      <polyline
        points={ingressPoints}
        fill="none"
        className="stroke-sky-600"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <polyline
        points={egressPoints}
        fill="none"
        strokeDasharray="3 2"
        className="stroke-emerald-600/80"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Rates jitter less as "12" / "3.4" / "0.2" than as raw floats. */
function formatRate(perSecond: number): string {
  if (perSecond >= 10) return String(Math.round(perSecond));
  return perSecond.toFixed(1);
}

/** Compact "how long ago" caption. */
function sinceLabel(sinceIso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(sinceIso)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function MetricStat({
  label,
  value,
  title,
  valueClassName,
}: {
  label: string;
  value: string;
  title?: string;
  valueClassName?: string;
}) {
  return (
    <div {...(!title ? {} : { title })}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70">{label}</div>
      <div className={cn("mt-0.5 font-mono text-sm", valueClassName)}>{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail panes
// ---------------------------------------------------------------------------

function DetailHeader({
  title,
  subtitle,
  subtitleClassName,
  avatar,
  onBack,
  onClose,
}: {
  title: React.ReactNode;
  subtitle: React.ReactNode;
  subtitleClassName?: string;
  avatar?: React.ReactNode;
  onBack: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2.5 px-4 pb-2 pt-3.5">
      <Button variant="ghost" size="icon-sm" title="Stream state overview" onClick={onBack}>
        <ChevronLeftIcon />
      </Button>
      {avatar}
      <div className="min-w-0 flex-1">
        <div className="break-all font-mono text-sm font-semibold leading-snug">{title}</div>
        <div className={cn("text-xs", subtitleClassName ?? "text-muted-foreground")}>
          {subtitle}
        </div>
      </div>
      <PanelCloseButton onClose={onClose} />
    </div>
  );
}

function SubscriptionDetailPane({
  row,
  runtimeStateLoad,
  streamMaxOffset,
  onRefreshRuntimeState,
  onBack,
  onClose,
}: {
  row: SubscriptionRow;
  runtimeStateLoad: ProcessorRuntimeStateLoad;
  streamMaxOffset: number | null;
  onRefreshRuntimeState: () => void;
  onBack: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <DetailHeader
        title={row.name}
        subtitle={`${subscriptionKindLabel(row)} · ${subscriptionStatusLabel(row)}`}
        subtitleClassName={subscriptionStatusTone(row)}
        onBack={onBack}
        onClose={onClose}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5 pt-2">
        <SubscriptionConfigDetail row={row} />
        <SubscriptionDeliveryStats row={row} />
        {row.kind === "processor-wake" ? (
          <ProcessorRuntimeStateView
            runtimeStateLoad={runtimeStateLoad}
            streamMaxOffset={streamMaxOffset}
            onRefresh={onRefreshRuntimeState}
            processorSlug={row.processorSlug}
          />
        ) : null}
        <div>
          <SectionHeading>Subscription name</SectionHeading>
          <div className="rounded-xl bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground break-all">
            {row.name}
          </div>
        </div>
      </div>
    </>
  );
}

function ConnectionDetailPane({
  row,
  busy,
  onBack,
  onClose,
}: {
  row: ConnectionRow;
  busy: boolean;
  onBack: () => void;
  onClose: () => void;
}) {
  const processor = row.processor;
  return (
    <>
      <DetailHeader
        title={connectionLabel(row)}
        subtitle={
          row.kind === "hosted" ? `wake feed · ${row.subscriptionName ?? "?"}` : "session open"
        }
        subtitleClassName={row.connected ? "text-emerald-600" : "text-muted-foreground/60"}
        avatar={
          <PresenceAvatar entry={row} busy={busy && isLlmish(row)} className="size-7 text-[10px]" />
        }
        onBack={onBack}
        onClose={onClose}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5 pt-2">
        {!row.user ? null : <SubscriberUserDetail user={row.user} />}
        {!processor ? (
          <p className="text-sm leading-relaxed text-muted-foreground">
            {row.description ?? "This connection owner did not announce a processor contract."}
          </p>
        ) : (
          <>
            <p className="text-sm leading-relaxed text-foreground/70">{processor.description}</p>
            <ContractEventChips heading="Consumes" types={processor.consumes} tone="muted" />
            <ContractEventChips heading="Emits" types={processor.emits} tone="blue" />
            <div>
              <SectionHeading>Owned events</SectionHeading>
              {processor.ownedEvents.length === 0 ? (
                <span className="text-xs text-muted-foreground/70">none</span>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {processor.ownedEvents.map((owned) => (
                    <div key={owned.type} className="rounded-xl bg-muted/40 px-3 py-2">
                      <div className="truncate font-mono text-xs">{shortEventType(owned.type)}</div>
                      {!owned.description ? null : (
                        <div className="truncate text-xs text-muted-foreground">
                          {owned.description}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
        <ConnectionStats runtime={row.runtime} />
        <div>
          <SectionHeading>Connection key</SectionHeading>
          <div className="rounded-xl bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground break-all">
            {row.key}
          </div>
        </div>
      </div>
    </>
  );
}

function CoreStateDetail({
  runtimeStateLoad,
  streamMaxOffset,
  onRefreshRuntimeState,
  onBack,
  onClose,
}: {
  runtimeStateLoad: ProcessorRuntimeStateLoad;
  streamMaxOffset: number | null;
  onRefreshRuntimeState: () => void;
  onBack: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <DetailHeader
        title="stream"
        subtitle="the stream's own reduced state — head, children, subscriptions, breaker"
        onBack={onBack}
        onClose={onClose}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5 pt-2">
        <ProcessorRuntimeStateView
          runtimeStateLoad={runtimeStateLoad}
          streamMaxOffset={streamMaxOffset}
          onRefresh={onRefreshRuntimeState}
          processorSlug="core"
        />
      </div>
    </>
  );
}

function SubscriberUserDetail({ user }: { user: NonNullable<AgentUiPresenceEntry["user"]> }) {
  return (
    <div>
      <SectionHeading>User</SectionHeading>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-xl bg-muted/40 px-4 py-3 font-mono text-xs">
        <dt className="text-muted-foreground">Name</dt>
        <dd className="min-w-0 break-all">{user.name ?? "—"}</dd>
        <dt className="text-muted-foreground">Email address</dt>
        <dd className="min-w-0 break-all">{user.email}</dd>
        <dt className="text-muted-foreground">User ID</dt>
        <dd className="min-w-0 break-all">{user.id ?? "—"}</dd>
      </dl>
    </div>
  );
}

/** Human-readable configuration for one stored subscription. */
function SubscriptionConfigDetail({ row }: { row: SubscriptionRow }) {
  const heading =
    row.kind === "copy-to-stream"
      ? "Copy destination"
      : row.kind === "webhook-post"
        ? "Webhook POST"
        : row.kind === "itx-call"
          ? "ITX-expression receiver"
          : "Hosted processor";
  const eventTypes = !row.eventTypes || row.eventTypes.includes("*") ? null : row.eventTypes;
  const startLabel = !row.start
    ? null
    : row.start === "beginning"
      ? "beginning (all history)"
      : "now (from configure time)";
  const genericBlurb =
    row.kind === "copy-to-stream"
      ? "Matching events are appended to the destination stream in order with source provenance."
      : row.kind === "webhook-post"
        ? "Each matching event is POSTed as JSON to the configured URL; a 2xx response acknowledges it."
        : row.kind === "itx-call"
          ? "Matching events are delivered in awaited batches to the configured ITX expression."
          : row.facet
            ? "The processor runs as a facet of this stream's own Durable Object: the subscription name is the facet name and delivery is an in-process dial."
            : "The hosted processor stores its checkpoint. When events are waiting, the source calls it and sends batches through the returned callback.";

  return (
    <div className="flex flex-col gap-3">
      <div>
        <SectionHeading>{heading}</SectionHeading>
        <p className="text-sm leading-relaxed text-foreground/70">
          {row.description ?? genericBlurb}
        </p>
        {!row.description ? null : (
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{genericBlurb}</p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {!row.deliveryLabel ? null : (
          <DetailField label="delivers to" mono>
            {row.deliveryLabel}
          </DetailField>
        )}
        {!row.processorSlug ? null : (
          <DetailField label="contract" mono>
            {row.processorSlug}
          </DetailField>
        )}
        {!row.destinationStream ? null : (
          <DetailField label="destination stream" mono>
            {row.destinationStream}
          </DetailField>
        )}
        {!row.webhookUrl || row.deliveryLabel ? null : (
          <DetailField label="url" mono>
            {row.webhookUrl}
          </DetailField>
        )}
        {!startLabel ? null : <DetailField label="starts from">{startLabel}</DetailField>}
        {!row.onFailingEvent ? null : (
          <DetailField label="on failing event">{row.onFailingEvent}</DetailField>
        )}
      </div>

      <div>
        <SectionHeading>Receives these events</SectionHeading>
        {!eventTypes ? (
          <span className="text-xs text-muted-foreground">
            All event types
            {!row.jsonataCondition ? "" : " matching the condition below"}
          </span>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {eventTypes.map((type) => (
              <span
                key={type}
                className="rounded-full bg-violet-50 px-2.5 py-0.5 font-mono text-[10px] text-violet-700 dark:bg-violet-950 dark:text-violet-300"
                title={type}
              >
                {shortEventType(type)}
              </span>
            ))}
          </div>
        )}
      </div>

      {!row.jsonataCondition ? null : (
        <div>
          <SectionHeading>Condition</SectionHeading>
          <div className="rounded-xl bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed text-foreground/80 break-all whitespace-pre-wrap">
            {row.jsonataCondition}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            JSONata over the whole event — must evaluate to exactly true.
          </p>
        </div>
      )}

      {!row.jsonataTransform ? null : (
        <div>
          <SectionHeading>Transform</SectionHeading>
          <div className="rounded-xl bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed text-foreground/80 break-all whitespace-pre-wrap">
            {row.jsonataTransform}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            JSONata constructor shaping the delivered event body. Omitted fields copy verbatim;
            delivery keeps the real source coordinates for provenance and deduplication.
          </p>
        </div>
      )}
    </div>
  );
}

function DetailField({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="rounded-xl bg-muted/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70">{label}</div>
      <div className={cn("mt-0.5 text-sm break-all", mono && "font-mono text-xs")}>{children}</div>
    </div>
  );
}

/**
 * The cursor row, verbatim: the confirmed offset, lag (head − confirmed),
 * retry facts, and last error. Same fields for every receiver kind.
 */
function SubscriptionDeliveryStats({ row }: { row: SubscriptionRow }) {
  const progress = row.progress;
  const lastError = subscriptionLastError(row);
  return (
    <div>
      <SectionHeading>Delivery</SectionHeading>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <RuntimeStateStat
          label="status"
          value={row.backoff ? `${row.status} · backoff` : row.status}
        />
        <RuntimeStateStat
          label="confirmed"
          value={!progress ? "—" : `#${progress.confirmedOffset}`}
        />
        <RuntimeStateStat label="lag" value={!progress ? "—" : String(progress.lag)} />
        <RuntimeStateStat
          label="sent"
          value={!Number.isFinite(progress?.bytesSent) ? "—" : formatFileSize(progress.bytesSent)}
        />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <RuntimeStateStat
          label="settle"
          value={(() => {
            const stats = progress?.completionLatencyMs;
            return !stats ? "—" : `${stats.last}ms · p95 ${stats.p95}ms`;
          })()}
        />
        <RuntimeStateStat
          label="call rtt"
          value={(() => {
            const stats = progress?.deliveryDurationMs;
            return !stats ? "—" : `${stats.last}ms · p95 ${stats.p95}ms`;
          })()}
        />
      </div>
      {!Number.isFinite(row.configuredAtOffset) &&
      !row.halted &&
      !Number.isFinite(progress?.nextAttemptAt) &&
      !lastError ? null : (
        <div className="mt-2 rounded-xl bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {!Number.isFinite(row.configuredAtOffset) ? null : (
            <div>configured at #{row.configuredAtOffset}</div>
          )}
          {!row.halted ? null : (
            <div className="text-destructive">
              halted after #{row.halted.afterOffset} after {row.halted.attempts} attempts
            </div>
          )}
          {!Number.isFinite(progress?.nextAttemptAt) ? null : (
            <div>next attempt {new Date(progress.nextAttemptAt).toLocaleString()}</div>
          )}
          {!lastError ? null : <div className="mt-1 text-destructive">{lastError}</div>}
          {!Number.isFinite(progress?.bytesSent) && row.kind !== "processor-wake" ? (
            <div className="mt-1 text-muted-foreground/80">
              Delivery volume (bytes) resets when this stream Durable Object restarts — there is no
              durable delivery-volume counter.
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Live channel metrics for one open connection. */
function ConnectionStats({ runtime }: { runtime: ConnectionRuntime | undefined }) {
  if (!runtime) return null;
  return (
    <div>
      <SectionHeading>Channel</SectionHeading>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <RuntimeStateStat label="delivered" value={`#${runtime.deliveredThroughOffset}`} />
        <RuntimeStateStat label="lag" value={String(runtime.lag)} />
        <RuntimeStateStat
          label="ping rtt"
          value={
            !runtime.pingRttMs
              ? "—"
              : `${runtime.pingRttMs.last}ms · p95 ${runtime.pingRttMs.p95}ms`
          }
        />
        <RuntimeStateStat
          label="settle"
          value={
            !runtime.completionLatencyMs
              ? "—"
              : `${runtime.completionLatencyMs.last}ms · p95 ${runtime.completionLatencyMs.p95}ms`
          }
        />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <RuntimeStateStat
          label="sent"
          value={`${runtime.eventsSent} ev · ${formatFileSize(runtime.bytesSent)}`}
        />
        <RuntimeStateStat label="batches" value={String(runtime.batchesSent)} />
        <RuntimeStateStat label="opened" value={`${sinceLabel(runtime.startedAt)} ago`} />
        <RuntimeStateStat label="in flight" value={runtime.hasPendingDelivery ? "yes" : "no"} />
      </div>
    </div>
  );
}

function ProcessorRuntimeStateView({
  runtimeStateLoad,
  streamMaxOffset,
  onRefresh,
  processorSlug,
}: {
  runtimeStateLoad: ProcessorRuntimeStateLoad;
  streamMaxOffset: number | null;
  onRefresh: () => void;
  processorSlug?: string;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const runtimeState = runtimeStateLoad.status === "loaded" ? runtimeStateLoad.runtimeState : null;
  const snapshot = runtimeState?.snapshot;
  const lag =
    !snapshot || !Number.isFinite(streamMaxOffset)
      ? null
      : Math.max(0, streamMaxOffset - snapshot.offset);
  const isAgent = processorSlug === "agent";
  const isCore = processorSlug === "core";
  const refreshPending =
    runtimeStateLoad.status === "loading" || runtimeStateLoad.status === "idle";

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <SectionHeading>Reduced state</SectionHeading>
        <div className="flex items-center gap-1">
          {!snapshot ? null : (
            <Button
              variant="ghost"
              size="sm"
              title={showRaw ? "Show pretty state" : "Show raw YAML/JSON"}
              onClick={() => setShowRaw((value) => !value)}
              className="h-6 px-2 text-[10px] text-muted-foreground"
            >
              {showRaw ? "Pretty" : "Raw"}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            title="Refresh reduced state"
            disabled={refreshPending}
            onClick={onRefresh}
            className="size-6 text-muted-foreground"
          >
            <RefreshCwIcon className={cn("size-3.5", refreshPending && "animate-spin")} />
          </Button>
        </div>
      </div>
      {runtimeStateLoad.status === "loading" || runtimeStateLoad.status === "idle" ? (
        <RuntimeStateMessage>Loading reduced state…</RuntimeStateMessage>
      ) : runtimeStateLoad.status === "error" ? (
        <RuntimeStateMessage tone="error">{runtimeStateLoad.message}</RuntimeStateMessage>
      ) : !runtimeState ? (
        <RuntimeStateMessage>
          The processor is asleep (no wake feed is open), so there is no live snapshot to read.
        </RuntimeStateMessage>
      ) : !snapshot ? (
        <RuntimeStateMessage>Runtime state did not include a snapshot.</RuntimeStateMessage>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            <RuntimeStateStat label="offset" value={`#${snapshot.offset}`} />
            <RuntimeStateStat label="lag" value={lag === 0 ? "0" : `+${lag}`} />
          </div>
          {showRaw ? (
            <SerializedObjectCodeBlock className="max-h-[28rem]" data={snapshot.state} />
          ) : isCore ? (
            <CorePrettyState state={snapshot.state} runtime={runtimeState.runtime} />
          ) : !isAgent ? (
            <SerializedObjectCodeBlock className="max-h-[28rem]" data={snapshot.state} />
          ) : (
            <AgentPrettyState state={snapshot.state} />
          )}
          {!runtimeState.runtime ? null : (
            <div>
              <SectionHeading>Runtime</SectionHeading>
              <SerializedObjectCodeBlock className="max-h-60" data={runtimeState.runtime} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RuntimeStateMessage({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "error";
}) {
  return (
    <div
      className={cn(
        "rounded-xl bg-muted/40 px-3 py-2 text-xs",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}

function ContractEventChips({
  heading,
  types,
  tone,
}: {
  heading: string;
  types: readonly string[];
  tone: "muted" | "blue";
}) {
  return (
    <div>
      <SectionHeading>{heading}</SectionHeading>
      {types.length === 0 ? (
        <span className="text-xs text-muted-foreground/70">none</span>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {types.map((type) => (
            <span
              key={type}
              className={cn(
                "rounded-full px-2.5 py-0.5 font-mono text-[10px]",
                tone === "blue"
                  ? "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                  : "bg-muted text-foreground/70",
              )}
            >
              {shortEventType(type)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A persisted delivery expression rendered as the itx call it names:
 * `["processEventBatch"]` → `itx.processEventBatch()` — receivers are
 * labeled by the method the stream actually calls, not a generic category name.
 */
function formatItxExpression(expression: unknown): string | undefined {
  if (!Array.isArray(expression) || expression.length === 0) return undefined;
  const steps: string[] = [];
  for (const step of expression) {
    if (typeof step === "string") {
      steps.push(step);
    } else if (Array.isArray(step) && typeof step[0] === "string") {
      const args = step
        .slice(1)
        .map((arg) => {
          try {
            return JSON.stringify(arg);
          } catch {
            return "…";
          }
        })
        .join(", ");
      steps.push(`${step[0]}(${args})`);
    } else {
      return undefined;
    }
  }
  const call = steps.join(".");
  return `itx.${call.endsWith(")") ? call : `${call}()`}`;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter(
    (item): item is string => typeof item === "string" && item.trim() !== "",
  );
  return items.length === 0 ? undefined : items;
}

function shortEventType(type: string): string {
  return type.replace("events.iterate.com/", "");
}

function PanelCloseButton({ onClose }: { onClose: () => void }) {
  return (
    <Button variant="ghost" size="icon-sm" title="Close" onClick={onClose}>
      <XIcon className="size-3.5" />
    </Button>
  );
}

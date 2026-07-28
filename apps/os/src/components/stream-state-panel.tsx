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
import type { StreamRuntimeDebugState } from "../itx-api.generated.ts";
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

function eventReceiverLabel(entry: PresenceAvatarEntry): string {
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
  const label = eventReceiverLabel(entry);
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
        {entry.user == null ? (
          <span>
            {entry.processor == null ? `${label} callback` : `${entry.processor.slug} processor`}
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
// Panel
// ---------------------------------------------------------------------------

/**
 * The Stream state sheet: the stream's vitals (age, storage, events, live
 * throughput/latency) plus every live callback and durable subscription — with REAL RTT/lag pushed from
 * the stream's runtime LiveState while this sheet is open. Clicking a
 * receiver drills into its announced contract and self-reported metrics.
 */
/** Stored instruction for sending matching events to one receiver. */
type SubscriptionDetails = {
  subscriptionAction: "processor-wake" | "copy-to-stream" | "itx-call" | "webhook-post";
  configuredAtOffset?: number;
  halted?: {
    reason: "delivery-failed";
    afterOffset: number;
    attempts: number;
    error?: string;
  };
  /** The delivery target as the itx call (or webhook POST) it actually is. */
  deliveryLabel?: string;
  /** Destination path for a copy. */
  destinationStream?: string;
  /**
   * Optional operator-facing note from the subscription payload
   * (why this subscription exists). Distinct from the delivery label used as
   * the row title.
   */
  note?: string;
  /** Filter event types; absent means every type. */
  eventTypes?: string[];
  /** Optional JSONata filter over the whole event. */
  jsonataCondition?: string;
  /** Optional JSONata constructor shaping the delivered event body (copy, ITX call, webhook). */
  jsonataTransform?: string;
  start?: "beginning" | "now";
  onFailingEvent?: "halt" | "skip";
  webhookUrl?: string;
};

type ProcessorPanelEntry = {
  key: string;
  rowKind: "core-processor" | "processor-wake" | "durable-subscription" | "live-callback";
  connected: boolean;
  description?: string;
  user?: AgentUiPresenceEntry["user"];
  processor?: AgentUiProcessorAnnouncement;
  connectionKind?: "hosted" | "session";
  subscriptionAction?: SubscriptionDetails["subscriptionAction"];
  configuredAtOffset?: number;
  /** Full configured payload details when this entry comes from a subscription. */
  config?: SubscriptionDetails;
  subscriptionProgress?: StreamRuntimeDebugState["runtime"]["subscriptions"][string];
  runtimeConnection?: StreamRuntimeDebugState["runtime"]["connections"][string];
  receivingStreamPath?: string;
};

const CORE_PROCESSOR_KEY = "__stream-core__";
const CORE_PROCESSOR_ANNOUNCEMENT: AgentUiProcessorAnnouncement = {
  slug: "core",
  version: "0.1.0",
  description:
    "Maintains the stream's own reduced state: head offset, child streams, subscriptions, pause state, and append circuit breaker.",
  consumes: ["*"],
  emits: [
    "events.iterate.com/stream/connection-opened",
    "events.iterate.com/stream/connection-closed",
    "events.iterate.com/stream/subscription-configured",
    "events.iterate.com/stream/subscription-delivery-halted",
    "events.iterate.com/stream/subscription-delivery-resumed",
  ],
  ownedEvents: [
    { type: "events.iterate.com/stream/created" },
    { type: "events.iterate.com/stream/woken" },
    { type: "events.iterate.com/stream/configured" },
    { type: "events.iterate.com/stream/subscription-configured" },
    { type: "events.iterate.com/stream/subscription-removed" },
    { type: "events.iterate.com/stream/connection-opened" },
    { type: "events.iterate.com/stream/connection-closed" },
    { type: "events.iterate.com/stream/paused" },
    { type: "events.iterate.com/stream/resumed" },
  ],
};

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
  /** Connection or subscription key of the focused row; null = overview. */
  focusedKey: string | null;
  onFocus: (subscriptionKey: string) => void;
  onBack: () => void;
  onClose: () => void;
  onClearClientDatabase: () => Promise<void>;
  getProcessorRuntimeState: (subscriptionKey: string) => Promise<ProcessorRuntimeState | null>;
  projectId: string | null;
  streamPath: string;
  /** Agent context fullness + lifetime totals; shown in vitals when present. */
  tokenUsage?: AgentUiTokenUsage | null;
}) {
  const projectStreamRuntime = useLiveState(
    (itx) => itx.streams.get(streamPath).liveState,
    (state) => state,
    [streamPath],
    {
      enabled: open && projectId !== null,
      ...(projectId === null ? {} : { slug: projectId }),
    },
  );
  const deploymentStreamRuntime = useIterateSessionLiveState(
    (session) => session.streams.get(streamPath).liveState,
    (state) => state,
    [streamPath],
    { enabled: open && projectId === null },
  );
  const streamRuntimeLiveState =
    projectId === null ? deploymentStreamRuntime : projectStreamRuntime;
  const streamRuntime = streamRuntimeLiveState.value;
  const streamRuntimeError = streamRuntimeLiveState.error;
  const streamRuntimeFetching = streamRuntimeLiveState.status === "connecting";
  const streamMaxOffset = readNumber(streamRuntime?.coreProcessorState, "maxOffset");
  const entries = useMemo(
    () => buildProcessorPanelEntries(presence, streamRuntime),
    [presence, streamRuntime],
  );
  // A stale or never-connected key (e.g. after a reconnect) falls back to the
  // overview rather than a blank detail pane.
  const focused = entries.find((entry) => entry.key === focusedKey) ?? null;
  const focusedEntryKey = focused?.key ?? null;
  const focusedKind = focused?.rowKind ?? null;
  const focusedConnected = focused?.connected ?? false;
  const [runtimeStateLoad, setRuntimeStateLoad] = useState<ProcessorRuntimeStateLoad>({
    status: "idle",
  });
  const [refreshKey, setRefreshKey] = useState(0);
  const focusedRuntimeStateLoad = useMemo<ProcessorRuntimeStateLoad>(() => {
    if (focusedEntryKey == null) return { status: "idle" };

    if (focusedKind === "core-processor") {
      // Error first: the LiveState hook deliberately keeps its last value through
      // reconnects, but a drill-in must still surface the transport failure
      // instead of silently presenting that retained value as current.
      if (streamRuntimeError !== undefined) {
        return {
          status: "error",
          subscriptionKey: focusedEntryKey,
          message: streamRuntimeError,
        };
      }
      if (streamRuntime !== undefined) {
        const coreState = streamRuntime.coreProcessorState;
        return {
          status: "loaded",
          subscriptionKey: focusedEntryKey,
          runtimeState: {
            snapshot: { offset: readNumber(coreState, "maxOffset") ?? 0, state: coreState },
            runtime: streamRuntime.runtime,
          },
        };
      }
      return { status: "loading", subscriptionKey: focusedEntryKey };
    }

    return runtimeStateLoad.status !== "idle" &&
      runtimeStateLoad.subscriptionKey === focusedEntryKey
      ? runtimeStateLoad
      : { status: "loading", subscriptionKey: focusedEntryKey };
  }, [focusedKind, focusedEntryKey, runtimeStateLoad, streamRuntime, streamRuntimeError]);

  useEffect(() => {
    if (!open || focusedEntryKey == null || focusedKind === "core-processor") {
      return;
    }

    if (!focusedConnected) {
      setRuntimeStateLoad({
        status: "loaded",
        subscriptionKey: focusedEntryKey,
        runtimeState: null,
      });
      return;
    }

    let disposed = false;
    setRuntimeStateLoad({ status: "loading", subscriptionKey: focusedEntryKey });
    void getProcessorRuntimeState(focusedEntryKey)
      .then((runtimeState) => {
        if (!disposed) {
          setRuntimeStateLoad({
            status: "loaded",
            subscriptionKey: focusedEntryKey,
            runtimeState,
          });
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setRuntimeStateLoad({
            status: "error",
            subscriptionKey: focusedEntryKey,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });

    return () => {
      disposed = true;
    };
  }, [focusedConnected, focusedKind, focusedEntryKey, getProcessorRuntimeState, open, refreshKey]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="flex h-full w-full flex-col gap-0 p-0 data-[side=right]:sm:w-[56vw] data-[side=right]:sm:max-w-[92vw]"
      >
        <SheetTitle className="sr-only">
          {focused == null ? "Stream state" : `Event receiver ${eventReceiverLabel(focused)}`}
        </SheetTitle>
        {focused == null ? (
          <ProcessorsOverview
            entries={entries}
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
        ) : (
          <ProcessorDetail
            entry={focused}
            busy={busy}
            runtimeStateLoad={focusedRuntimeStateLoad}
            streamMaxOffset={streamMaxOffset}
            onRefreshRuntimeState={() => {
              if (focused.rowKind === "core-processor") {
                streamRuntimeLiveState.refresh();
              } else {
                setRefreshKey((key) => key + 1);
              }
            }}
            onBack={onBack}
            onClose={onClose}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

type ProcessorRuntimeStateLoad =
  | { status: "idle" }
  | { status: "loading"; subscriptionKey: string }
  | {
      status: "loaded";
      subscriptionKey: string;
      runtimeState: ProcessorRuntimeState | null;
    }
  | { status: "error"; subscriptionKey: string; message: string };

function ProcessorsOverview({
  entries,
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
  entries: readonly ProcessorPanelEntry[];
  metrics: BrowserStreamMetricsView;
  eventCount: number;
  busy: boolean;
  focusedKey: string | null;
  onFocus: (subscriptionKey: string) => void;
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
  const sections = processorEntrySections(entries);
  const rtt = metrics.transportRttMs;
  const eventConsumption = metrics.eventConsumption;
  const throughputSnapshot = streamRuntime?.runtime.metrics;
  const throughputReportedAtMs = Date.parse(throughputSnapshot?.reportedAt ?? "");
  const canAgeThroughput =
    throughputSnapshot !== undefined && Number.isFinite(throughputReportedAtMs);
  const throughputNowMs = useTickingNowMs(
    1_000,
    canAgeThroughput,
    canAgeThroughput ? throughputReportedAtMs + 60_000 : null,
  );
  const throughput = useMemo(
    () =>
      throughputSnapshot === undefined
        ? undefined
        : ageStreamThroughputMetrics(throughputSnapshot, throughputNowMs),
    [throughputNowMs, throughputSnapshot],
  );
  const coreState = streamRuntime?.coreProcessorState;
  const createdAt = readRuntimeRecord(coreState)?.createdAt;
  const serverEventCount = readNumber(coreState, "eventCount");
  const headOffset = readNumber(coreState, "maxOffset");
  const storageSizeBytes = streamRuntime?.runtime.storageSizeBytes;
  const latencyPoints = sparklinePoints(metrics.spark, 368, 44);
  const agentTokens = tokenUsage == null ? null : readAgentTokenUsageVitals(tokenUsage);

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 px-5 pb-2 pt-4">
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold">Stream state</div>
          <div className="text-xs text-muted-foreground">
            vitals · metrics · callbacks & subscriptions
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
              title="Events committed over the stream's lifetime"
              value={
                serverEventCount === null ? `${eventCount}` : serverEventCount.toLocaleString()
              }
            />
            <MetricStat
              label="head"
              title="Stream head offset"
              value={headOffset === null ? `#${eventCount}` : `#${headOffset}`}
            />
            <MetricStat
              label="storage"
              title="Stream Durable Object SQLite size (event log + sending cursors)"
              value={storageSizeBytes === undefined ? "—" : formatFileSize(storageSizeBytes)}
            />
            <MetricStat
              label="in · 5s"
              title="Bytes appended per second, trailing 5s"
              value={
                throughput === undefined
                  ? "—"
                  : formatBytesPerSecond(throughput.ingress.bytesPerSecond5s)
              }
            />
            <MetricStat
              label="out · 5s"
              title="Bytes sent through all callbacks and subscriptions per second, trailing 5s"
              value={
                throughput === undefined
                  ? "—"
                  : formatBytesPerSecond(throughput.egress.bytesPerSecond5s)
              }
            />
            <MetricStat
              label="append · last"
              title="Most recent append call → commit acknowledged (this browser's own appends)"
              value={
                eventConsumption?.appendRoundTripMs == null
                  ? "—"
                  : `${eventConsumption.appendRoundTripMs.last}ms`
              }
            />
            <MetricStat
              label="own loop · last"
              title="Most recent append call → this browser's event connection received the committed event"
              value={
                eventConsumption?.consumeOwnAppendMs == null
                  ? "—"
                  : `${eventConsumption.consumeOwnAppendMs.last}ms`
              }
            />
            <MetricStat
              label="measuring"
              title={
                throughput === undefined
                  ? "Metrics are in-memory and reset when the stream Durable Object restarts"
                  : `Since ${throughput.measuredSince} (in-memory; resets on stream restart)`
              }
              value={throughput === undefined ? "—" : sinceLabel(throughput.measuredSince)}
            />
            {agentTokens == null ? null : (
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
                : `this browser's RTT · measured RPCs · p50 ${rtt === null ? "—" : `${rtt.p50}ms`} · p95 ${rtt === null ? "—" : `${rtt.p95}ms`}`}
            </span>
          </div>
          <div className="mt-2 flex items-end gap-3">
            <span className="font-mono text-2xl font-semibold leading-none">
              {graphMode === "throughput" ? (
                <>
                  {throughput === undefined ? "—" : formatRate(throughput.ingress.perSecond5s)}
                  <span className="text-xs text-muted-foreground">ev/s · 5s</span>
                </>
              ) : (
                <>
                  {rtt === null ? "—" : rtt.last}
                  <span className="text-xs text-muted-foreground">ms</span>
                </>
              )}
            </span>
            {graphMode === "throughput" ? (
              throughput === undefined ? (
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
          <div className="mt-3 flex justify-end">
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
          {streamRuntimeError === undefined ? null : (
            <div className="mt-2 text-right text-xs text-red-600 dark:text-red-400">
              {streamRuntimeError}
            </div>
          )}
        </div>
        {sections.map((section) => (
          <ProcessorEntrySection
            key={section.title}
            title={section.title}
            emptyLabel={section.emptyLabel}
            entries={section.entries}
            busy={busy}
            focusedKey={focusedKey}
            onFocus={onFocus}
          />
        ))}
      </div>
    </>
  );
}

function ProcessorEntrySection({
  title,
  emptyLabel,
  entries,
  busy,
  focusedKey,
  onFocus,
}: {
  title: string;
  emptyLabel: string;
  entries: readonly ProcessorPanelEntry[];
  busy: boolean;
  focusedKey: string | null;
  onFocus: (subscriptionKey: string) => void;
}) {
  return (
    <div>
      <div className="grid grid-cols-[minmax(0,1fr)_52px_44px] gap-1.5 px-3 pb-2 text-[10px] uppercase tracking-wider text-muted-foreground/70">
        <span>{title}</span>
        <span className="text-right">RTT</span>
        <span className="text-right">Lag</span>
      </div>
      <div className="flex flex-col">
        {entries.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">{emptyLabel}</p>
        ) : (
          entries.map((entry) => (
            <ProcessorEntryButton
              key={entry.key}
              entry={entry}
              busy={busy}
              focused={entry.key === focusedKey}
              onFocus={onFocus}
            />
          ))
        )}
      </div>
    </div>
  );
}

function ProcessorEntryButton({
  entry,
  busy,
  focused,
  onFocus,
}: {
  entry: ProcessorPanelEntry;
  busy: boolean;
  focused: boolean;
  onFocus: (subscriptionKey: string) => void;
}) {
  // Real numbers only: the ping RTT when the callback owner answers pings, else
  // the last commit→settled sample (hosted processor). Source-owned receivers
  // never hold a live connection, so their delivery-call duration shows regardless
  // of `connected` — it's the last acked delivery's real round trip. "—"
  // until data exists — never a synthesized value.
  const rttMs =
    (entry.connected
      ? (entry.runtimeConnection?.pingRttMs?.last ??
        entry.runtimeConnection?.completionLatencyMs?.last ??
        null)
      : null) ??
    entry.subscriptionProgress?.deliveryDurationMs?.last ??
    null;
  // Live connection progress first: while its callback stays open, the source
  // sends batches without rewriting the hosted processor's durable checkpoint.
  // That checkpoint is only used when the source must call the processor again,
  // so showing it here would make a healthy open connection look behind.
  const lag =
    entry.rowKind === "core-processor"
      ? "0"
      : (entry.runtimeConnection?.lag ?? entry.subscriptionProgress?.lag ?? null);
  return (
    <button
      type="button"
      onClick={() => onFocus(entry.key)}
      className={cn(
        "grid w-full grid-cols-[minmax(0,1fr)_52px_44px] items-start gap-1.5 rounded-xl px-3 py-2 text-left hover:bg-muted/40",
        focused && "bg-muted/60 ring-1 ring-inset ring-border",
      )}
    >
      <span className="flex min-w-0 items-start gap-2.5">
        <PresenceAvatar entry={entry} busy={busy && isLlmish(entry)} className="mt-0.5" />
        <span className="min-w-0">
          {/*
            break-all rather than truncate: ITX receiver expressions can be
            long, and hiding the target under ellipsis is exactly what this
            panel is for.
          */}
          <span className="block break-all font-mono text-xs leading-snug">
            {eventReceiverLabel(entry)}
          </span>
          <span
            className={cn(
              "block text-xs",
              entry.connected
                ? busy && isLlmish(entry)
                  ? "text-amber-600"
                  : "text-emerald-600"
                : entry.config !== undefined
                  ? "text-muted-foreground"
                  : "text-muted-foreground/60",
            )}
          >
            {processorEntryStatus(entry, busy)}
          </span>
          <ConfiguredFilterSummary config={entry.config} />
        </span>
      </span>
      <span className="pt-0.5 text-right font-mono text-xs text-muted-foreground">
        {rttMs == null ? "—" : `${rttMs}ms`}
      </span>
      <span
        className={cn(
          "pt-0.5 text-right font-mono text-xs",
          lag == null || String(lag) === "0" ? "text-muted-foreground" : "text-amber-600",
        )}
      >
        {lag == null ? "—" : String(lag)}
      </span>
    </button>
  );
}

function buildProcessorPanelEntries(
  presence: readonly AgentUiPresenceEntry[],
  streamRuntime: StreamRuntimeDebugState | undefined,
): ProcessorPanelEntry[] {
  const entries = new Map<string, ProcessorPanelEntry>();
  const configured = readConfiguredSubscriptions(streamRuntime?.coreProcessorState);

  entries.set(CORE_PROCESSOR_KEY, {
    key: CORE_PROCESSOR_KEY,
    rowKind: "core-processor",
    connected: true,
    description: CORE_PROCESSOR_ANNOUNCEMENT.description,
    processor: CORE_PROCESSOR_ANNOUNCEMENT,
  });

  for (const entry of presence) {
    const key = entry.connectionKey;
    const runtimeConnection = streamRuntime?.runtime.connections[key];
    const connectionKind = runtimeConnection?.kind ?? entry.connectionKind;
    const config = configured[key];
    const rowKind =
      config?.subscriptionAction === "processor-wake" || connectionKind === "hosted"
        ? "processor-wake"
        : config === undefined
          ? "live-callback"
          : "durable-subscription";
    entries.set(key, {
      key,
      rowKind,
      // The pushed runtime table is authoritative once it has loaded. Before
      // that first snapshot, keep the reduced presence entry visible instead
      // of making every open session callback disappear from the panel.
      connected: streamRuntime === undefined ? entry.connected : runtimeConnection !== undefined,
      connectionKind,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      ...(entry.processor === undefined ? {} : { processor: entry.processor }),
      ...(entry.user === undefined ? {} : { user: entry.user }),
      ...(runtimeConnection === undefined ? {} : { runtimeConnection }),
      ...(config === undefined
        ? {}
        : {
            subscriptionAction: config.subscriptionAction,
            configuredAtOffset: config.configuredAtOffset,
            config,
          }),
      subscriptionProgress: streamRuntime?.runtime.subscriptions[key],
    });
  }

  // Live callback connections the reduced roster doesn't carry exist only in
  // the runtime table. This browser's reduced presence may have started after
  // the connection-opened event, so the runtime table decides "open now".
  for (const [key, runtimeConnection] of Object.entries(streamRuntime?.runtime.connections ?? {})) {
    const entryKey = runtimeConnection.kind === "hosted" ? runtimeConnection.subscriptionKey : key;
    if (entries.has(entryKey)) continue;
    const config = configured[entryKey];
    const openedBy = readRuntimeRecord(runtimeConnection.openedBy);
    const announcement = readAnnouncement(openedBy?.processor);
    const user = readSubscriberUser(openedBy?.user);
    entries.set(entryKey, {
      key: entryKey,
      rowKind:
        config?.subscriptionAction === "processor-wake" || runtimeConnection.kind === "hosted"
          ? "processor-wake"
          : config === undefined
            ? "live-callback"
            : "durable-subscription",
      connected: true,
      ...(typeof openedBy?.description === "string" ? { description: openedBy.description } : {}),
      ...(user === undefined ? {} : { user }),
      ...(announcement == null ? {} : { processor: announcement }),
      connectionKind: runtimeConnection.kind,
      runtimeConnection,
      ...(config === undefined
        ? {}
        : {
            subscriptionAction: config.subscriptionAction,
            configuredAtOffset: config.configuredAtOffset,
            config,
          }),
      subscriptionProgress: streamRuntime?.runtime.subscriptions[entryKey],
    });
  }

  for (const [key, config] of Object.entries(configured)) {
    const current = entries.get(key);
    const subscriptionProgress = streamRuntime?.runtime.subscriptions[key];
    const runtimeConnection = readHostedConnectionForSubscription(streamRuntime, key);
    const rowKind =
      config.subscriptionAction === "processor-wake" ? "processor-wake" : "durable-subscription";
    if (current != null) {
      entries.set(key, {
        ...current,
        rowKind,
        subscriptionAction: config.subscriptionAction,
        configuredAtOffset: config.configuredAtOffset,
        config,
        // Prefer the receiver label over a generic presence description.
        description: config.deliveryLabel ?? current.description,
        subscriptionProgress,
        connected: runtimeConnection !== undefined,
        ...(config.destinationStream === undefined
          ? {}
          : { receivingStreamPath: config.destinationStream }),
      });
      continue;
    }
    entries.set(key, {
      key,
      rowKind,
      connected: runtimeConnection !== undefined,
      description:
        config.deliveryLabel ??
        (config.subscriptionAction === "processor-wake"
          ? "Durable hosted processor"
          : `Durable ${config.subscriptionAction} subscription`),
      subscriptionAction: config.subscriptionAction,
      configuredAtOffset: config.configuredAtOffset,
      config,
      subscriptionProgress,
      ...(config.destinationStream === undefined
        ? {}
        : { receivingStreamPath: config.destinationStream }),
      ...(runtimeConnection === undefined
        ? {}
        : { runtimeConnection, connectionKind: runtimeConnection.kind }),
    });
  }

  // A session callback is only meaningful while its connection is open.
  // Durable entries remain visible while their hosted processor sleeps or
  // their receiver is waiting, retrying, or halted.
  return [...entries.values()]
    .filter((entry) => entry.rowKind !== "live-callback" || entry.connected)
    .sort(compareProcessorEntries);
}

function processorEntrySections(entries: readonly ProcessorPanelEntry[]): Array<{
  title: string;
  emptyLabel: string;
  entries: ProcessorPanelEntry[];
}> {
  return [
    {
      title: "Core processor",
      emptyLabel: "Core stream state has not loaded yet.",
      entries: entries.filter((entry) => entry.rowKind === "core-processor"),
    },
    {
      title: "Hosted processors",
      emptyLabel: "No hosted processors receive events from this stream.",
      entries: entries.filter((entry) => entry.rowKind === "processor-wake"),
    },
    {
      title: "Durable subscriptions",
      emptyLabel: "No copy, ITX-call, or webhook-post subscriptions are configured.",
      entries: entries.filter((entry) => entry.rowKind === "durable-subscription"),
    },
    {
      title: "Open session callbacks",
      emptyLabel: "No session callbacks are open.",
      entries: entries.filter((entry) => entry.rowKind === "live-callback"),
    },
  ];
}

function compareProcessorEntries(a: ProcessorPanelEntry, b: ProcessorPanelEntry): number {
  const rank = {
    "core-processor": 0,
    "processor-wake": 1,
    "durable-subscription": 2,
    "live-callback": 3,
  } satisfies Record<ProcessorPanelEntry["rowKind"], number>;
  return (
    rank[a.rowKind] - rank[b.rowKind] ||
    eventReceiverLabel(a).localeCompare(eventReceiverLabel(b)) ||
    a.key.localeCompare(b.key)
  );
}

/**
 * A missing live connection is normal: hosted processors are woken when their
 * checkpoint lags; copy, ITX-call, and webhook subscriptions are caught
 * up, sending, waiting to retry, or halted.
 */
function processorEntryStatus(entry: ProcessorPanelEntry, busy: boolean): string {
  if (entry.rowKind === "core-processor") return "running";
  if (entry.connected) {
    if (busy && isLlmish(entry)) return "processing";
    return entry.connectionKind === "hosted" ? "hosted callback open" : "session callback open";
  }
  const subscriptionProgress = entry.subscriptionProgress;
  if (entry.config?.halted != null) {
    return `${entry.config.halted.reason} halted after #${entry.config.halted.afterOffset}`;
  }
  if (entry.config !== undefined) {
    const configured =
      entry.configuredAtOffset == null ? "configured" : `configured #${entry.configuredAtOffset}`;
    if (subscriptionProgress != null && subscriptionProgress.nextAttemptAt !== null) {
      return `${configured} · retry backoff (attempt ${subscriptionProgress.attempt})`;
    }
    if (entry.subscriptionAction === "processor-wake") {
      return `${configured} · called when events are waiting`;
    }
    if (subscriptionProgress != null) {
      return subscriptionProgress.lag === 0
        ? `${configured} · acked to head`
        : `${configured} · sending, lag ${subscriptionProgress.lag}`;
    }
    return configured;
  }
  return "disconnected";
}

function readHostedConnectionForSubscription(
  streamRuntime: StreamRuntimeDebugState | undefined,
  subscriptionKey: string,
): StreamRuntimeDebugState["runtime"]["connections"][string] | undefined {
  return Object.values(streamRuntime?.runtime.connections ?? {}).find(
    (connection) => connection.kind === "hosted" && connection.subscriptionKey === subscriptionKey,
  );
}

function readConfiguredSubscriptions(value: unknown): Record<string, SubscriptionDetails> {
  const record = readRuntimeRecord(value);
  const subscriptions = readRuntimeRecord(record?.subscriptions);
  const outbound = readRuntimeRecord(subscriptions?.outbound);
  const configured = readRuntimeRecord(outbound?.byKey);
  if (configured == null) return {};
  return Object.fromEntries(
    Object.entries(configured).flatMap(([key, entry]) => {
      const details = readSubscriptionDetails(entry);
      return details == null ? [] : [[key, details]];
    }),
  );
}

function readSubscriptionDetails(entry: unknown): SubscriptionDetails | null {
  const configured = readRuntimeRecord(entry);
  const payload = readRuntimeRecord(configured?.configuration);
  const receiver = readRuntimeRecord(payload?.receiver);
  const subscriptionAction = receiver?.action;
  if (
    subscriptionAction !== "processor-wake" &&
    subscriptionAction !== "copy-to-stream" &&
    subscriptionAction !== "itx-call" &&
    subscriptionAction !== "webhook-post"
  ) {
    return null;
  }

  const configuredAtOffset = readNumber(configured, "configuredAtOffset") ?? undefined;
  const haltedRecord = readRuntimeRecord(configured?.deliveryHalted);
  const haltedReason = haltedRecord?.reason;
  const haltedAfterOffset = readNumber(haltedRecord, "afterOffset") ?? undefined;
  const haltedAttempts = readNumber(haltedRecord, "attempts") ?? undefined;
  const halted: SubscriptionDetails["halted"] =
    haltedReason === "delivery-failed" &&
    haltedAfterOffset !== undefined &&
    haltedAttempts !== undefined
      ? {
          reason: haltedReason,
          afterOffset: haltedAfterOffset,
          attempts: haltedAttempts,
          ...(typeof haltedRecord?.error === "string" ? { error: haltedRecord.error } : {}),
        }
      : undefined;
  const delivery = readRuntimeRecord(receiver?.delivery);
  const deliveryLabel =
    subscriptionAction === "webhook-post"
      ? typeof receiver?.url === "string"
        ? `POST ${receiver.url}`
        : undefined
      : subscriptionAction === "copy-to-stream"
        ? typeof receiver?.receivingStreamPath === "string"
          ? `copy to ${receiver.receivingStreamPath}`
          : undefined
        : formatItxExpression(receiver?.expression);
  const destinationStream =
    subscriptionAction === "copy-to-stream" && typeof receiver?.receivingStreamPath === "string"
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
    subscriptionAction === "webhook-post" && typeof receiver?.url === "string"
      ? receiver.url
      : undefined;
  const note =
    typeof payload?.description === "string" && payload.description.trim() !== ""
      ? payload.description.trim()
      : undefined;

  return {
    subscriptionAction,
    ...(configuredAtOffset === undefined ? {} : { configuredAtOffset }),
    ...(halted === undefined ? {} : { halted }),
    ...(deliveryLabel === undefined ? {} : { deliveryLabel }),
    ...(destinationStream === undefined ? {} : { destinationStream }),
    ...(note === undefined ? {} : { note }),
    ...(eventTypes === undefined ? {} : { eventTypes }),
    ...(jsonataCondition === undefined ? {} : { jsonataCondition }),
    ...(jsonataTransform === undefined ? {} : { jsonataTransform }),
    ...(start === undefined ? {} : { start }),
    ...(onFailingEvent === undefined ? {} : { onFailingEvent }),
    ...(webhookUrl === undefined ? {} : { webhookUrl }),
  };
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

/**
 * Labeled multi-line overview under a durable subscription row: destination,
 * event types, condition, transform. Plain "a · b · c" made event types look
 * like path fragments — explicit labels + chips trade a bit of height for
 * scannability.
 */
function ConfiguredFilterSummary({ config }: { config: SubscriptionDetails | undefined }) {
  if (config == null) return null;
  const hasEventFilter =
    config.eventTypes != null && config.eventTypes.length > 0 && !config.eventTypes.includes("*");
  const hasExtra =
    config.note !== undefined ||
    config.destinationStream !== undefined ||
    hasEventFilter ||
    config.jsonataCondition !== undefined;
  if (!hasExtra) return null;

  const eventTypes = hasEventFilter
    ? config.eventTypes!
    : config.destinationStream !== undefined ||
        config.jsonataCondition !== undefined ||
        config.note !== undefined
      ? null // "all event types" shown as text, not chips
      : undefined;

  return (
    <span className="mt-1.5 flex flex-col gap-1 text-[11px] leading-snug text-muted-foreground">
      {config.note == null ? null : (
        <span className="text-[11px] leading-snug text-foreground/75">{config.note}</span>
      )}
      {config.destinationStream == null ? null : (
        <ConfiguredFilterLine label="to">
          <span className="break-all font-mono text-foreground/80">{config.destinationStream}</span>
        </ConfiguredFilterLine>
      )}
      {eventTypes === undefined ? null : eventTypes == null ? (
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
      {config.jsonataCondition == null ? null : (
        <ConfiguredFilterLine label="when">
          <span className="break-all font-mono text-foreground/80">
            {config.jsonataCondition.length > 80
              ? `${config.jsonataCondition.slice(0, 77)}…`
              : config.jsonataCondition}
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
  if (announcement == null) return null;
  const slug = typeof announcement.slug === "string" ? announcement.slug : null;
  const version = typeof announcement.version === "string" ? announcement.version : null;
  const description =
    typeof announcement.description === "string" ? announcement.description : null;
  if (slug == null || version == null || description == null) return null;
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
                ...(typeof event.description === "string"
                  ? { description: event.description }
                  : {}),
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
    ...(typeof user.id === "string" ? { id: user.id } : {}),
    email: user.email,
    ...(typeof user.name === "string" ? { name: user.name } : {}),
    ...(typeof user.picture === "string" ? { picture: user.picture } : {}),
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

/** Compact "how long has this window been collecting" caption. */
function sinceLabel(measuredSinceIso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(measuredSinceIso)) / 1000));
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
    <div {...(title === undefined ? {} : { title })}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70">{label}</div>
      <div className={cn("mt-0.5 font-mono text-sm", valueClassName)}>{value}</div>
    </div>
  );
}

function ProcessorDetail({
  entry,
  busy,
  runtimeStateLoad,
  streamMaxOffset,
  onRefreshRuntimeState,
  onBack,
  onClose,
}: {
  entry: ProcessorPanelEntry;
  busy: boolean;
  runtimeStateLoad: ProcessorRuntimeStateLoad;
  streamMaxOffset: number | null;
  onRefreshRuntimeState: () => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const processor = entry.processor;
  return (
    <>
      <div className="flex shrink-0 items-center gap-2.5 px-4 pb-2 pt-3.5">
        <Button variant="ghost" size="icon-sm" title="Stream state overview" onClick={onBack}>
          <ChevronLeftIcon />
        </Button>
        <PresenceAvatar
          entry={entry}
          busy={busy && isLlmish(entry)}
          className="size-7 text-[10px]"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="break-all font-mono text-sm font-semibold leading-snug">
              {eventReceiverLabel(entry)}
            </span>
            {processor == null ? null : (
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
                v{processor.version}
              </span>
            )}
          </div>
          <div
            className={cn(
              "text-xs",
              entry.connected ? "text-emerald-600" : "text-muted-foreground/60",
            )}
          >
            {processorEntryStatus(entry, busy)} ·{" "}
            {entry.subscriptionAction ?? entry.connectionKind ?? "event callback"}
          </div>
        </div>
        <PanelCloseButton onClose={onClose} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5 pt-2">
        {entry.user == null ? null : <SubscriberUserDetail user={entry.user} />}
        {processor == null ? (
          shouldShowConfiguredDetail(entry.config) ? null : (
            <p className="text-sm leading-relaxed text-muted-foreground">
              {entry.description ?? "This callback owner did not announce a processor contract."}
            </p>
          )
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
                      {owned.description == null ? null : (
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
        {shouldShowConfiguredDetail(entry.config) ? (
          <SubscriptionDetail config={entry.config!} />
        ) : null}
        {entry.rowKind === "core-processor" ? null : <EventDeliverySummary entry={entry} />}
        <ProcessorRuntimeStateView
          runtimeStateLoad={runtimeStateLoad}
          streamMaxOffset={streamMaxOffset}
          onRefresh={onRefreshRuntimeState}
          processorSlug={processor?.slug}
        />
        <div>
          <SectionHeading>
            {entry.config === undefined ? "Connection key" : "Subscription key"}
          </SectionHeading>
          <div className="rounded-xl bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground break-all">
            {entry.key}
          </div>
        </div>
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

function shouldShowConfiguredDetail(
  config: SubscriptionDetails | undefined,
): config is SubscriptionDetails {
  return config != null;
}

/** Human-readable configuration for one stored subscription. */
function SubscriptionDetail({ config }: { config: SubscriptionDetails }) {
  const heading =
    config.subscriptionAction === "copy-to-stream"
      ? "Copy destination"
      : config.subscriptionAction === "webhook-post"
        ? "Webhook POST"
        : config.subscriptionAction === "itx-call"
          ? "ITX-expression receiver"
          : "Hosted processor";
  const eventTypes =
    config.eventTypes == null || config.eventTypes.includes("*") ? null : config.eventTypes;
  const startLabel =
    config.start === undefined
      ? null
      : config.start === "beginning"
        ? "beginning (all history)"
        : "now (from configure time)";
  const genericBlurb =
    config.subscriptionAction === "copy-to-stream"
      ? "Matching events are appended to the destination stream in order with source provenance."
      : config.subscriptionAction === "webhook-post"
        ? "Each matching event is POSTed as JSON to the configured URL."
        : config.subscriptionAction === "itx-call"
          ? "Matching events are delivered in awaited batches to the configured ITX expression."
          : "The hosted processor stores its checkpoint. When events are waiting, the source calls it and sends batches through the returned callback.";

  return (
    <div className="flex flex-col gap-3">
      <div>
        <SectionHeading>{heading}</SectionHeading>
        <p className="text-sm leading-relaxed text-foreground/70">{config.note ?? genericBlurb}</p>
        {config.note == null ? null : (
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{genericBlurb}</p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {config.deliveryLabel == null ? null : (
          <DetailField label="delivers to" mono>
            {config.deliveryLabel}
          </DetailField>
        )}
        {config.destinationStream == null ? null : (
          <DetailField label="destination stream" mono>
            {config.destinationStream}
          </DetailField>
        )}
        {config.webhookUrl == null || config.deliveryLabel != null ? null : (
          <DetailField label="url" mono>
            {config.webhookUrl}
          </DetailField>
        )}
        {startLabel == null ? null : <DetailField label="starts from">{startLabel}</DetailField>}
        {config.onFailingEvent == null ? null : (
          <DetailField label="on failing event">{config.onFailingEvent}</DetailField>
        )}
      </div>

      <div>
        <SectionHeading>Receives these events</SectionHeading>
        {eventTypes == null ? (
          <span className="text-xs text-muted-foreground">
            All event types
            {config.jsonataCondition == null ? "" : " matching the condition below"}
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

      {config.jsonataCondition == null ? null : (
        <div>
          <SectionHeading>Condition</SectionHeading>
          <div className="rounded-xl bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed text-foreground/80 break-all whitespace-pre-wrap">
            {config.jsonataCondition}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            JSONata over the whole event — must evaluate to exactly true.
          </p>
        </div>
      )}

      {config.jsonataTransform == null ? null : (
        <div>
          <SectionHeading>Transform</SectionHeading>
          <div className="rounded-xl bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed text-foreground/80 break-all whitespace-pre-wrap">
            {config.jsonataTransform}
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
    snapshot == null || streamMaxOffset == null
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
          {snapshot == null ? null : (
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
      ) : runtimeState == null ? (
        <RuntimeStateMessage>
          Runtime state is not available for this connection.
        </RuntimeStateMessage>
      ) : snapshot == null ? (
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
          {runtimeState.runtime == null ? null : (
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

function EventDeliverySummary({ entry }: { entry: ProcessorPanelEntry }) {
  if (
    entry.connectionKind == null &&
    entry.subscriptionAction == null &&
    entry.subscriptionProgress == null &&
    entry.configuredAtOffset == null
  ) {
    return null;
  }
  const runtime = entry.subscriptionProgress;
  const connection = entry.runtimeConnection;
  const hasLatency =
    connection != null ||
    runtime?.completionLatencyMs != null ||
    runtime?.deliveryDurationMs != null ||
    runtime?.bytesSent != null;
  return (
    <div>
      <SectionHeading>Delivery</SectionHeading>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <RuntimeStateStat label="row" value={entry.rowKind} />
        <RuntimeStateStat
          label="action"
          value={entry.subscriptionAction ?? entry.connectionKind ?? "callback"}
        />
        <RuntimeStateStat
          label="acked"
          value={
            connection != null
              ? `#${connection.deliveredThroughOffset}`
              : runtime != null
                ? `#${runtime.acknowledgedOffset}`
                : "—"
          }
        />
        <RuntimeStateStat
          label="lag"
          // Live connection progress first: the stored checkpoint goes
          // stale by design while a connection streams (see the row list).
          value={
            connection != null
              ? String(connection.lag)
              : runtime != null
                ? String(runtime.lag)
                : "—"
          }
        />
      </div>
      {hasLatency ? (
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <RuntimeStateStat
            label="ping rtt"
            value={
              connection?.pingRttMs == null
                ? "—"
                : `${connection.pingRttMs.last}ms · p95 ${connection.pingRttMs.p95}ms`
            }
          />
          <RuntimeStateStat
            label="settle"
            value={(() => {
              const stats = connection?.completionLatencyMs ?? runtime?.completionLatencyMs;
              return stats == null ? "—" : `${stats.last}ms · p95 ${stats.p95}ms`;
            })()}
          />
          <RuntimeStateStat
            label="call rtt"
            value={(() => {
              const stats = runtime?.deliveryDurationMs;
              return stats == null ? "—" : `${stats.last}ms · p95 ${stats.p95}ms`;
            })()}
          />
          <RuntimeStateStat
            label="delivered"
            // Live connections report events; copy, ITX-call, and webhook
            // subscriptions report bytes this incarnation (the durable sending row
            // does not count events).
            value={
              connection != null
                ? `${connection.eventsSent} ev · ${formatFileSize(connection.bytesSent)}`
                : runtime?.bytesSent != null
                  ? formatFileSize(runtime.bytesSent)
                  : "—"
            }
          />
        </div>
      ) : null}
      {entry.configuredAtOffset == null &&
      runtime?.lastError == null &&
      entry.config?.halted == null &&
      runtime?.nextAttemptAt == null ? null : (
        <div className="mt-2 rounded-xl bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {entry.configuredAtOffset == null ? null : (
            <div>configured at #{entry.configuredAtOffset}</div>
          )}
          {entry.config?.halted == null ? null : (
            <div>
              {entry.config.halted.reason} halted after #{entry.config.halted.afterOffset} after{" "}
              {entry.config.halted.attempts} attempts
            </div>
          )}
          {runtime?.nextAttemptAt == null ? null : (
            <div>next attempt {new Date(runtime.nextAttemptAt).toLocaleString()}</div>
          )}
          {runtime?.lastError == null ? null : (
            <div className="mt-1 text-destructive">{runtime.lastError}</div>
          )}
          {connection == null &&
          runtime?.bytesSent == null &&
          entry.subscriptionAction !== "processor-wake" ? (
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

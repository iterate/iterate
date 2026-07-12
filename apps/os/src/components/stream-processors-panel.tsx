import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronLeftIcon, DatabaseZapIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { Sheet, SheetContent, SheetTitle } from "@iterate-com/ui/components/sheet";
import type {
  AgentUiPresenceEntry,
  AgentUiProcessorAnnouncement,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
import { cn } from "@iterate-com/ui/lib/utils";
import type { ProcessorRuntimeState } from "../domains/streams/rpc-types.ts";
import type { Stream } from "../itx-api.generated.ts";
import { formatBytesPerSecond, formatFileSize } from "~/lib/feed-format.ts";
import {
  AgentPrettyState,
  CorePrettyState,
  RuntimeStateStat,
  SectionHeading,
} from "~/components/stream-processor-pretty-state.tsx";
import { readNumber, readRuntimeRecord } from "~/lib/runtime-record.ts";
import {
  presenceColorClasses,
  presenceInitials,
  presenceLabel,
  sparklinePoints,
  type BrowserStreamMetricsView,
} from "~/lib/stream-presence.ts";

export function PresenceAvatar({
  entry,
  busy,
  className,
}: {
  entry: AgentUiPresenceEntry;
  busy: boolean;
  className?: string;
}) {
  const label = presenceLabel(entry);
  return (
    <span
      className={cn(
        "relative grid size-6 shrink-0 place-items-center rounded-full font-mono text-[9px] font-bold",
        presenceColorClasses(label),
        className,
      )}
    >
      {presenceInitials(label)}
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
    </span>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

/**
 * One abstraction for presence, metrics, and processor detail — everything is
 * a facet of "the stream's consumers". Overview lists every consumer with
 * REAL RTT/lag from the stream's runtime table (polled while open — the poll
 * is also what drives the stream's observer-gated ping sampling); clicking
 * one drills into its announced contract and self-reported metrics.
 */
export type StreamRuntimeDebugState = Awaited<ReturnType<Stream["runtimeState"]>>;

type ProcessorPanelEntry = {
  subscriptionKey: string;
  kind: "core" | "processor" | "subscriber" | "consumer";
  connected: boolean;
  direction: "inbound" | "outbound";
  description?: string;
  processor?: AgentUiProcessorAnnouncement;
  subscriptionType?: "configured" | "ephemeral";
  deliveryMode?: "wake" | "push" | "webhook";
  configuredAtOffset?: number;
  runtimeSubscription?: StreamRuntimeDebugState["runtime"]["subscriptions"][string];
  runtimeConnection?: StreamRuntimeDebugState["runtime"]["connections"][string];
};

/**
 * Overview poll cadence while the sheet is open. Also the observer signal for
 * the stream's throttled ping sampling (see runtimeState in rpc-targets.ts).
 */
const STREAM_RUNTIME_POLL_MS = 1_000;

const CORE_PROCESSOR_KEY = "__stream-core__";
const CORE_PROCESSOR_ANNOUNCEMENT: AgentUiProcessorAnnouncement = {
  slug: "core",
  version: "0.1.0",
  description:
    "Maintains the stream's own reduced state: head offset, child streams, durable subscriptions, presence, pause state, and append circuit breaker.",
  consumes: ["*"],
  emits: [
    "events.iterate.com/stream/subscriber-connected",
    "events.iterate.com/stream/subscriber-disconnected",
    "events.iterate.com/stream/subscription-configured",
    "events.iterate.com/stream/subscription-parked",
    "events.iterate.com/stream/subscription-resumed",
  ],
  ownedEvents: [
    { type: "events.iterate.com/stream/created" },
    { type: "events.iterate.com/stream/woken" },
    { type: "events.iterate.com/stream/configured" },
    { type: "events.iterate.com/stream/subscription-configured" },
    { type: "events.iterate.com/stream/subscriber-connected" },
    { type: "events.iterate.com/stream/subscriber-disconnected" },
    { type: "events.iterate.com/stream/paused" },
    { type: "events.iterate.com/stream/resumed" },
  ],
};

type ProcessorRuntimeStateResult = {
  runtimeState: ProcessorRuntimeState | null;
  streamMaxOffset: number;
};

export function StreamProcessorsPanel({
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
  getStreamRuntimeState,
  streamPath,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  presence: readonly AgentUiPresenceEntry[];
  metrics: BrowserStreamMetricsView;
  eventCount: number;
  busy: boolean;
  /** Keys the runtime poll's query cache per stream. */
  streamPath: string;
  /** Subscription key of the focused processor (URL-backed); null = overview. */
  focusedKey: string | null;
  onFocus: (subscriptionKey: string) => void;
  onBack: () => void;
  onClose: () => void;
  onClearClientDatabase: () => Promise<void>;
  getProcessorRuntimeState: (subscriptionKey: string) => Promise<ProcessorRuntimeStateResult>;
  getStreamRuntimeState: () => Promise<StreamRuntimeDebugState>;
}) {
  // Poll while open: every fetch refreshes the live metrics AND asks the
  // stream for a ping round (its RTT sampling is observer-gated on exactly
  // this call). keepPreviousData swaps polls in place instead of flashing a
  // loading state.
  const streamRuntimeQuery = useQuery({
    queryKey: ["stream-processors-panel-runtime", streamPath],
    queryFn: getStreamRuntimeState,
    enabled: open,
    refetchInterval: STREAM_RUNTIME_POLL_MS,
    placeholderData: keepPreviousData,
  });

  const streamRuntime = streamRuntimeQuery.data;
  const streamRuntimeError =
    streamRuntimeQuery.error == null
      ? undefined
      : streamRuntimeQuery.error instanceof Error
        ? streamRuntimeQuery.error.message
        : String(streamRuntimeQuery.error);
  const entries = useMemo(
    () => buildProcessorPanelEntries(presence, streamRuntime),
    [presence, streamRuntime],
  );
  // A stale or never-connected key (e.g. after a reconnect) falls back to the
  // overview rather than a blank detail pane.
  const focused = entries.find((entry) => entry.subscriptionKey === focusedKey) ?? null;
  const focusedSubscriptionKey = focused?.subscriptionKey ?? null;
  const focusedConnected = focused?.connected ?? false;
  const [runtimeStateLoad, setRuntimeStateLoad] = useState<ProcessorRuntimeStateLoad>({
    status: "idle",
  });
  const [refreshKey, setRefreshKey] = useState(0);
  const focusedRuntimeStateLoad =
    focusedSubscriptionKey == null ||
    runtimeStateLoad.status === "idle" ||
    runtimeStateLoad.subscriptionKey === focusedSubscriptionKey
      ? runtimeStateLoad
      : ({
          status: "loading",
          subscriptionKey: focusedSubscriptionKey,
        } satisfies ProcessorRuntimeStateLoad);

  useEffect(() => {
    if (focusedSubscriptionKey == null) {
      setRuntimeStateLoad({ status: "idle" });
      return;
    }

    if (focused?.kind === "core") {
      // Error first: with keepPreviousData a failed poll leaves stale data in
      // place alongside the error, and a metrics drill-in silently rendering
      // stale state during an outage would be exactly the fake UI this
      // feature exists to kill.
      if (streamRuntimeError !== undefined) {
        setRuntimeStateLoad({
          status: "error",
          subscriptionKey: focusedSubscriptionKey,
          message: streamRuntimeError,
        });
      } else if (streamRuntime !== undefined) {
        const coreState = streamRuntime.coreProcessorState;
        setRuntimeStateLoad({
          status: "loaded",
          subscriptionKey: focusedSubscriptionKey,
          runtimeState: {
            snapshot: { offset: readNumber(coreState, "maxOffset") ?? 0, state: coreState },
            runtime: streamRuntime.runtime,
          },
          streamMaxOffset: readNumber(coreState, "maxOffset") ?? 0,
        });
      } else {
        setRuntimeStateLoad({ status: "loading", subscriptionKey: focusedSubscriptionKey });
      }
      return;
    }

    if (!focusedConnected) {
      setRuntimeStateLoad({
        status: "loaded",
        subscriptionKey: focusedSubscriptionKey,
        runtimeState: null,
        streamMaxOffset: null,
      });
      return;
    }

    let disposed = false;
    setRuntimeStateLoad({ status: "loading", subscriptionKey: focusedSubscriptionKey });
    void getProcessorRuntimeState(focusedSubscriptionKey)
      .then(({ runtimeState, streamMaxOffset }) => {
        if (!disposed) {
          setRuntimeStateLoad({
            status: "loaded",
            subscriptionKey: focusedSubscriptionKey,
            runtimeState,
            streamMaxOffset,
          });
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setRuntimeStateLoad({
            status: "error",
            subscriptionKey: focusedSubscriptionKey,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });

    return () => {
      disposed = true;
    };
  }, [
    focused,
    focusedConnected,
    focusedSubscriptionKey,
    getProcessorRuntimeState,
    refreshKey,
    streamRuntime,
    streamRuntimeError,
  ]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="flex h-full w-full flex-col gap-0 p-0 data-[side=right]:sm:w-[56vw] data-[side=right]:sm:max-w-[92vw]"
      >
        <SheetTitle className="sr-only">
          {focused == null ? "Processors" : `Processor ${presenceLabel(focused)}`}
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
            onRefreshStreamRuntime={() => void streamRuntimeQuery.refetch()}
            streamRuntimeFetching={streamRuntimeQuery.isFetching}
            streamRuntimeError={streamRuntimeError}
            throughput={streamRuntime?.runtime.metrics}
          />
        ) : (
          <ProcessorDetail
            entry={focused}
            busy={busy}
            runtimeStateLoad={focusedRuntimeStateLoad}
            onRefreshRuntimeState={() => {
              setRefreshKey((key) => key + 1);
              if (focused.kind === "core") void streamRuntimeQuery.refetch();
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
      streamMaxOffset: number | null;
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
  throughput,
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
  throughput: StreamRuntimeDebugState["runtime"]["metrics"] | undefined;
}) {
  const [clearState, setClearState] = useState<"idle" | "clearing" | "error">("idle");
  const points = sparklinePoints(metrics.spark, 368, 44);
  const area = `2,42 ${points} 366,42`;
  const sections = processorEntrySections(entries);
  const rtt = metrics.transportRttMs;
  const subscriber = metrics.subscriber;

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 px-5 pb-2 pt-4">
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold">Processors</div>
          <div className="text-xs text-muted-foreground">
            presence · metrics · state, per consumer
          </div>
        </div>
        <PanelCloseButton onClose={onClose} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5 pt-2">
        <div className="rounded-2xl bg-muted/40 px-4 py-3.5">
          <div className="flex items-baseline justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Connection RTT
            </span>
            <span className="font-mono text-[10px] text-muted-foreground/70">
              this browser · sampled each poll
            </span>
          </div>
          <div className="mt-2 flex items-end gap-3">
            <span className="font-mono text-2xl font-semibold leading-none">
              {rtt === null ? "—" : rtt.last}
              <span className="text-xs text-muted-foreground">ms</span>
            </span>
            {metrics.spark.length === 0 ? (
              <span className="flex-1 pb-1 text-xs text-muted-foreground/70">measuring…</span>
            ) : (
              <svg viewBox="0 0 368 44" className="h-11 min-w-0 flex-1" preserveAspectRatio="none">
                <polygon points={area} className="fill-emerald-500/10" />
                <polyline
                  points={points}
                  fill="none"
                  className="stroke-emerald-600"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </div>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
            <MetricStat
              label="p50 · 32 samples"
              title="Median of the last 32 RTT samples"
              value={rtt === null ? "—" : `${rtt.p50}ms`}
            />
            <MetricStat
              label="p95 · 32 samples"
              title="95th percentile (nearest-rank) of the last 32 RTT samples"
              value={rtt === null ? "—" : `${rtt.p95}ms`}
            />
            <MetricStat
              label="append · last"
              title="Most recent append call → commit acknowledged (this browser's own appends)"
              value={
                subscriber?.appendRoundTripMs == null
                  ? "—"
                  : `${subscriber.appendRoundTripMs.last}ms`
              }
            />
            <MetricStat
              label="own loop · last"
              title="Most recent append call → this browser's own subscription ingested the committed event"
              value={
                subscriber?.consumeOwnAppendMs == null
                  ? "—"
                  : `${subscriber.consumeOwnAppendMs.last}ms`
              }
            />
          </div>

          <div className="mt-4 flex items-baseline justify-between border-t border-border/60 pt-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Throughput
            </span>
            <span className="font-mono text-[10px] text-muted-foreground/70">
              this stream · 1s buckets · last 60s
            </span>
          </div>
          {throughput === undefined ? (
            <div className="mt-2 h-11 text-xs text-muted-foreground/70">measuring…</div>
          ) : (
            <div className="mt-2 flex items-end gap-3">
              <span
                className="font-mono text-2xl font-semibold leading-none"
                title="Appends committed per second, trailing 5s"
              >
                {formatRate(throughput.ingress.perSecond5s)}
                <span className="text-xs text-muted-foreground">ev/s</span>
              </span>
              <ThroughputGraph
                ingress={throughput.ingress.series.counts}
                egress={throughput.egress.series.counts}
              />
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
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
              title="Bytes delivered to all subscribers per second, trailing 5s"
              value={
                throughput === undefined
                  ? "—"
                  : formatBytesPerSecond(throughput.egress.bytesPerSecond5s)
              }
            />
            <MetricStat
              label="events · 60s"
              title="Appends committed in the last minute (delivered in the last minute in parens)"
              value={
                throughput === undefined
                  ? "—"
                  : `${throughput.ingress.lastMinute.count} (${throughput.egress.lastMinute.count} out)`
              }
            />
            <MetricStat label="head" title="Stream head offset" value={`#${eventCount}`} />
            <MetricStat
              label="measuring"
              title={
                throughput === undefined
                  ? "Metrics are in-memory and reset when the stream Durable Object restarts"
                  : `Since ${throughput.measuredSince} (in-memory; resets on stream restart)`
              }
              value={throughput === undefined ? "—" : sinceLabel(throughput.measuredSince)}
            />
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
              key={entry.subscriptionKey}
              entry={entry}
              busy={busy}
              focused={entry.subscriptionKey === focusedKey}
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
  // Real numbers only: the ping RTT when the subscriber answers pings, else
  // the last commit→settled sample (wake). Push/webhook subscribers never
  // hold a live connection, so their delivery-call duration shows regardless
  // of `connected` — it's the last acked delivery's real round trip. "—"
  // until data exists — never a synthesized value.
  const rttMs =
    (entry.connected
      ? (entry.runtimeConnection?.pingRttMs?.last ??
        entry.runtimeConnection?.settleLatencyMs?.last ??
        null)
      : null) ??
    entry.runtimeSubscription?.deliveryDurationMs?.last ??
    null;
  // Live connection cursor first: the wake lane's spine row is an
  // OBSERVATIONAL watermark that deliberately goes stale while a connection
  // streams (see stream-subscribers.ts #poke), so a healthy connected
  // processor would otherwise show a scary fake backlog. The subscription
  // row's lag is the real number for the lanes without a live connection.
  const lag =
    entry.kind === "core"
      ? "0"
      : (entry.runtimeConnection?.lag ?? entry.runtimeSubscription?.lag ?? null);
  return (
    <button
      type="button"
      onClick={() => onFocus(entry.subscriptionKey)}
      className={cn(
        "grid w-full grid-cols-[minmax(0,1fr)_52px_44px] items-center gap-1.5 rounded-xl px-3 py-2 text-left hover:bg-muted/40",
        focused && "bg-muted/60 ring-1 ring-inset ring-border",
      )}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <PresenceAvatar entry={entry} busy={busy && isLlmish(entry)} />
        <span className="min-w-0">
          <span className="block truncate font-mono text-xs">{presenceLabel(entry)}</span>
          <span
            className={cn(
              "block text-xs",
              entry.connected
                ? busy && isLlmish(entry)
                  ? "text-amber-600"
                  : "text-emerald-600"
                : entry.subscriptionType === "configured"
                  ? "text-muted-foreground"
                  : "text-muted-foreground/60",
            )}
          >
            {processorEntryStatus(entry, busy)}
          </span>
        </span>
      </span>
      <span className="text-right font-mono text-xs text-muted-foreground">
        {rttMs == null ? "—" : `${rttMs}ms`}
      </span>
      <span
        className={cn(
          "text-right font-mono text-xs",
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
  const coreConnections = readCoreConnections(streamRuntime?.coreProcessorState);
  const configured = readConfiguredSubscribers(streamRuntime?.coreProcessorState);

  entries.set(CORE_PROCESSOR_KEY, {
    subscriptionKey: CORE_PROCESSOR_KEY,
    kind: "core",
    connected: true,
    direction: "outbound",
    description: CORE_PROCESSOR_ANNOUNCEMENT.description,
    processor: CORE_PROCESSOR_ANNOUNCEMENT,
  });

  for (const entry of presence) {
    const coreConnection = coreConnections[entry.subscriptionKey];
    const subscriptionType = readSubscriptionType(coreConnection) ?? "ephemeral";
    const runtimeConnection = streamRuntime?.runtime.connections[entry.subscriptionKey];
    entries.set(entry.subscriptionKey, {
      ...entry,
      kind: subscriptionType === "configured" ? "processor" : "consumer",
      subscriptionType,
      ...(runtimeConnection === undefined ? {} : { runtimeConnection }),
      ...(configured[entry.subscriptionKey]?.deliveryMode === undefined
        ? {}
        : { deliveryMode: configured[entry.subscriptionKey].deliveryMode }),
      ...(configured[entry.subscriptionKey]?.configuredAtOffset === undefined
        ? {}
        : { configuredAtOffset: configured[entry.subscriptionKey].configuredAtOffset }),
      runtimeSubscription: streamRuntime?.runtime.subscriptions[entry.subscriptionKey],
    });
  }

  for (const [subscriptionKey, connection] of Object.entries(coreConnections)) {
    if (entries.has(subscriptionKey)) continue;
    const subscriber = readRuntimeRecord(connection.subscriber);
    const announcement = readAnnouncement(subscriber?.processor);
    const subscriptionType = readSubscriptionType(connection) ?? "ephemeral";
    entries.set(subscriptionKey, {
      subscriptionKey,
      kind: subscriptionType === "configured" ? "processor" : "consumer",
      connected: true,
      direction: "outbound",
      ...(typeof subscriber?.description === "string"
        ? { description: subscriber.description }
        : {}),
      ...(announcement == null ? {} : { processor: announcement }),
      subscriptionType,
      ...(streamRuntime?.runtime.connections[subscriptionKey] === undefined
        ? {}
        : { runtimeConnection: streamRuntime.runtime.connections[subscriptionKey] }),
      ...(configured[subscriptionKey]?.deliveryMode === undefined
        ? {}
        : { deliveryMode: configured[subscriptionKey].deliveryMode }),
      ...(configured[subscriptionKey]?.configuredAtOffset === undefined
        ? {}
        : { configuredAtOffset: configured[subscriptionKey].configuredAtOffset }),
      runtimeSubscription: streamRuntime?.runtime.subscriptions[subscriptionKey],
    });
  }

  // Live connections the reduced roster doesn't carry: ephemeral consumers
  // exist ONLY in the runtime connection table (core state v14), and this
  // client's presence roster may not know consumers that connected before its
  // mirror subscribed. The runtime table is the authority on "connected now".
  for (const [subscriptionKey, runtimeConnection] of Object.entries(
    streamRuntime?.runtime.connections ?? {},
  )) {
    if (entries.has(subscriptionKey)) continue;
    const subscriptionType = runtimeConnection.subscriptionType;
    const subscriber = readRuntimeRecord(runtimeConnection.subscriber);
    const announcement = readAnnouncement(subscriber?.processor);
    entries.set(subscriptionKey, {
      subscriptionKey,
      kind: subscriptionType === "configured" ? "processor" : "consumer",
      connected: true,
      direction: "outbound",
      ...(typeof subscriber?.description === "string"
        ? { description: subscriber.description }
        : {}),
      ...(announcement == null ? {} : { processor: announcement }),
      subscriptionType,
      runtimeConnection,
      runtimeSubscription: streamRuntime?.runtime.subscriptions[subscriptionKey],
    });
  }

  for (const [subscriptionKey, config] of Object.entries(configured)) {
    const current = entries.get(subscriptionKey);
    const runtimeSubscription = streamRuntime?.runtime.subscriptions[subscriptionKey];
    const kind = config.deliveryMode === "wake" ? "processor" : "subscriber";
    if (current != null) {
      entries.set(subscriptionKey, {
        ...current,
        kind,
        subscriptionType: "configured",
        deliveryMode: config.deliveryMode,
        configuredAtOffset: config.configuredAtOffset,
        runtimeSubscription,
        connected: runtimeSubscription?.connected ?? current.connected,
      });
      continue;
    }
    entries.set(subscriptionKey, {
      subscriptionKey,
      kind,
      connected: runtimeSubscription?.connected ?? false,
      direction: "outbound",
      description:
        config.deliveryMode === "wake"
          ? "Durable wake processor"
          : `Durable ${config.deliveryMode} subscriber`,
      subscriptionType: "configured",
      deliveryMode: config.deliveryMode,
      configuredAtOffset: config.configuredAtOffset,
      runtimeSubscription,
      ...(streamRuntime?.runtime.connections[subscriptionKey] === undefined
        ? {}
        : { runtimeConnection: streamRuntime.runtime.connections[subscriptionKey] }),
    });
  }

  // Dead ephemeral consumers are noise: an ephemeral connection IS its live
  // socket, so a disconnected one is just a tab that left. Durable entries
  // keep showing while disconnected (asleep/parked is real state).
  return [...entries.values()]
    .filter((entry) => entry.kind !== "consumer" || entry.connected)
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
      entries: entries.filter((entry) => entry.kind === "core"),
    },
    {
      title: "Durable processors",
      emptyLabel: "No durable processors are configured on this stream.",
      entries: entries.filter((entry) => entry.kind === "processor"),
    },
    {
      title: "Durable subscribers",
      emptyLabel: "No durable push or webhook subscribers are configured.",
      entries: entries.filter((entry) => entry.kind === "subscriber"),
    },
    {
      title: "Ephemeral consumers",
      emptyLabel: "No ephemeral consumers are connected.",
      entries: entries.filter((entry) => entry.kind === "consumer"),
    },
  ];
}

function compareProcessorEntries(a: ProcessorPanelEntry, b: ProcessorPanelEntry): number {
  const rank = { core: 0, processor: 1, subscriber: 2, consumer: 3 } satisfies Record<
    ProcessorPanelEntry["kind"],
    number
  >;
  return (
    rank[a.kind] - rank[b.kind] ||
    presenceLabel(a).localeCompare(presenceLabel(b)) ||
    a.subscriptionKey.localeCompare(b.subscriptionKey)
  );
}

function processorEntryStatus(entry: ProcessorPanelEntry, busy: boolean): string {
  if (entry.kind === "core") return "running";
  if (entry.connected) {
    if (busy && isLlmish(entry)) return "processing";
    return entry.subscriptionType === "configured" ? "connected durable" : "connected ephemeral";
  }
  if (entry.runtimeSubscription?.parkedAtOffset != null) {
    return `parked at #${entry.runtimeSubscription.parkedAtOffset}`;
  }
  if (entry.subscriptionType === "configured") return "configured asleep";
  return "disconnected";
}

function readCoreConnections(value: unknown): Record<string, Record<string, unknown>> {
  const record = readRuntimeRecord(value);
  const connections = readRuntimeRecord(record?.connectionsByKey);
  if (connections == null) return {};
  return Object.fromEntries(
    Object.entries(connections).flatMap(([key, connection]) => {
      const value = readRuntimeRecord(connection);
      return value == null ? [] : [[key, value]];
    }),
  );
}

function readConfiguredSubscribers(
  value: unknown,
): Record<string, { deliveryMode: "wake" | "push" | "webhook"; configuredAtOffset?: number }> {
  const record = readRuntimeRecord(value);
  const configured = readRuntimeRecord(record?.configuredSubscribersByKey);
  if (configured == null) return {};
  return Object.fromEntries(
    Object.entries(configured).flatMap(([key, entry]) => {
      const latest = readRuntimeRecord(readRuntimeRecord(entry)?.latestConfiguredEvent);
      const payload = readRuntimeRecord(latest?.payload);
      const delivery = readRuntimeRecord(payload?.delivery);
      const mode = delivery?.mode;
      if (mode !== "wake" && mode !== "push" && mode !== "webhook") return [];
      const configuredAtOffset = readNumber(latest, "offset") ?? undefined;
      return [[key, { deliveryMode: mode, configuredAtOffset }]];
    }),
  );
}

function readSubscriptionType(
  value: Record<string, unknown> | undefined,
): "configured" | "ephemeral" | undefined {
  const subscriptionType = value?.subscriptionType;
  return subscriptionType === "configured" || subscriptionType === "ephemeral"
    ? subscriptionType
    : undefined;
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

function MetricStat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div {...(title === undefined ? {} : { title })}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70">{label}</div>
      <div className="mt-0.5 font-mono text-sm">{value}</div>
    </div>
  );
}

function ProcessorDetail({
  entry,
  busy,
  runtimeStateLoad,
  onRefreshRuntimeState,
  onBack,
  onClose,
}: {
  entry: ProcessorPanelEntry;
  busy: boolean;
  runtimeStateLoad: ProcessorRuntimeStateLoad;
  onRefreshRuntimeState: () => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const processor = entry.processor;
  return (
    <>
      <div className="flex shrink-0 items-center gap-2.5 px-4 pb-2 pt-3.5">
        <Button variant="ghost" size="icon-sm" title="All processors" onClick={onBack}>
          <ChevronLeftIcon />
        </Button>
        <PresenceAvatar
          entry={entry}
          busy={busy && isLlmish(entry)}
          className="size-7 text-[10px]"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="truncate font-mono text-sm font-semibold">{presenceLabel(entry)}</span>
            {processor == null ? null : (
              <span className="font-mono text-[10px] text-muted-foreground/70">
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
            {processorEntryStatus(entry, busy)} · {entry.deliveryMode ?? entry.direction}
          </div>
        </div>
        <PanelCloseButton onClose={onClose} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5 pt-2">
        {processor == null ? (
          <p className="text-sm leading-relaxed text-muted-foreground">
            {entry.description ?? "This subscriber did not announce a processor contract."}
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
        {entry.kind === "core" ? null : <SubscriptionRuntimeSummary entry={entry} />}
        <ProcessorRuntimeStateView
          runtimeStateLoad={runtimeStateLoad}
          onRefresh={onRefreshRuntimeState}
          processorSlug={processor?.slug}
        />
        <div>
          <SectionHeading>Subscription</SectionHeading>
          <div className="rounded-xl bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground">
            {entry.subscriptionKey}
          </div>
        </div>
      </div>
    </>
  );
}

function ProcessorRuntimeStateView({
  runtimeStateLoad,
  onRefresh,
  processorSlug,
}: {
  runtimeStateLoad: ProcessorRuntimeStateLoad;
  onRefresh: () => void;
  processorSlug?: string;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const runtimeState = runtimeStateLoad.status === "loaded" ? runtimeStateLoad.runtimeState : null;
  const streamMaxOffset =
    runtimeStateLoad.status === "loaded" ? runtimeStateLoad.streamMaxOffset : null;
  const snapshot = runtimeState?.snapshot;
  const lag =
    snapshot == null || streamMaxOffset == null
      ? null
      : Math.max(0, streamMaxOffset - snapshot.offset);
  const isAgent = processorSlug === "agent";
  const isCore = processorSlug === "core";

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
            disabled={runtimeStateLoad.status === "loading"}
            onClick={onRefresh}
            className="size-6 text-muted-foreground"
          >
            <RefreshCwIcon
              className={cn("size-3.5", runtimeStateLoad.status === "loading" && "animate-spin")}
            />
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

function SubscriptionRuntimeSummary({ entry }: { entry: ProcessorPanelEntry }) {
  if (
    entry.subscriptionType == null &&
    entry.deliveryMode == null &&
    entry.runtimeSubscription == null &&
    entry.configuredAtOffset == null
  ) {
    return null;
  }
  const runtime = entry.runtimeSubscription;
  const connection = entry.runtimeConnection;
  return (
    <div>
      <SectionHeading>Delivery</SectionHeading>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <RuntimeStateStat label="type" value={entry.subscriptionType ?? "unknown"} />
        <RuntimeStateStat label="mode" value={entry.deliveryMode ?? runtime?.mode ?? "live"} />
        <RuntimeStateStat
          label="acked"
          value={
            connection != null
              ? `#${connection.cursor}`
              : runtime != null
                ? `#${runtime.ackedOffset}`
                : "—"
          }
        />
        <RuntimeStateStat
          label="lag"
          // Connection cursor first: the wake spine row's watermark goes
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
      {connection == null && runtime?.settleLatencyMs == null ? null : (
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
              const stats = connection?.settleLatencyMs ?? runtime?.settleLatencyMs;
              return stats == null ? "—" : `${stats.last}ms · p95 ${stats.p95}ms`;
            })()}
          />
          <RuntimeStateStat
            label="delivered"
            // Events delivered, live-connection lanes only: push/webhook
            // subscriptions track bytes (the adjacent stat), not an event
            // count — a dash beats relabeling bytes as events.
            value={connection != null ? `${connection.eventsSent} ev` : "—"}
          />
          <RuntimeStateStat
            label="bytes"
            value={
              connection != null
                ? formatFileSize(connection.bytesSent)
                : runtime?.bytesSent != null
                  ? formatFileSize(runtime.bytesSent)
                  : "—"
            }
          />
        </div>
      )}
      {entry.configuredAtOffset == null && runtime?.lastError == null ? null : (
        <div className="mt-2 rounded-xl bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {entry.configuredAtOffset == null ? null : (
            <div>configured at #{entry.configuredAtOffset}</div>
          )}
          {runtime?.parkedAtOffset == null ? null : <div>parked at #{runtime.parkedAtOffset}</div>}
          {runtime?.nextAttemptAt == null ? null : (
            <div>next attempt {new Date(runtime.nextAttemptAt).toLocaleString()}</div>
          )}
          {runtime?.lastError == null ? null : (
            <div className="mt-1 text-destructive">{runtime.lastError}</div>
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

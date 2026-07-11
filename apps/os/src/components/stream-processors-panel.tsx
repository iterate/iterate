import { useEffect, useMemo, useState } from "react";
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
import {
  hashString,
  presenceColorClasses,
  presenceInitials,
  presenceLabel,
  sparklinePoints,
  type RttMetrics,
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
 * (simulated) RTT/lag; clicking one drills into its announced contract.
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
  runtimeConnection?: Record<string, unknown>;
};

type StreamRuntimeLoad =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; state: StreamRuntimeDebugState }
  | { status: "error"; message: string };

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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  presence: readonly AgentUiPresenceEntry[];
  metrics: RttMetrics;
  eventCount: number;
  busy: boolean;
  /** Subscription key of the focused processor (URL-backed); null = overview. */
  focusedKey: string | null;
  onFocus: (subscriptionKey: string) => void;
  onBack: () => void;
  onClose: () => void;
  onClearClientDatabase: () => Promise<void>;
  getProcessorRuntimeState: (subscriptionKey: string) => Promise<ProcessorRuntimeStateResult>;
  getStreamRuntimeState: () => Promise<StreamRuntimeDebugState>;
}) {
  const [streamRuntimeLoad, setStreamRuntimeLoad] = useState<StreamRuntimeLoad>({
    status: "idle",
  });
  const [streamRefreshKey, setStreamRefreshKey] = useState(0);
  useEffect(() => {
    if (!open) {
      setStreamRuntimeLoad({ status: "idle" });
      return;
    }
    let disposed = false;
    setStreamRuntimeLoad({ status: "loading" });
    void getStreamRuntimeState()
      .then((state) => {
        if (!disposed) setStreamRuntimeLoad({ status: "loaded", state });
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setStreamRuntimeLoad({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      disposed = true;
    };
  }, [getStreamRuntimeState, open, streamRefreshKey]);

  const streamRuntime = streamRuntimeLoad.status === "loaded" ? streamRuntimeLoad.state : undefined;
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
      if (streamRuntimeLoad.status === "loading" || streamRuntimeLoad.status === "idle") {
        setRuntimeStateLoad({ status: "loading", subscriptionKey: focusedSubscriptionKey });
        return;
      }
      if (streamRuntimeLoad.status === "error") {
        setRuntimeStateLoad({
          status: "error",
          subscriptionKey: focusedSubscriptionKey,
          message: streamRuntimeLoad.message,
        });
        return;
      }
      const coreState = streamRuntimeLoad.state.coreProcessorState;
      setRuntimeStateLoad({
        status: "loaded",
        subscriptionKey: focusedSubscriptionKey,
        runtimeState: {
          snapshot: { offset: readNumber(coreState, "maxOffset") ?? 0, state: coreState },
          runtime: streamRuntimeLoad.state.runtime,
        },
        streamMaxOffset: readNumber(coreState, "maxOffset") ?? 0,
      });
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
    streamRuntimeLoad,
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
            onRefreshStreamRuntime={() => setStreamRefreshKey((key) => key + 1)}
            streamRuntimeLoad={streamRuntimeLoad}
          />
        ) : (
          <ProcessorDetail
            entry={focused}
            busy={busy}
            runtimeStateLoad={focusedRuntimeStateLoad}
            onRefreshRuntimeState={() => {
              setRefreshKey((key) => key + 1);
              if (focused.kind === "core") setStreamRefreshKey((key) => key + 1);
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
  streamRuntimeLoad,
}: {
  entries: readonly ProcessorPanelEntry[];
  metrics: RttMetrics;
  eventCount: number;
  busy: boolean;
  focusedKey: string | null;
  onFocus: (subscriptionKey: string) => void;
  onClose: () => void;
  onClearClientDatabase: () => Promise<void>;
  onRefreshStreamRuntime: () => void;
  streamRuntimeLoad: StreamRuntimeLoad;
}) {
  const [clearState, setClearState] = useState<"idle" | "clearing" | "error">("idle");
  const points = sparklinePoints(metrics.spark, 368, 44);
  const area = `2,42 ${points} 366,42`;
  const sections = processorEntrySections(entries);

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
              Append round-trip
            </span>
            <span className="font-mono text-[10px] text-muted-foreground/70">simulated</span>
          </div>
          <div className="mt-2 flex items-end gap-3">
            <span className="font-mono text-2xl font-semibold leading-none">
              {metrics.rttNow}
              <span className="text-xs text-muted-foreground">ms</span>
            </span>
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
          </div>
          <div className="mt-3 flex gap-5">
            <MetricStat label="p50" value={`${metrics.p50}ms`} />
            <MetricStat label="p95" value={`${metrics.p95}ms`} />
            <MetricStat label="events/s" value={(0.4 + (metrics.rttNow % 7) / 10).toFixed(1)} />
            <MetricStat label="head" value={`#${eventCount}`} />
          </div>
          <div className="mt-3 flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              disabled={streamRuntimeLoad.status === "loading"}
              onClick={onRefreshStreamRuntime}
              className="mr-2 text-muted-foreground"
            >
              <RefreshCwIcon
                className={cn("size-3.5", streamRuntimeLoad.status === "loading" && "animate-spin")}
              />
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
          {streamRuntimeLoad.status === "error" ? (
            <div className="mt-2 text-right text-xs text-red-600 dark:text-red-400">
              {streamRuntimeLoad.message}
            </div>
          ) : null}
        </div>
        {sections.map((section) => (
          <ProcessorEntrySection
            key={section.title}
            title={section.title}
            emptyLabel={section.emptyLabel}
            entries={section.entries}
            busy={busy}
            focusedKey={focusedKey}
            metrics={metrics}
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
  metrics,
  onFocus,
}: {
  title: string;
  emptyLabel: string;
  entries: readonly ProcessorPanelEntry[];
  busy: boolean;
  focusedKey: string | null;
  metrics: RttMetrics;
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
              metrics={metrics}
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
  metrics,
  onFocus,
}: {
  entry: ProcessorPanelEntry;
  busy: boolean;
  focused: boolean;
  metrics: RttMetrics;
  onFocus: (subscriptionKey: string) => void;
}) {
  const lag =
    entry.kind === "core" ? "0" : (entry.runtimeSubscription?.lag ?? fakeLag(entry, busy));
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
        {entry.connected ? `${fakeRtt(entry.subscriptionKey, metrics.rttNow)}ms` : "—"}
      </span>
      <span
        className={cn(
          "text-right font-mono text-xs",
          String(lag) === "0" ? "text-muted-foreground" : "text-amber-600",
        )}
      >
        {entry.kind === "core" || entry.connected || entry.runtimeSubscription != null ? lag : "—"}
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
    const runtimeConnection = readRuntimeRecord(
      streamRuntime?.runtime.connections[entry.subscriptionKey],
    );
    entries.set(entry.subscriptionKey, {
      ...entry,
      kind: subscriptionType === "configured" ? "processor" : "consumer",
      subscriptionType,
      runtimeConnection,
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
      runtimeConnection: readRuntimeRecord(streamRuntime?.runtime.connections[subscriptionKey]),
      ...(configured[subscriptionKey]?.deliveryMode === undefined
        ? {}
        : { deliveryMode: configured[subscriptionKey].deliveryMode }),
      ...(configured[subscriptionKey]?.configuredAtOffset === undefined
        ? {}
        : { configuredAtOffset: configured[subscriptionKey].configuredAtOffset }),
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
      runtimeConnection: readRuntimeRecord(streamRuntime?.runtime.connections[subscriptionKey]),
    });
  }

  return [...entries.values()].sort(compareProcessorEntries);
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
      emptyLabel: "No ephemeral consumers have connected yet.",
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

function readRuntimeRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNumber(value: unknown, key: string): number | null {
  const record = readRuntimeRecord(value);
  const field = record?.[key];
  return typeof field === "number" || typeof field === "bigint" ? Number(field) : null;
}

function isLlmish(entry: Pick<AgentUiPresenceEntry, "processor">): boolean {
  const slug = entry.processor?.slug ?? "";
  return ["agent", "capability-host"].includes(slug);
}

/** Deterministic fake RTT for preview data; stable per subscription but still visibly live. */
function fakeRtt(subscriptionKey: string, rttNow: number): number {
  return 14 + (hashString(subscriptionKey) % 38) + (rttNow % 9);
}

function fakeLag(entry: AgentUiPresenceEntry, busy: boolean): string {
  if (busy && isLlmish(entry)) return String(1 + (hashString(entry.subscriptionKey) % 3));
  return "0";
}

function MetricStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
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
  return (
    <div>
      <SectionHeading>Delivery</SectionHeading>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <RuntimeStateStat label="type" value={entry.subscriptionType ?? "unknown"} />
        <RuntimeStateStat label="mode" value={entry.deliveryMode ?? runtime?.mode ?? "live"} />
        <RuntimeStateStat label="acked" value={runtime == null ? "—" : `#${runtime.ackedOffset}`} />
        <RuntimeStateStat label="lag" value={runtime == null ? "—" : String(runtime.lag)} />
      </div>
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

function CorePrettyState({
  state,
  runtime,
}: {
  state: unknown;
  runtime: Record<string, unknown> | undefined;
}) {
  const core = asCoreState(state);
  if (core == null) {
    return <SerializedObjectCodeBlock className="max-h-[28rem]" data={state} />;
  }

  const childPaths = Array.isArray(core.childPaths) ? core.childPaths : [];
  const configured = readRuntimeRecord(core.configuredSubscribersByKey) ?? {};
  const connections = readRuntimeRecord(core.connectionsByKey) ?? {};
  const runtimeSubscriptions = readRuntimeRecord(runtime?.subscriptions) ?? {};
  const paused = core.paused === true;
  const circuitBreaker = readRuntimeRecord(core.circuitBreaker);
  const trippedAtOffset = readNumber(circuitBreaker, "trippedAtOffset");

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <RuntimeStateStat label="head" value={`#${Number(core.maxOffset ?? 0)}`} />
        <RuntimeStateStat label="events" value={String(core.eventCount ?? 0)} />
        <RuntimeStateStat label="children" value={String(childPaths.length)} />
        <RuntimeStateStat label="paused" value={paused ? "yes" : "no"} />
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <RuntimeStateStat label="configured" value={String(Object.keys(configured).length)} />
        <RuntimeStateStat label="connected" value={String(Object.keys(connections).length)} />
        <RuntimeStateStat
          label="runtime subs"
          value={String(Object.keys(runtimeSubscriptions).length)}
        />
      </div>

      {core.path == null && core.projectId == null ? null : (
        <div className="rounded-xl bg-muted/40 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70">Stream</div>
          <div className="mt-1 break-all font-mono text-xs">
            {String(core.projectId ?? "global")} {String(core.path ?? "")}
          </div>
          {typeof core.createdAt !== "string" ? null : (
            <div className="mt-1 text-xs text-muted-foreground">{core.createdAt}</div>
          )}
        </div>
      )}

      {paused || trippedAtOffset != null ? (
        <div className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          {paused ? (
            <div>Paused{typeof core.pauseReason === "string" ? `: ${core.pauseReason}` : ""}</div>
          ) : null}
          {trippedAtOffset == null ? null : (
            <div>Circuit breaker tripped at #{trippedAtOffset}</div>
          )}
        </div>
      ) : null}

      {Object.keys(configured).length === 0 ? null : (
        <div>
          <SectionHeading>Configured subscriptions</SectionHeading>
          <div className="flex flex-col gap-1.5">
            {Object.entries(configured).map(([key, value]) => {
              const latest = readRuntimeRecord(readRuntimeRecord(value)?.latestConfiguredEvent);
              const payload = readRuntimeRecord(latest?.payload);
              const delivery = readRuntimeRecord(payload?.delivery);
              const mode = typeof delivery?.mode === "string" ? delivery.mode : "unknown";
              const runtimeSub = readRuntimeRecord(runtimeSubscriptions[key]);
              const lag = readNumber(runtimeSub, "lag");
              return (
                <div key={key} className="rounded-xl bg-muted/40 px-3 py-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="min-w-0 truncate font-mono text-xs">{key}</div>
                    <div className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      {mode}
                      {lag == null ? "" : ` · lag ${lag}`}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {childPaths.length === 0 ? null : (
        <div>
          <SectionHeading>Child streams</SectionHeading>
          <div className="flex flex-col gap-1.5">
            {childPaths.slice(0, 8).map((path) => (
              <div
                key={String(path)}
                className="rounded-xl bg-muted/40 px-3 py-2 font-mono text-xs"
              >
                {String(path)}
              </div>
            ))}
          </div>
          {childPaths.length <= 8 ? null : (
            <div className="mt-1 text-xs text-muted-foreground">+{childPaths.length - 8} more</div>
          )}
        </div>
      )}
    </div>
  );
}

/** Pretty renderer for the agent processor reduced state (status machine). */
function AgentPrettyState({ state }: { state: unknown }) {
  const agent = asAgentState(state);
  if (agent == null) {
    return <SerializedObjectCodeBlock className="max-h-[28rem]" data={state} />;
  }

  const currentRequest =
    agent.currentRequest != null && typeof agent.currentRequest === "object"
      ? (agent.currentRequest as Record<string, unknown>)
      : null;
  const phase =
    currentRequest == null
      ? "idle"
      : currentRequest.phase === "scheduled"
        ? "scheduled"
        : "requested";
  const history = Array.isArray(agent.history) ? agent.history : [];
  const lastMessage = history.length > 0 ? history[history.length - 1] : null;
  const lastPreview =
    lastMessage != null && typeof lastMessage === "object" && lastMessage !== null
      ? previewChatMessage(lastMessage as Record<string, unknown>)
      : null;
  const scripts = Array.isArray(agent.inProgressScriptExecutions)
    ? agent.inProgressScriptExecutions
    : [];
  const systemPrompt = typeof agent.systemPrompt === "string" ? agent.systemPrompt : "";

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <RuntimeStateStat label="phase" value={phase} />
        <RuntimeStateStat label="provider" value={String(agent.llmProvider ?? "—")} />
        <RuntimeStateStat
          label="model"
          value={String(
            agent.llmConfig != null &&
              typeof agent.llmConfig === "object" &&
              "model" in agent.llmConfig
              ? (agent.llmConfig as { model?: unknown }).model
              : "—",
          )}
        />
        <RuntimeStateStat label="failures" value={String(agent.consecutiveLlmFailures ?? 0)} />
      </div>

      {currentRequest == null ? null : (
        <div className="rounded-xl bg-muted/40 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
            Current request
          </div>
          <div className="mt-1 font-mono text-xs break-all">{JSON.stringify(currentRequest)}</div>
        </div>
      )}

      {scripts.length === 0 ? null : (
        <div>
          <SectionHeading>In-progress scripts</SectionHeading>
          <div className="flex flex-col gap-1.5">
            {scripts.map((script, index) => {
              const row =
                script != null && typeof script === "object"
                  ? (script as Record<string, unknown>)
                  : {};
              return (
                <div
                  key={String(row.executionId ?? index)}
                  className="rounded-xl bg-muted/40 px-3 py-2"
                >
                  <div className="font-mono text-[10px] text-muted-foreground">
                    {String(row.executionId ?? "script")}
                  </div>
                  <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-foreground/80">
                    {String(row.code ?? "").slice(0, 400)}
                  </pre>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="rounded-xl bg-muted/40 px-3 py-2">
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
            History
          </div>
          <div className="font-mono text-xs text-muted-foreground">{history.length} messages</div>
        </div>
        {lastPreview == null ? (
          <div className="mt-1 text-xs text-muted-foreground">No messages yet.</div>
        ) : (
          <div className="mt-1 text-xs text-foreground/80">
            <span className="font-medium text-muted-foreground">{lastPreview.role}: </span>
            {lastPreview.text}
          </div>
        )}
        <div className="mt-1 text-[10px] text-muted-foreground/70">
          Full history is in Raw view (and in the Pretty feed).
        </div>
      </div>

      {systemPrompt === "" ? null : (
        <details className="rounded-xl bg-muted/40 px-3 py-2">
          <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-muted-foreground/70">
            System prompt
          </summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs text-foreground/80">
            {systemPrompt}
          </pre>
        </details>
      )}

      <div className="grid grid-cols-2 gap-2">
        <RuntimeStateStat label="autonomous turns" value={String(agent.autonomousTurnCount ?? 0)} />
        <RuntimeStateStat label="request gen" value={String(agent.requestGeneration ?? 0)} />
      </div>
    </div>
  );
}

function asAgentState(state: unknown): Record<string, unknown> | null {
  if (state == null || typeof state !== "object") return null;
  const record = state as Record<string, unknown>;
  // Heuristic: agent reduced state always has history + llmProvider-ish keys.
  if (!("history" in record) && !("currentRequest" in record) && !("systemPrompt" in record)) {
    return null;
  }
  return record;
}

function asCoreState(state: unknown): Record<string, unknown> | null {
  if (state == null || typeof state !== "object") return null;
  const record = state as Record<string, unknown>;
  if (
    !("maxOffset" in record) &&
    !("configuredSubscribersByKey" in record) &&
    !("connectionsByKey" in record)
  ) {
    return null;
  }
  return record;
}

function previewChatMessage(message: Record<string, unknown>): { role: string; text: string } {
  const role = String(message.role ?? message.kind ?? "message");
  const content = message.content ?? message.text ?? message;
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part != null && typeof part === "object" && "text" in part) {
          return String((part as { text?: unknown }).text ?? "");
        }
        return "";
      })
      .join("");
  } else text = JSON.stringify(content);
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > 160) text = `${text.slice(0, 157)}…`;
  return { role, text: text || "(empty)" };
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

function RuntimeStateStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-muted/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70">{label}</div>
      <div className="mt-0.5 font-mono text-sm">{value}</div>
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

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
      {children}
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

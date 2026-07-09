import { useEffect, useState } from "react";
import { ChevronLeftIcon, DatabaseZapIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { Sheet, SheetContent, SheetTitle } from "@iterate-com/ui/components/sheet";
import type { AgentUiPresenceEntry } from "@iterate-com/ui/components/events/agent-ui-reducer";
import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
import { cn } from "@iterate-com/ui/lib/utils";
import type { ProcessorRuntimeState } from "../domains/streams/rpc-types.ts";
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
}) {
  // A stale or never-connected key (e.g. after a reconnect) falls back to the
  // overview rather than a blank detail pane.
  const focused = presence.find((entry) => entry.subscriptionKey === focusedKey) ?? null;
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
  }, [focusedConnected, focusedSubscriptionKey, getProcessorRuntimeState, refreshKey]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="flex h-full w-full flex-col gap-0 p-0 data-[side=right]:sm:w-[min(92vw,48rem)] data-[side=right]:sm:max-w-[min(92vw,55vw)]"
      >
        <SheetTitle className="sr-only">
          {focused == null ? "Processors" : `Processor ${presenceLabel(focused)}`}
        </SheetTitle>
        {focused == null ? (
          <ProcessorsOverview
            presence={presence}
            metrics={metrics}
            eventCount={eventCount}
            busy={busy}
            focusedKey={focusedKey}
            onFocus={onFocus}
            onClose={onClose}
            onClearClientDatabase={onClearClientDatabase}
          />
        ) : (
          <ProcessorDetail
            entry={focused}
            busy={busy}
            runtimeStateLoad={focusedRuntimeStateLoad}
            onRefreshRuntimeState={() => setRefreshKey((key) => key + 1)}
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
  presence,
  metrics,
  eventCount,
  busy,
  focusedKey,
  onFocus,
  onClose,
  onClearClientDatabase,
}: {
  presence: readonly AgentUiPresenceEntry[];
  metrics: RttMetrics;
  eventCount: number;
  busy: boolean;
  focusedKey: string | null;
  onFocus: (subscriptionKey: string) => void;
  onClose: () => void;
  onClearClientDatabase: () => Promise<void>;
}) {
  const [clearState, setClearState] = useState<"idle" | "clearing" | "error">("idle");
  const points = sparklinePoints(metrics.spark, 368, 44);
  const area = `2,42 ${points} 366,42`;

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
        </div>
        <div>
          <div className="grid grid-cols-[minmax(0,1fr)_52px_44px] gap-1.5 px-3 pb-2 text-[10px] uppercase tracking-wider text-muted-foreground/70">
            <span>Consumer</span>
            <span className="text-right">RTT</span>
            <span className="text-right">Lag</span>
          </div>
          <div className="flex flex-col">
            {presence.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                No subscribers have connected yet.
              </p>
            ) : (
              presence.map((entry) => (
                <button
                  key={entry.subscriptionKey}
                  type="button"
                  onClick={() => onFocus(entry.subscriptionKey)}
                  className={cn(
                    "grid w-full grid-cols-[minmax(0,1fr)_52px_44px] items-center gap-1.5 rounded-xl px-3 py-2 text-left hover:bg-muted/40",
                    entry.subscriptionKey === focusedKey &&
                      "bg-muted/60 ring-1 ring-inset ring-border",
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <PresenceAvatar entry={entry} busy={busy && isLlmish(entry)} />
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-xs">
                        {presenceLabel(entry)}
                      </span>
                      <span
                        className={cn(
                          "block text-xs",
                          entry.connected
                            ? busy && isLlmish(entry)
                              ? "text-amber-600"
                              : "text-emerald-600"
                            : "text-muted-foreground/60",
                        )}
                      >
                        {entry.connected
                          ? busy && isLlmish(entry)
                            ? "processing"
                            : "connected"
                          : "disconnected"}
                      </span>
                    </span>
                  </span>
                  <span className="text-right font-mono text-xs text-muted-foreground">
                    {entry.connected ? `${fakeRtt(entry.subscriptionKey, metrics.rttNow)}ms` : "—"}
                  </span>
                  <span
                    className={cn(
                      "text-right font-mono text-xs",
                      fakeLag(entry, busy) === "0" ? "text-muted-foreground" : "text-amber-600",
                    )}
                  >
                    {entry.connected ? fakeLag(entry, busy) : "—"}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function isLlmish(entry: AgentUiPresenceEntry): boolean {
  const slug = entry.processor?.slug ?? "";
  return ["agent", "openai-ws", "cloudflare-ai", "capability-host"].includes(slug);
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
  entry: AgentUiPresenceEntry;
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
            {entry.connected ? "connected" : "disconnected"} · {entry.direction}
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
          {showRaw || !isAgent ? (
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

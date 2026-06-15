import { useMemo, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { BanIcon, ChevronRightIcon, CodeIcon } from "lucide-react";
import type {
  AgentUiActivity,
  AgentUiCodeStep,
  AgentUiItem,
  AgentUiLlmStep,
  AgentUiMessageItem,
  AgentUiState,
  AgentUiStep,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@iterate-com/ui/components/ai-elements/message";
import { Button } from "@iterate-com/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@iterate-com/ui/components/empty";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { cn } from "@iterate-com/ui/lib/utils";
import { AGENT_UI_FEED_TABLE } from "~/domains/streams/browser-processors/agent-ui-processor.ts";
import { useStreamQuery } from "~/domains/streams/engine/browser/hooks/use-stream-query.ts";
import type { StreamBrowserDatabase } from "~/domains/streams/engine/browser/stream-browser-db.ts";
import { useVirtualizedTailScroll } from "~/lib/use-virtualized-tail-scroll.ts";

/**
 * The clean agent chat feed: user message → activity ("Ran code 2× · 3
 * requests · 7.4 s") → assistant message.
 *
 * Settled items are `agent_feed_items` rows written by the agent-ui
 * processor; the TanStack virtual list windows over them with reactive
 * SQLite queries. The in-flight activity — with live-streaming thinking and
 * response text — renders as one element below the list, straight from the
 * processor's reduced state.
 */
export function AgentFeedView({
  database,
  liveState,
  search = "",
  emptyLabel = "No messages yet.",
  isPending = false,
  isInterruptingQueuedMessages = false,
  onInterruptQueuedMessages,
}: {
  database: StreamBrowserDatabase;
  liveState: AgentUiState | null;
  search?: string;
  emptyLabel?: string;
  isPending?: boolean;
  isInterruptingQueuedMessages?: boolean;
  onInterruptQueuedMessages?: () => Promise<void> | void;
}) {
  const query = search.trim().toLowerCase();
  const countResult = useStreamQuery(
    database,
    query === ""
      ? `SELECT COUNT(*) AS count FROM ${AGENT_UI_FEED_TABLE}`
      : `SELECT COUNT(*) AS count FROM ${AGENT_UI_FEED_TABLE} WHERE json(data) LIKE ?`,
    query === "" ? [] : [`%${query}%`],
  );
  const itemCount = Number(countResult.data[0]?.count ?? 0);
  const live = liveState?.live ?? null;
  const queuedUserMessages = liveState?.queuedUserMessages ?? [];
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());

  const virtualizer = useVirtualizer({
    count: itemCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 56,
    // Agent feed rows are append-only and addressed by dense local_index, so
    // the virtual index is a stable item key for TanStack's end anchoring.
    getItemKey: (index) => index,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 80,
    overscan: 16,
    directDomUpdates: true,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const first = virtualItems[0]?.index ?? 0;
  const last = virtualItems.at(-1)?.index ?? -1;
  const rowsResult = useStreamQuery(
    database,
    query === ""
      ? `SELECT local_index, json(data) AS data FROM ${AGENT_UI_FEED_TABLE}
         WHERE local_index >= ? AND local_index < ?
         ORDER BY local_index ASC`
      : `SELECT local_index, json(data) AS data FROM ${AGENT_UI_FEED_TABLE}
         WHERE json(data) LIKE ?
         ORDER BY local_index ASC
         LIMIT ? OFFSET ?`,
    query === "" ? [first, last + 1] : [`%${query}%`, Math.max(0, last + 1 - first), first],
  );
  // Retain the last committed rows across range re-queries so already-visible
  // rows don't flash to skeletons while the shifted window's SQL runs. The
  // retained rows are only valid for the search they were fetched under —
  // reusing them across a filter change would briefly show unfiltered rows.
  const lastRowsRef = useRef<{ query: string; rows: Map<number, AgentUiItem> }>({
    query: "",
    rows: new Map(),
  });
  const itemsByIndex = useMemo(() => {
    if (rowsResult.status !== "ok") {
      return lastRowsRef.current.query === query
        ? lastRowsRef.current.rows
        : new Map<number, AgentUiItem>();
    }
    const rows = new Map<number, AgentUiItem>();
    rowsResult.data.forEach((row, position) => {
      const index = query === "" ? Number(row.local_index) : first + position;
      try {
        rows.set(index, JSON.parse(String(row.data)) as AgentUiItem);
      } catch {
        // Skip unparseable rows; the row stays a skeleton.
      }
    });
    lastRowsRef.current = { query, rows };
    return rows;
  }, [rowsResult.data, rowsResult.status, query, first]);

  // Follow new content down while the reader is pinned to the bottom — both
  // when settled rows land and on every live streaming tick.
  const liveSignature =
    live == null
      ? queuedUserMessages.map((message) => `${message.id}:${message.text.length}`).join("|")
      : live.steps
          .map((step) =>
            step.kind === "llm"
              ? `${step.id}:${step.thinkingText.length}:${step.responseText.length}:${step.status}`
              : `${step.id}:${step.code.length}:${step.status}`,
          )
          .join("|") +
        "|" +
        queuedUserMessages.map((message) => `${message.id}:${message.text.length}`).join("|");
  useVirtualizedTailScroll({
    contentSignature: liveSignature,
    count: itemCount + (live == null ? 0 : 1) + queuedUserMessages.length,
    resetKey: database,
    scrollElementRef: scrollRef,
    virtualizer,
  });

  function toggleExpanded(id: string) {
    setExpandedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 pb-6 pt-5 md:px-6">
        {itemCount === 0 && live == null && queuedUserMessages.length === 0 ? (
          <Empty className="min-h-48">
            <EmptyHeader>
              {isPending ? <Spinner className="size-4" /> : null}
              <EmptyTitle>{isPending ? "Connecting to the stream" : "Nothing here yet"}</EmptyTitle>
              {isPending ? null : <EmptyDescription>{emptyLabel}</EmptyDescription>}
            </EmptyHeader>
          </Empty>
        ) : null}
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualItems.map((virtualItem) => {
            const item = itemsByIndex.get(virtualItem.index);
            return (
              <div
                key={virtualItem.key}
                data-index={virtualItem.index}
                ref={virtualizer.measureElement}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${virtualItem.start}px)` }}
              >
                {item == null ? (
                  <div className="my-2 h-10 rounded-xl bg-muted/40" />
                ) : (
                  <AgentFeedItemRow
                    item={item}
                    expandedIds={expandedIds}
                    onToggle={toggleExpanded}
                  />
                )}
              </div>
            );
          })}
        </div>
        {live == null ? null : (
          <AgentLiveActivity live={live} expandedIds={expandedIds} onToggle={toggleExpanded} />
        )}
        {queuedUserMessages.length === 0 ? null : (
          <QueuedMessagesPanel
            messages={queuedUserMessages}
            isInterrupting={isInterruptingQueuedMessages}
            onInterrupt={onInterruptQueuedMessages}
          />
        )}
      </div>
    </div>
  );
}

function AgentFeedItemRow({
  item,
  expandedIds,
  onToggle,
}: {
  item: AgentUiItem;
  expandedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  if (item.kind !== "activity") {
    if (item.kind === "user") {
      return (
        <Message from="user" className="pb-2 pt-3.5">
          <MessageContent className="group-[.is-user]:rounded-2xl">
            <div className="whitespace-pre-wrap leading-6">{item.text}</div>
          </MessageContent>
        </Message>
      );
    }
    return (
      <Message from="assistant" className="py-2">
        <MessageContent>
          <MessageResponse className="min-w-0 max-w-full overflow-hidden">
            {item.text}
          </MessageResponse>
        </MessageContent>
      </Message>
    );
  }

  return (
    <AgentActivityRow
      activity={item}
      expanded={expandedIds.has(item.id)}
      expandedIds={expandedIds}
      onToggle={onToggle}
    />
  );
}

// ---------------------------------------------------------------------------
// Settled activity: the quiet "Ran code 2× · 3 requests · 7.4 s" row
// ---------------------------------------------------------------------------

function AgentActivityRow({
  activity,
  expanded,
  expandedIds,
  onToggle,
}: {
  activity: AgentUiActivity;
  expanded: boolean;
  expandedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  const interrupted = activityWasInterrupted(activity);

  return (
    <div className="flex flex-col py-0.5">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={expanded}
        title="Agent activity — click to see what it did"
        onClick={() => onToggle(activity.id)}
        className="-ml-2.5 self-start font-medium text-muted-foreground"
      >
        {interrupted ? (
          <BanIcon className="size-3 text-red-600 dark:text-red-400" />
        ) : (
          <CodeIcon className="size-3 text-muted-foreground/60" />
        )}
        {activitySummary(activity)}
        <ChevronRightIcon
          className={cn(
            "size-2.5 text-muted-foreground/50 transition-transform",
            expanded && "rotate-90",
          )}
        />
      </Button>
      {expanded ? (
        <div className="mb-1.5 ml-1 mt-0.5 flex flex-col gap-0.5 border-l-2 border-muted py-1 pl-4">
          {activity.steps.map((step) => (
            <AgentActivityStep
              key={step.id}
              step={step}
              expanded={expandedIds.has(step.id)}
              onToggle={onToggle}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function QueuedMessagesPanel({
  messages,
  isInterrupting,
  onInterrupt,
}: {
  messages: AgentUiMessageItem[];
  isInterrupting: boolean;
  onInterrupt?: () => Promise<void> | void;
}) {
  return (
    <div className="flex flex-col gap-2 py-3">
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-border" />
        <span className="font-mono text-xs text-muted-foreground">
          Queued messages for after the next agent turn
        </span>
        <div className="h-px flex-1 bg-border" />
      </div>
      {messages.map((message) => (
        <Message key={message.id} from="user" className="py-1">
          <MessageContent className="group-[.is-user]:rounded-2xl">
            <div className="whitespace-pre-wrap leading-6">{message.text}</div>
          </MessageContent>
        </Message>
      ))}
      {onInterrupt == null ? null : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void onInterrupt()}
          disabled={isInterrupting}
          className="self-end border-red-200 bg-red-50 text-red-700 shadow-sm hover:border-red-300 hover:bg-red-100 hover:text-red-800 dark:border-red-900/70 dark:bg-red-950/30 dark:text-red-300 dark:hover:bg-red-950/50"
        >
          {isInterrupting ? (
            <Spinner className="size-3" />
          ) : (
            <BanIcon className="size-3 text-current" />
          )}
          Interrupt agent and send now
        </Button>
      )}
    </div>
  );
}

function activitySummary(activity: AgentUiActivity): string {
  const codeCount = activity.steps.filter((step) => step.kind === "code").length;
  const requestCount = activity.steps.filter((step) => step.kind === "llm").length;
  const interrupted = activity.steps.some(
    (step) => step.kind === "llm" && step.outcome === "cancelled",
  );
  const interruptedWithPartialResponse = activity.steps.some(
    (step) =>
      step.kind === "llm" && step.outcome === "cancelled" && llmStepHasPartialResponse(step),
  );
  const parts: string[] = [];
  if (codeCount > 0) parts.push(`Ran code ${codeCount}×`);
  parts.push(`${requestCount} request${requestCount === 1 ? "" : "s"}`);
  if (interrupted) {
    parts.push(
      interruptedWithPartialResponse
        ? "interrupted (click to see partial response)"
        : "interrupted",
    );
  }
  const totalMs =
    activity.endedAtMs == null ? null : Math.max(0, activity.endedAtMs - activity.startedAtMs);
  if (totalMs != null && totalMs > 0) parts.push(formatSeconds(totalMs));
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Steps: condensed LLM request and code-run rows with expandable detail
// ---------------------------------------------------------------------------

function AgentActivityStep({
  step,
  expanded,
  onToggle,
}: {
  step: AgentUiStep;
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="flex flex-col">
      <Button
        variant="ghost"
        size="xs"
        aria-expanded={expanded}
        onClick={() => onToggle(step.id)}
        className="-ml-2 self-start font-normal"
      >
        {step.kind === "llm" ? (
          <span className="shrink-0 text-[11px] leading-none text-muted-foreground/50">✦</span>
        ) : (
          <CodeIcon className="size-3 text-muted-foreground" />
        )}
        <span className="font-mono text-xs text-foreground/70">{stepLabel(step)}</span>
        <span className="font-mono text-xs text-muted-foreground/70">{stepMeta(step)}</span>
        <ChevronRightIcon
          className={cn(
            "size-2 text-muted-foreground/50 transition-transform",
            expanded && "rotate-90",
          )}
        />
      </Button>
      {expanded ? (
        <div className="flex flex-col gap-2 pb-2.5 pl-5 pt-0.5">
          {step.kind === "llm" ? <LlmStepDetail step={step} /> : <CodeStepDetail step={step} />}
        </div>
      ) : null}
    </div>
  );
}

function stepLabel(step: AgentUiStep): string {
  if (step.kind === "code") return "Ran code";
  return step.model ?? step.provider ?? "LLM request";
}

function stepMeta(step: AgentUiStep): string {
  if (step.kind === "code") {
    return step.durationMs == null ? "" : formatSeconds(step.durationMs);
  }
  const parts: string[] = [];
  if (step.inputTokens != null || step.outputTokens != null) {
    parts.push(`${formatTokens(step.inputTokens)} → ${formatTokens(step.outputTokens)} tok`);
  }
  if (step.durationMs != null) parts.push(formatSeconds(step.durationMs));
  if (step.outcome === "failed") parts.push("failed");
  return parts.join(" · ");
}

function llmStepHasPartialResponse(step: AgentUiLlmStep): boolean {
  return step.thinkingText !== "" || step.responseText !== "";
}

function LlmStepDetail({ step }: { step: AgentUiLlmStep }) {
  return (
    <>
      {step.thinkingText === "" ? null : <ThinkingBlock>{step.thinkingText}</ThinkingBlock>}
      {step.responseText === "" ? null : looksLikeCode(step.responseText) ? (
        <SourceCodeBlock
          code={step.responseText}
          language="typescript"
          className="max-h-80"
          showCopyButton
          showLineNumbers={false}
          plainChrome
        />
      ) : (
        <div className="max-w-2xl whitespace-pre-wrap px-1.5 text-sm leading-relaxed">
          {step.responseText}
        </div>
      )}
      <pre className="overflow-x-auto rounded-xl bg-muted/50 px-4 py-3 font-mono text-xs leading-relaxed text-foreground">
        {JSON.stringify(llmStepRawSummary(step), null, 2)}
      </pre>
    </>
  );
}

function llmStepRawSummary(step: AgentUiLlmStep) {
  return {
    ...(step.model == null ? {} : { model: step.model }),
    ...(step.provider == null ? {} : { provider: step.provider }),
    usage: { input_tokens: step.inputTokens ?? null, output_tokens: step.outputTokens ?? null },
    ...(step.durationMs == null ? {} : { duration_ms: step.durationMs }),
    status: step.outcome ?? step.status,
    ...(step.errorMessage == null ? {} : { error: step.errorMessage }),
    ...(step.providerResponseId == null ? {} : { provider_response_id: step.providerResponseId }),
  };
}

function CodeStepDetail({ step }: { step: AgentUiCodeStep }) {
  return (
    <>
      {step.code === "" ? null : (
        <SourceCodeBlock
          code={step.code}
          language="typescript"
          className="max-h-80"
          showCopyButton
          showLineNumbers={false}
          plainChrome
        />
      )}
      {step.result === undefined && step.errorMessage == null ? null : (
        <div className="flex items-start gap-2.5">
          <span
            className={cn(
              "shrink-0 pt-2.5 font-mono text-xs",
              step.errorMessage == null ? "text-emerald-600" : "text-destructive",
            )}
          >
            →
          </span>
          <pre
            className={cn(
              "min-w-0 flex-1 overflow-x-auto rounded-xl px-4 py-2.5 font-mono text-xs leading-relaxed",
              step.errorMessage == null
                ? "bg-emerald-50 text-emerald-950 dark:bg-emerald-950/30 dark:text-emerald-200"
                : "bg-destructive/5 text-destructive",
            )}
          >
            {step.errorMessage ?? stringifyResult(step.result)}
          </pre>
        </div>
      )}
      {step.logs == null || step.logs.length === 0 ? null : (
        <pre className="overflow-x-auto rounded-xl bg-muted/50 px-4 py-2.5 font-mono text-xs leading-relaxed text-muted-foreground">
          {step.logs.join("\n")}
        </pre>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// The live element: streaming thinking and code with a blinking cursor
// ---------------------------------------------------------------------------

/**
 * Rendered below the virtual list whenever an activity is in flight. Receives
 * the live reduced state on every chunk: finished steps collapse upward into
 * quiet rows while the current step streams its thinking or code.
 */
function AgentLiveActivity({
  live,
  expandedIds,
  onToggle,
}: {
  live: AgentUiActivity;
  expandedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  const liveStep = live.steps.findLast((step) => step.status === "running");
  const doneSteps = live.steps.filter((step) => step.status === "done");
  // A waiting activity (agent idle, no chat message yet) keeps its steps on
  // screen — the next round rolls into it — but parks the spinner.
  const working = liveStep != null || live.status === "running";
  const showStepRail =
    doneSteps.length > 0 || (liveStep != null && liveStepHasVisibleContent(liveStep));

  if (!working && activityWasInterrupted(live)) {
    return (
      <AgentActivityRow
        activity={live}
        expanded={expandedIds.has(live.id)}
        expandedIds={expandedIds}
        onToggle={onToggle}
      />
    );
  }

  return (
    <div className="flex flex-col py-0.5">
      {working ? (
        <div className="flex h-7 items-center gap-2 self-start px-0.5">
          <Spinner className="size-3 shrink-0 text-amber-600" />
          <span className="text-sm font-medium text-amber-700 dark:text-amber-500">
            {liveActivityLabel(live, liveStep)}
          </span>
        </div>
      ) : null}
      {showStepRail ? (
        <div className="mb-1.5 ml-1 mt-0.5 flex flex-col gap-0.5 border-l-2 border-muted py-1 pl-4">
          {doneSteps.map((step) => (
            <AgentActivityStep
              key={step.id}
              step={step}
              expanded={expandedIds.has(step.id)}
              onToggle={onToggle}
            />
          ))}
          {liveStep == null ? null : <LiveStepStream step={liveStep} />}
        </div>
      ) : null}
    </div>
  );
}

function activityWasInterrupted(activity: AgentUiActivity): boolean {
  return activity.steps.some((step) => step.kind === "llm" && step.outcome === "cancelled");
}

function liveStepHasVisibleContent(step: AgentUiStep) {
  if (step.kind === "code") return step.code !== "";
  return step.thinkingText !== "" || step.responseText !== "";
}

function liveActivityLabel(live: AgentUiActivity, liveStep: AgentUiStep | undefined): string {
  // Steps exist but none is running: the turn is between steps (or waiting to
  // settle) — "Working…", not "Thinking…".
  if (liveStep == null) return live.steps.length > 0 ? "Working…" : "Thinking…";
  if (liveStep.kind === "code") return "Running code…";
  if (liveStep.responseText !== "") {
    return looksLikeCode(liveStep.responseText) ? "Writing code…" : "Responding…";
  }
  return "Thinking…";
}

/** Code-mode agents stream itx code as their response; chat agents stream prose. */
function looksLikeCode(text: string): boolean {
  return text.includes("```") || /^\s*(async|await|function|const|let|import)\b/.test(text);
}

function LiveStepStream({ step }: { step: AgentUiStep }) {
  if (step.kind === "code") {
    return (
      <div className="flex flex-col gap-1.5 py-1">
        {step.code === "" ? null : <StreamingCodeBlock code={step.code} />}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 py-1">
      {step.thinkingText === "" ? null : (
        <div className="max-w-2xl whitespace-pre-wrap px-1.5 text-sm italic leading-relaxed text-muted-foreground">
          {step.thinkingText}
          {step.responseText === "" ? <StreamingCursor /> : null}
        </div>
      )}
      {step.responseText === "" ? null : looksLikeCode(step.responseText) ? (
        <StreamingCodeBlock code={step.responseText} />
      ) : (
        <div className="max-w-2xl whitespace-pre-wrap px-1.5 text-sm leading-relaxed">
          {step.responseText}
          <StreamingCursor />
        </div>
      )}
    </div>
  );
}

/** Amber-tinted block the response/code streams into, character by character. */
function StreamingCodeBlock({ code }: { code: string }) {
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-xl bg-amber-50 px-4 py-3 font-mono text-xs leading-relaxed text-foreground dark:bg-amber-950/20">
      {code}
      <StreamingCursor className="bg-amber-600" />
    </pre>
  );
}

function StreamingCursor({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "ml-px inline-block h-3.5 w-[7px] animate-caret-blink bg-muted-foreground/40 align-[-2px]",
        className,
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// Thinking block (shared by settled steps)
// ---------------------------------------------------------------------------

function ThinkingBlock({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-2xl whitespace-pre-wrap rounded-xl bg-muted/50 px-4 py-3 text-sm italic leading-relaxed text-muted-foreground">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatTokens(count: number | undefined): string {
  if (count == null) return "?";
  if (count < 1000) return String(count);
  return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

function formatSeconds(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(1).replace(/\.0$/, "")} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2) ?? String(result);
  } catch {
    return String(result);
  }
}

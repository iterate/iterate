import { memo, useCallback, useLayoutEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { AgentRuntime } from "@iterate-com/shared/agent-events";
import {
  BanIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleQuestionMarkIcon,
  CodeIcon,
  GitBranchIcon,
  PaperclipIcon,
  PauseIcon,
  PlayIcon,
} from "lucide-react";
import {
  formatAgentUiActivitySummary,
  isAgentUiActivityWorking,
  summarizeAgentUiActivity,
  type AgentUiActivity,
  type AgentUiFileAttachment,
  type AgentUiItem,
  type AgentUiMessageItem,
  type AgentUiMessageVia,
  type AgentUiStep,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@iterate-com/ui/components/ai-elements/message";
import { Button } from "@iterate-com/ui/components/button";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@iterate-com/ui/components/tooltip";
import { cn } from "@iterate-com/ui/lib/utils";
import { deriveAgentDisplayState } from "~/domains/agents/agent-presence.ts";
import {
  formatClockTime,
  formatDateTime,
  formatDateTimeAttribute,
  formatElapsedSeconds,
  formatFileSize,
  formatSeconds,
  formatTokens,
  liveActivityLabel,
  looksLikeCode,
} from "~/lib/feed-format.ts";
import { linkOptionsForStreamPath } from "~/lib/stream-routes.ts";
import { useTickingNowMs } from "~/lib/use-ticking-now-ms.ts";

// The clean agent chat rows: user and assistant messages plus archived
// activity rows ("Ran code 2× · 3 requests · 7.4 s"), and the live in-flight
// activity tail. The rows are `agent.*` feed_items written by the browser-feed
// projector; the virtualized list that windows over them lives in
// stream-feed-view.tsx — this file owns only how each item renders.

// Memoized: the feed re-renders on every 16ms live-streaming tick, and settled
// rows (markdown, highlighted code) must not re-render along with it. Item
// objects keep their identity between ticks — the row map is only rebuilt when
// the underlying SQLite snapshot actually changes.
export const AgentFeedItemRow = memo(function AgentFeedItemRow({
  item,
  toggledIds,
  onToggle,
  onInspectLlmRequest,
  onInspectScriptExecution,
  projectSlug,
}: {
  item: AgentUiItem;
  toggledIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  /** Opens the LLM request inspector at this llmRequestOffset (llm steps only). */
  onInspectLlmRequest?: (llmRequestOffset: number) => void;
  /** Opens the script execution inspector at this execution id (code steps only). */
  onInspectScriptExecution?: (executionId: string) => void;
  projectSlug?: string;
}) {
  if (item.kind === "stream-woken") {
    return <StreamWakeRow item={item} />;
  }

  if (item.kind === "processor-revived") {
    return <ProcessorRevivedRow item={item} />;
  }

  if (item.kind === "child-stream-created") {
    return <ChildStreamCreatedRow item={item} projectSlug={projectSlug} />;
  }

  if (item.kind === "stream-paused" || item.kind === "stream-resumed") {
    return <StreamPauseRow item={item} />;
  }

  if (item.kind === "user") {
    return (
      <Message
        from="user"
        className="pb-2 pt-3.5"
        data-testid="agent-feed-message"
        data-kind="user"
      >
        <MessageContent className="group-[.is-user]:rounded-2xl">
          <UserMessageBody item={item} />
        </MessageContent>
      </Message>
    );
  }

  if (item.kind === "assistant") {
    return (
      <Message
        from="assistant"
        className="py-2"
        data-testid="agent-feed-message"
        data-kind="assistant"
      >
        <MessageContent>
          {item.via == null ? null : (
            <MessageViaLabel via={item.via} className="text-muted-foreground" />
          )}
          {/* Settled messages never stream, so skip streamdown's unpaired-
              marker balancing — it appends a phantom `*` to text like "17 * 23".
              mode="static" is load-bearing for the virtualized feed: streaming
              mode paints EMPTY on mount and fills the markdown in a deferred
              transition, so every row mounting in the virtual window measures
              ~16px before snapping to its real height — a measurement storm
              that breaks the virtualizer's end anchor. Static mode renders
              synchronously; the first measurement is the real one. */}
          <MessageResponse
            className="min-w-0 max-w-full overflow-hidden"
            mode="static"
            parseIncompleteMarkdown={false}
          >
            {item.text}
          </MessageResponse>
          <MessageAttachments files={item.files} hasText={item.text !== ""} />
        </MessageContent>
      </Message>
    );
  }

  if (item.kind === "activity") {
    return (
      <AgentActivityRow
        activity={item}
        expanded={toggledIds.has(item.id)}
        onToggle={onToggle}
        onInspectLlmRequest={onInspectLlmRequest}
        onInspectScriptExecution={onInspectScriptExecution}
      />
    );
  }

  return null;
});

function ChildStreamCreatedRow({
  item,
  projectSlug,
}: {
  item: Extract<AgentUiItem, { kind: "child-stream-created" }>;
  projectSlug?: string;
}) {
  const dateTime = formatDateTimeAttribute(item.timestampMs);
  const streamLabel = compactStreamPath(item.childPath);
  const linkOptions =
    projectSlug == null ? null : linkOptionsForStreamPath(projectSlug, item.childPath);

  return (
    <div
      className="flex items-center gap-2 py-2 text-xs text-muted-foreground"
      data-testid="agent-feed-child-stream-created"
      data-kind="child-stream-created"
    >
      <div className="h-px min-w-8 flex-1 bg-border/70" />
      <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />
      <span className="shrink-0">Created child stream</span>
      {linkOptions == null ? (
        <span className="min-w-0 truncate font-mono text-foreground/70">{streamLabel}</span>
      ) : (
        <Link
          {...linkOptions}
          className="min-w-0 truncate font-mono text-foreground/80 underline-offset-4 hover:text-foreground hover:underline"
        >
          {streamLabel}
        </Link>
      )}
      <time className="sr-only" dateTime={dateTime}>
        {formatDateTime(item.timestampMs)}
      </time>
      <div className="h-px min-w-8 flex-1 bg-border/70" />
    </div>
  );
}

function StreamWakeRow({ item }: { item: Extract<AgentUiItem, { kind: "stream-woken" }> }) {
  const dateTime = formatDateTimeAttribute(item.timestampMs);

  return (
    <div
      className="flex items-center gap-3 py-3"
      data-testid="agent-feed-stream-woken"
      data-kind="stream-woken"
    >
      <div className="h-px flex-1 bg-purple-500/45" />
      <div className="flex shrink-0 items-center gap-1.5">
        <time
          className="font-mono text-xs font-medium text-purple-700 dark:text-purple-300"
          dateTime={dateTime}
          title={formatDateTime(item.timestampMs)}
        >
          {item.text}
        </time>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Why did this stream Durable Object wake?"
                className="inline-flex size-4 items-center justify-center rounded-full text-purple-700/75 transition-colors hover:text-purple-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500/60 dark:text-purple-300/75 dark:hover:text-purple-200"
              />
            }
          >
            <CircleQuestionMarkIcon className="size-3.5" aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent className="max-w-80 text-left leading-snug">
            <p>
              This can happen when the Durable Object is evicted or crashed, and most often when we
              do a production deployment. Processors with in-flight work are revived and adopt it; a
              revival marker appears in the feed when that happens.
            </p>
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="h-px flex-1 bg-purple-500/45" />
    </div>
  );
}

function ProcessorRevivedRow({
  item,
}: {
  item: Extract<AgentUiItem, { kind: "processor-revived" }>;
}) {
  const dateTime = formatDateTimeAttribute(item.timestampMs);
  const label =
    item.processorSlug == null ? "Processor revived" : `${item.processorSlug} processor revived`;

  return (
    <div
      className="flex items-center gap-3 py-3"
      data-testid="agent-feed-processor-revived"
      data-kind="processor-revived"
    >
      <div className="h-px flex-1 bg-amber-500/40" />
      <div className="flex shrink-0 items-center gap-1.5">
        <time
          className="font-mono text-xs font-medium text-amber-700 dark:text-amber-300"
          dateTime={dateTime}
          title={formatDateTime(item.timestampMs)}
        >
          {label}
        </time>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="What does a processor revival mean?"
                className="inline-flex size-4 items-center justify-center rounded-full text-amber-700/75 transition-colors hover:text-amber-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60 dark:text-amber-300/75 dark:hover:text-amber-200"
              />
            }
          >
            <CircleQuestionMarkIcon className="size-3.5" aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent className="max-w-80 text-left leading-snug">
            <p>
              This processor's runtime died while it had work in flight (an eviction, crash, or
              deployment) and the platform revived it. The open work was adopted and continued —
              nothing was cancelled or lost.
            </p>
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="h-px flex-1 bg-amber-500/40" />
    </div>
  );
}

function StreamPauseRow({
  item,
}: {
  item: Extract<AgentUiItem, { kind: "stream-paused" | "stream-resumed" }>;
}) {
  const dateTime = formatDateTimeAttribute(item.timestampMs);
  const paused = item.kind === "stream-paused";
  const Icon = paused ? PauseIcon : PlayIcon;

  return (
    <div
      className="flex items-center gap-3 py-3"
      data-testid="agent-feed-stream-pause-state"
      data-kind={item.kind}
    >
      <div className="h-px flex-1 bg-border" />
      <div className="flex min-w-0 shrink items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-muted-foreground">
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        <time
          className="truncate text-xs font-medium"
          dateTime={dateTime}
          title={formatDateTime(item.timestampMs)}
        >
          {item.reason == null ? item.text : `${item.text}: ${item.reason}`}
        </time>
      </div>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settled activity: the quiet "Ran code 2× · 3 requests · 7.4 s" row
// ---------------------------------------------------------------------------

function AgentActivityRow({
  activity,
  expanded,
  onToggle,
  onInspectLlmRequest,
  onInspectScriptExecution,
}: {
  activity: AgentUiActivity;
  expanded: boolean;
  onToggle: (id: string) => void;
  onInspectLlmRequest?: (llmRequestOffset: number) => void;
  onInspectScriptExecution?: (executionId: string) => void;
}) {
  const summary = summarizeAgentUiActivity(activity);
  const failed = summary.outcome === "failed";

  return (
    <div className="flex flex-col py-0.5">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={expanded}
        title="Agent activity — click to see what it did"
        onClick={() => onToggle(activity.id)}
        className={cn(
          "-ml-2.5 self-start font-medium text-muted-foreground",
          failed && "text-destructive hover:text-destructive",
        )}
      >
        {failed ? (
          <CircleAlertIcon data-icon="inline-start" className="text-destructive" />
        ) : summary.outcome === "interrupted" ? (
          <BanIcon data-icon="inline-start" className="text-destructive" />
        ) : (
          <CodeIcon data-icon="inline-start" className="text-muted-foreground/60" />
        )}
        {formatAgentUiActivitySummary(activity, {
          summary,
          interruptedPartialHint: "click to see partial response",
        })}
        <ChevronRightIcon
          data-icon="inline-end"
          className={cn("text-muted-foreground/50 transition-transform", expanded && "rotate-90")}
        />
      </Button>
      {expanded ? (
        <div className="mb-1.5 ml-1 mt-0.5 flex flex-col gap-0.5 border-l-2 border-muted py-1 pl-4">
          {activity.steps.map((step) => (
            <AgentActivityStep
              key={step.id}
              step={step}
              onInspectLlmRequest={onInspectLlmRequest}
              onInspectScriptExecution={onInspectScriptExecution}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Messages queued for after the running turn, rendered as PART OF THE
 * COMPOSER: the queue is input that hasn't reached the agent yet, so it
 * belongs with the input surface, not in the feed's history. The stack is a
 * rounded card tucked behind the composer pill (the pill overlaps its bottom
 * edge). On phones it collapses to the newest message — each new queued
 * message pushes the previous one out of view — with a "+N more" toggle;
 * wider viewports show the whole (scroll-capped) stack.
 */
export function QueuedMessagesPanel({
  messages,
  isInterrupting,
  onInterrupt,
}: {
  messages: AgentUiMessageItem[];
  isInterrupting: boolean;
  onInterrupt?: () => Promise<void> | void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (messages.length === 0) return null;
  const hiddenCount = messages.length - 1;
  return (
    <div
      className="-mb-4 rounded-t-3xl border border-b-0 bg-muted/40 px-3 pb-6 pt-1.5"
      data-testid="queued-messages-panel"
    >
      <div className="flex items-center gap-2 px-1.5 py-1">
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
          Queued for the next agent turn
        </span>
        {hiddenCount > 0 ? (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="shrink-0 font-mono text-[11px] text-muted-foreground underline-offset-2 hover:underline sm:hidden"
          >
            {expanded ? "collapse" : `+${hiddenCount} more`}
          </button>
        ) : null}
        {onInterrupt == null ? null : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void onInterrupt()}
            disabled={isInterrupting}
            className="ml-auto h-6 shrink-0 gap-1 px-2 text-[11px] text-red-700 hover:bg-red-50 hover:text-red-800 dark:text-red-300 dark:hover:bg-red-950/30"
          >
            {isInterrupting ? (
              <Spinner className="size-3" />
            ) : (
              <BanIcon className="size-3 text-current" />
            )}
            Interrupt & send now
          </Button>
        )}
      </div>
      <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
        {messages.map((message, index) => (
          <div
            key={message.id}
            className={cn(
              "rounded-xl border bg-background/80 px-3 py-1.5 text-sm",
              // The mobile push-out: only the newest message stays pinned to
              // the composer while collapsed.
              !expanded && index < messages.length - 1 && "hidden sm:block",
            )}
          >
            <UserMessageBody item={message} />
          </div>
        ))}
      </div>
    </div>
  );
}

function UserMessageBody({ item }: { item: AgentUiMessageItem }) {
  return (
    <>
      {item.via == null ? null : <MessageViaLabel via={item.via} className="opacity-70" />}
      {item.text === "" ? null : item.via == null ? (
        <div className="whitespace-pre-wrap leading-6">{item.text}</div>
      ) : (
        // Slack text is converted to markdown-ish (mentions, [label](url)
        // links) by the reducer — render it through the markdown path so
        // links come out clickable instead of as raw syntax. Settled text
        // never streams, so skip the unpaired-marker balancing; mode="static"
        // renders synchronously (see the assistant bubble for why that keeps
        // the virtualizer's measurements sane).
        <MessageResponse
          className="min-w-0 max-w-full overflow-hidden"
          mode="static"
          parseIncompleteMarkdown={false}
        >
          {item.text}
        </MessageResponse>
      )}
      <MessageAttachments files={item.files} hasText={item.text !== ""} />
    </>
  );
}

/** Small "slack · U0123ABC" marker on messages from external chat integrations. */
function MessageViaLabel({ via, className }: { via: AgentUiMessageVia; className?: string }) {
  return (
    <div className={cn("font-mono text-[11px] leading-none", className)}>
      {via.service}
      {via.sender == null ? "" : ` · ${via.sender}`}
    </div>
  );
}

function MessageAttachments({
  files,
  hasText,
}: {
  files: AgentUiMessageItem["files"];
  hasText: boolean;
}) {
  if (files == null || files.length === 0) return null;
  return (
    <div className={cn("flex max-w-full flex-col gap-2", hasText && "mt-1")}>
      {files.map((file) => (
        <MessageAttachment key={file.path} file={file} />
      ))}
    </div>
  );
}

function MessageAttachment({ file }: { file: AgentUiFileAttachment }) {
  if (file.contentType.startsWith("image/")) {
    return (
      <a href={file.url} target="_blank" rel="noreferrer" className="block max-w-full">
        <img
          src={file.url}
          alt={file.filename}
          className="max-h-64 max-w-full rounded-lg border border-border/60 bg-background object-contain"
        />
      </a>
    );
  }

  return (
    <a
      href={file.url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex max-w-full items-center gap-1.5 self-start rounded-full border border-border/60 bg-background/70 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      <PaperclipIcon className="size-3 shrink-0" />
      <span className="min-w-0 truncate text-foreground/80">{file.filename}</span>
      <span className="shrink-0 font-mono">{formatFileSize(file.size)}</span>
    </a>
  );
}

// ---------------------------------------------------------------------------
// Steps: condensed LLM request and code-run rows that open their inspectors
// ---------------------------------------------------------------------------

function AgentActivityStep({
  step,
  onInspectLlmRequest,
  onInspectScriptExecution,
}: {
  step: AgentUiStep;
  onInspectLlmRequest?: (llmRequestOffset: number) => void;
  onInspectScriptExecution?: (executionId: string) => void;
}) {
  const failed = step.kind === "code" ? step.success === false : step.outcome === "failed";
  const inspect =
    step.kind === "llm"
      ? onInspectLlmRequest == null
        ? undefined
        : () => onInspectLlmRequest(step.llmRequestOffset)
      : onInspectScriptExecution == null
        ? undefined
        : () => onInspectScriptExecution(step.executionId);
  return (
    <div className="flex flex-col items-start">
      <Button
        variant="ghost"
        size="xs"
        title={
          step.kind === "llm" ? "Open this LLM request trace" : "Open this script's code and result"
        }
        data-testid={
          step.kind === "llm"
            ? "agent-feed-inspect-llm-request"
            : "agent-feed-inspect-script-execution"
        }
        onClick={inspect}
        className={cn(
          "-ml-2 self-start font-normal",
          failed && "text-destructive hover:text-destructive",
        )}
      >
        {step.kind === "llm" && step.outcome === "cancelled" ? (
          <BanIcon data-icon="inline-start" className="text-destructive" />
        ) : step.kind === "llm" ? (
          <span className="shrink-0 text-[11px] leading-none text-muted-foreground/50">✦</span>
        ) : (
          <CodeIcon data-icon="inline-start" className="text-muted-foreground" />
        )}
        <span className={cn("font-mono text-xs text-foreground/70", failed && "text-destructive")}>
          {stepLabel(step)}
        </span>
        <span className="font-mono text-xs text-muted-foreground/70">{stepMeta(step)}</span>
        <ChevronRightIcon data-icon="inline-end" className="text-muted-foreground/50" />
      </Button>
    </div>
  );
}

function stepLabel(step: AgentUiStep): string {
  if (step.kind === "code") {
    if (step.status === "running") return "Running code";
    return step.success === false ? "Code failed" : "Ran code";
  }
  if (step.cancelReason === "interrupted-by-user-input") return "Stopped for your new message";
  if (step.cancelReason === "expired") return "Request expired";
  if (step.outcome === "cancelled") return "Request cancelled";
  return step.model ?? "LLM request";
}

function stepMeta(step: AgentUiStep): string {
  if (step.kind === "code") {
    const parts = [`Started ${formatClockTime(step.startedAtMs)}`];
    if (step.durationMs != null) parts.push(formatSeconds(step.durationMs));
    return parts.join(" · ");
  }
  const parts: string[] = [];
  if (step.cancelReason != null && step.model != null) parts.push(step.model);
  if (step.inputTokens != null || step.outputTokens != null) {
    parts.push(`${formatTokens(step.inputTokens)} → ${formatTokens(step.outputTokens)} tok`);
  }
  if (step.durationMs != null) parts.push(formatSeconds(step.durationMs));
  if (step.outcome === "failed") parts.push("failed");
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// The live element: accumulated activity followed by the current timed phase.
// ---------------------------------------------------------------------------

/**
 * The virtual list's trailing item whenever work is in flight. Receives the
 * live reduced state on every chunk: finished steps collapse upward into quiet
 * rows while current requests or scripts keep the busy indicator visible.
 */
export function AgentLiveActivity({
  live,
  runtime,
  toggledIds,
  onToggle,
  onInspectLlmRequest,
  onInspectScriptExecution,
}: {
  live: AgentUiActivity;
  runtime: AgentRuntime;
  toggledIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onInspectLlmRequest?: (llmRequestOffset: number) => void;
  onInspectScriptExecution?: (executionId: string) => void;
}) {
  const runningSteps = live.steps.filter((step) => step.status === "running");
  const liveStep = runningSteps.at(-1);
  const doneSteps = live.steps.filter((step) => step.status === "done");
  const doneSummary = summarizeAgentUiActivity(live, doneSteps);
  const working = isAgentUiActivityWorking(live, runtime);
  const activityToggleId = `live-activity:${live.id}`;
  const activityExpanded = toggledIds.has(activityToggleId);
  const toggleActivity = useCallback(
    () => onToggle(activityToggleId),
    [activityToggleId, onToggle],
  );
  const showStepRail =
    activityExpanded &&
    (doneSteps.length > 0 ||
      runningSteps.some((step) => step.kind === "code" || liveStepHasVisibleContent(step)));

  const runtimeDisplayState = deriveAgentDisplayState(runtime);
  const runtimeWorkKind =
    runtimeDisplayState === "running_code"
      ? "code"
      : runtimeDisplayState === "waiting_for_model"
        ? "llm"
        : runtimeDisplayState === "queued"
          ? "queued"
          : null;
  const currentWorkKind = runtimeWorkKind ?? liveStep?.kind ?? null;
  const currentStep =
    currentWorkKind === "code" || currentWorkKind === "llm"
      ? runningSteps.findLast((step) => step.kind === currentWorkKind)
      : liveStep;
  const currentLabel =
    currentWorkKind === "code"
      ? "Running code"
      : currentWorkKind === "llm"
        ? currentStep?.kind === "llm"
          ? liveActivityLabel([currentStep])
          : "Waiting for a response"
        : currentWorkKind === "queued"
          ? "Queued"
          : liveActivityLabel(currentStep == null ? [] : [currentStep]);
  const currentStartedAtMs = currentStep?.startedAtMs ?? live.startedAtMs;
  const inspectCurrentWork =
    currentStep?.kind === "llm"
      ? onInspectLlmRequest == null
        ? undefined
        : () => onInspectLlmRequest(currentStep.llmRequestOffset)
      : currentStep?.kind === "code"
        ? onInspectScriptExecution == null
          ? undefined
          : () => onInspectScriptExecution(currentStep.executionId)
        : undefined;

  if (!working) {
    return (
      <AgentActivityRow
        activity={live}
        expanded={toggledIds.has(live.id)}
        onToggle={onToggle}
        onInspectLlmRequest={onInspectLlmRequest}
        onInspectScriptExecution={onInspectScriptExecution}
      />
    );
  }

  return (
    <div className="flex flex-col py-0.5">
      {doneSteps.length > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={activityExpanded}
          title="Agent activity so far — click to see details"
          onClick={toggleActivity}
          className="-ml-2.5 self-start font-mono text-xs font-normal text-muted-foreground"
          data-testid="agent-live-summary"
        >
          {doneSummary.codeCount > 0 ? (
            <CodeIcon className="size-3 shrink-0 text-muted-foreground/60" aria-hidden="true" />
          ) : (
            <span className="shrink-0 text-[11px] leading-none text-muted-foreground/60">✦</span>
          )}
          <span>
            {formatAgentUiActivitySummary(live, {
              summary: doneSummary,
              interruptedPartialHint: "click to see partial response",
            })}
          </span>
          <ChevronRightIcon
            className={cn(
              "size-2.5 text-muted-foreground/50 transition-transform",
              activityExpanded && "rotate-90",
            )}
            aria-hidden="true"
          />
        </Button>
      ) : null}
      {showStepRail ? (
        <div className="mb-1.5 ml-1 mt-0.5 flex flex-col gap-0.5 border-l-2 border-muted py-1 pl-4">
          {doneSteps.map((step) => (
            <AgentActivityStep
              key={step.id}
              step={step}
              onInspectLlmRequest={onInspectLlmRequest}
              onInspectScriptExecution={onInspectScriptExecution}
            />
          ))}
          {runningSteps.map((step) =>
            step.kind === "code" ? (
              <AgentActivityStep
                key={step.id}
                step={step}
                onInspectScriptExecution={onInspectScriptExecution}
              />
            ) : step === liveStep && liveStepHasVisibleContent(step) ? (
              <LiveStepStream key={step.id} step={step} />
            ) : null,
          )}
        </div>
      ) : null}
      <AgentLiveStatus
        label={currentLabel}
        startedAtMs={currentStartedAtMs}
        deadlineMs={currentStep?.kind === "code" ? currentStep.expiresAtMs : null}
        onInspect={inspectCurrentWork}
      />
    </div>
  );
}

/** The only subtree subscribed to the 100ms clock; grouped rows stay stable. */
function AgentLiveStatus({
  label,
  startedAtMs,
  deadlineMs,
  onInspect,
}: {
  label: string;
  startedAtMs: number | null;
  deadlineMs: number | null;
  onInspect: (() => void) | undefined;
}) {
  const phaseClock = useLivePhaseClock(startedAtMs, deadlineMs, true);
  const phaseLabel = phaseClock.deadlineExceeded ? "Code deadline exceeded" : label;
  const statusWithElapsed = `${phaseLabel}${phaseClock.elapsedLabel == null ? "" : ` ${phaseClock.elapsedLabel}`}`;

  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={onInspect == null}
      onClick={onInspect}
      title={
        phaseClock.deadlineExceeded
          ? "The script has no durable settlement after its absolute deadline"
          : onInspect == null
            ? undefined
            : "Open the current operation's trace"
      }
      className={cn(
        "-ml-2.5 h-7 self-start px-2.5 text-primary disabled:opacity-100",
        phaseClock.deadlineExceeded && "text-destructive",
      )}
      data-testid="agent-live-status"
    >
      {phaseClock.deadlineExceeded ? (
        <CircleAlertIcon className="size-3 shrink-0 text-destructive" />
      ) : (
        <Spinner className="size-3 shrink-0 text-primary" />
      )}
      <span
        className={cn(
          "text-sm font-medium tabular-nums text-primary",
          phaseClock.deadlineExceeded && "text-destructive",
        )}
      >
        {statusWithElapsed}
      </span>
      {onInspect == null ? null : (
        <ChevronRightIcon
          className={cn(
            "size-2.5 text-primary/60",
            phaseClock.deadlineExceeded && "text-destructive/60",
          )}
          aria-hidden="true"
        />
      )}
    </Button>
  );
}

function liveStepHasVisibleContent(step: AgentUiStep) {
  if (step.kind === "code") return step.code !== "";
  return step.thinkingText !== "" || step.responseText !== "";
}

/**
 * Live CLI-style elapsed counter (`0.9s`) for the current agent phase. Ticks
 * every 100ms so reasoning, response waits, and code runs all count upward.
 * A script clock stops at its authoritative absolute deadline and flips to an
 * explicit failure state even if the durable completion is delayed.
 * Clock is a useSyncExternalStore subscription (react-doctor happy path),
 * not a useState+setInterval effect loop.
 */
function useLivePhaseClock(
  startedAtMs: number | null,
  deadlineMs: number | null,
  enabled: boolean,
): { deadlineExceeded: boolean; elapsedLabel: string | null } {
  const nowMs = useTickingNowMs(100, enabled && startedAtMs != null, deadlineMs);
  if (startedAtMs == null) return { deadlineExceeded: false, elapsedLabel: null };
  const deadlineExceeded = deadlineMs != null && nowMs >= deadlineMs;
  return {
    deadlineExceeded,
    elapsedLabel: formatElapsedSeconds(
      (deadlineExceeded && deadlineMs != null ? deadlineMs : nowMs) - startedAtMs,
    ),
  };
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

/** Amber-tinted block the response/code streams into, character by character.
 * Clamped to the same height as settled code and tail-pinned so the newest
 * tokens stay visible: a long codemode turn (minutes, thousands of chunks)
 * otherwise grows to fill the viewport and reads as one never-ending code
 * block. Scrolling up unpins; returning to the bottom re-pins. */
function StreamingCodeBlock({ code }: { code: string }) {
  const preRef = useRef<HTMLPreElement>(null);
  const pinnedRef = useRef(true);
  useLayoutEffect(() => {
    const el = preRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [code]);
  return (
    <pre
      ref={preRef}
      onScroll={(event) => {
        const el = event.currentTarget;
        pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className="max-h-80 overflow-y-auto overflow-x-auto whitespace-pre-wrap break-words rounded-xl bg-amber-50 px-4 py-3 font-mono text-xs leading-relaxed text-foreground dark:bg-amber-950/20"
    >
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
// Formatting (number/time formatters live in ~/lib/feed-format.ts)
// ---------------------------------------------------------------------------

function compactStreamPath(path: string): string {
  if (path.length <= 64) return path;
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= 3) return path;
  return `.../${segments.slice(-3).join("/")}`;
}

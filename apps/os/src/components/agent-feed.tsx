import { memo, useCallback, useLayoutEffect, useRef, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  BanIcon,
  ChevronRightIcon,
  CircleQuestionMarkIcon,
  CodeIcon,
  GitBranchIcon,
  PaperclipIcon,
  PauseIcon,
  PlayIcon,
  ScrollTextIcon,
} from "lucide-react";
import type {
  AgentUiActivity,
  AgentUiCodeStep,
  AgentUiFileAttachment,
  AgentUiItem,
  AgentUiLlmStep,
  AgentUiMessageItem,
  AgentUiMessageVia,
  AgentUiStep,
  AgentUiTokenUsage,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@iterate-com/ui/components/ai-elements/message";
import { Button } from "@iterate-com/ui/components/button";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@iterate-com/ui/components/tooltip";
import { cn } from "@iterate-com/ui/lib/utils";
import {
  formatClockTime,
  formatDateTime,
  formatDateTimeAttribute,
  formatFileSize,
  formatSeconds,
  formatTokens,
} from "~/lib/feed-format.ts";
import { linkOptionsForStreamPath } from "~/lib/stream-routes.ts";

// The clean agent chat rows: user and assistant messages plus archived
// activity rows ("Ran code 2× · 3 requests · 7.4 s"), and the live in-flight
// activity tail. The rows are `agent.*` feed_items written by the browser-feed
// projector; the virtualized list that windows over them lives in
// stream-feed-view.tsx — this file owns only how each item renders.

/**
 * One-line token accounting for the agent, folded from the agent processor's
 * token-usage-reported events: how full the context is (the last request's
 * input+output against its model window — what the next turn starts from)
 * plus lifetime in/out totals with the cached/reasoning breakdowns on hover.
 * Renders nothing until the agent has completed a turn that reported usage.
 */
export function AgentTokenUsageStrip({ tokenUsage }: { tokenUsage: AgentUiTokenUsage }) {
  const last = tokenUsage.lastReport;
  if (last == null) return null;
  const contextTokens = last.inputTokens + last.outputTokens;
  const contextPercent = Math.min(100, Math.round((contextTokens / last.maxContextTokens) * 100));
  const breakdown = [
    `model: ${last.model}`,
    `last request: ${last.inputTokens.toLocaleString()} in / ${last.outputTokens.toLocaleString()} out of ${last.maxContextTokens.toLocaleString()} context`,
    `lifetime input: ${tokenUsage.totalInputTokens.toLocaleString()} (${tokenUsage.totalCachedInputTokens.toLocaleString()} cached)`,
    `lifetime output: ${tokenUsage.totalOutputTokens.toLocaleString()} (${tokenUsage.totalReasoningOutputTokens.toLocaleString()} reasoning)`,
  ].join("\n");
  return (
    <div
      title={breakdown}
      // Sits under the composer pill; the horizontal padding keeps the strip's
      // edges inside the pill's rounded-3xl corner radius.
      className="flex shrink-0 items-center justify-end gap-3 px-4 font-mono text-[11px] text-muted-foreground"
    >
      <span className={contextPercent >= 80 ? "text-destructive" : undefined}>
        context {formatTokens(contextTokens)}/{formatTokens(last.maxContextTokens)} (
        {contextPercent}%)
      </span>
      <span>
        in {formatTokens(tokenUsage.totalInputTokens)}
        {tokenUsage.totalCachedInputTokens > 0
          ? ` (${formatTokens(tokenUsage.totalCachedInputTokens)} cached)`
          : ""}
      </span>
      <span>
        out {formatTokens(tokenUsage.totalOutputTokens)}
        {tokenUsage.totalReasoningOutputTokens > 0
          ? ` (${formatTokens(tokenUsage.totalReasoningOutputTokens)} reasoning)`
          : ""}
      </span>
    </div>
  );
}

// Memoized: the feed re-renders on every 16ms live-streaming tick, and settled
// rows (markdown, highlighted code) must not re-render along with it. Item
// objects keep their identity between ticks — the row map is only rebuilt when
// the underlying SQLite snapshot actually changes.
export const AgentFeedItemRow = memo(function AgentFeedItemRow({
  item,
  toggledIds,
  onToggle,
  onInspectLlmRequest,
  projectSlug,
}: {
  item: AgentUiItem;
  toggledIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  /** Opens the LLM request inspector at this llmRequestOffset (llm steps only). */
  onInspectLlmRequest?: (llmRequestOffset: number) => void;
  projectSlug?: string;
}) {
  if (item.kind === "stream-woken") {
    return <StreamWakeRow item={item} />;
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
        toggledIds={toggledIds}
        onToggle={onToggle}
        onInspectLlmRequest={onInspectLlmRequest}
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
              do a production deployment. All Durable Objects currently crash and do not recover
              cleanly; we will fix that in the future.
            </p>
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="h-px flex-1 bg-purple-500/45" />
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
  toggledIds,
  onToggle,
  onInspectLlmRequest,
}: {
  activity: AgentUiActivity;
  expanded: boolean;
  toggledIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onInspectLlmRequest?: (llmRequestOffset: number) => void;
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
          {activity.steps.map((step) => {
            // Expanding the activity shows what happened directly — code and
            // results are the point of expanding, not a second disclosure.
            // The activity header already says "Ran code 1×", so a lone code
            // step renders its detail bare instead of repeating a "Ran code"
            // header row underneath (multiple code steps keep their headers:
            // the start times tell the runs apart). Steps whose detail would
            // show nothing stay collapsed behind their slim header row.
            if (step.kind === "code" && codeStepCount(activity) === 1) {
              return (
                <div key={step.id} className="flex flex-col gap-2 pb-1 pt-0.5">
                  <CodeStepDetail step={step} />
                </div>
              );
            }
            const defaultExpanded = stepDetailHasContent(step);
            return (
              <AgentActivityStep
                key={step.id}
                step={step}
                expanded={toggledIds.has(step.id) !== defaultExpanded}
                onToggle={onToggle}
                onInspectLlmRequest={onInspectLlmRequest}
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function QueuedMessagesPanel({
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
            <UserMessageBody item={message} />
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

function codeStepCount(activity: AgentUiActivity): number {
  return activity.steps.filter((step) => step.kind === "code").length;
}

function activitySummary(activity: AgentUiActivity): string {
  const codeCount = codeStepCount(activity);
  const requestCount = activity.steps.filter((step) => step.kind === "llm").length;
  const interrupted = activity.steps.some(
    (step) => step.kind === "llm" && step.outcome === "cancelled",
  );
  const interruptedWithPartialResponse = activity.steps.some(
    (step) =>
      step.kind === "llm" &&
      step.outcome === "cancelled" &&
      (step.thinkingText !== "" || step.responseText !== ""),
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
  onInspectLlmRequest,
}: {
  step: AgentUiStep;
  expanded: boolean;
  onToggle: (id: string) => void;
  onInspectLlmRequest?: (llmRequestOffset: number) => void;
}) {
  return (
    <div className="flex flex-col">
      <div className="-ml-2 flex items-center gap-0.5 self-start">
        <Button
          variant="ghost"
          size="xs"
          aria-expanded={expanded}
          onClick={() => onToggle(step.id)}
          className="font-normal"
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
        {step.kind === "llm" && onInspectLlmRequest != null ? (
          <InspectLlmRequestButton
            llmRequestOffset={step.llmRequestOffset}
            onInspectLlmRequest={onInspectLlmRequest}
          />
        ) : null}
      </div>
      {expanded ? (
        <div className="flex flex-col gap-2 pb-2.5 pl-5 pt-0.5">
          {step.kind === "llm" ? <LlmStepDetail step={step} /> : <CodeStepDetail step={step} />}
        </div>
      ) : null}
    </div>
  );
}

/** Opens the LLM request inspector: the exact context this request sent to
 * the model, replayed from the local event mirror (llm-request-inspector-panel). */
function InspectLlmRequestButton({
  llmRequestOffset,
  onInspectLlmRequest,
}: {
  llmRequestOffset: number;
  onInspectLlmRequest: (llmRequestOffset: number) => void;
}) {
  return (
    <Button
      variant="ghost"
      size="xs"
      title="Show the exact context sent to the model"
      data-testid="agent-feed-inspect-llm-request"
      onClick={() => onInspectLlmRequest(llmRequestOffset)}
      className="text-muted-foreground/60 hover:text-foreground"
    >
      <ScrollTextIcon className="size-3" />
    </Button>
  );
}

/**
 * Whether an expanded step detail would actually show something. Steps with
 * empty details default to collapsed so an expanded activity reads as code →
 * results without blank sections (their headers still carry timing/tokens).
 */
function stepDetailHasContent(step: AgentUiStep): boolean {
  if (step.kind === "code") return true;
  return step.thinkingText !== "" || step.errorMessage != null || llmResponseVisible(step);
}

// In code-mode the LLM's response *is* the script that a code step executes
// and renders with its results — showing the fenced-code variant here too
// just duplicates it (the raw event view has it for anyone who wants it).
// It only appears when the request was cancelled or failed, i.e. the code
// likely never ran and this partial response is the only copy (the activity
// summary promises "click to see partial response"). Prose always renders.
function llmResponseVisible(step: AgentUiLlmStep): boolean {
  if (step.responseText === "") return false;
  if (!looksLikeCode(step.responseText)) return true;
  return step.outcome === "cancelled" || step.outcome === "failed";
}

function stepLabel(step: AgentUiStep): string {
  if (step.kind === "code") return step.status === "running" ? "Running code" : "Ran code";
  return step.model ?? "LLM request";
}

function stepMeta(step: AgentUiStep): string {
  if (step.kind === "code") {
    const parts = [`Started ${formatClockTime(step.startedAtMs)}`];
    if (step.durationMs != null) parts.push(formatSeconds(step.durationMs));
    return parts.join(" · ");
  }
  const parts: string[] = [];
  if (step.inputTokens != null || step.outputTokens != null) {
    parts.push(`${formatTokens(step.inputTokens)} → ${formatTokens(step.outputTokens)} tok`);
  }
  if (step.durationMs != null) parts.push(formatSeconds(step.durationMs));
  if (step.outcome === "failed") parts.push("failed");
  return parts.join(" · ");
}

function LlmStepDetail({ step }: { step: AgentUiLlmStep }) {
  const showResponse = llmResponseVisible(step);
  const hasContent = step.thinkingText !== "" || showResponse || step.errorMessage != null;
  return (
    <>
      {step.thinkingText === "" ? null : <ThinkingBlock>{step.thinkingText}</ThinkingBlock>}
      {!showResponse ? null : looksLikeCode(step.responseText) ? (
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
      {step.errorMessage == null ? null : (
        <pre className="overflow-x-auto rounded-xl bg-destructive/5 px-4 py-2.5 font-mono text-xs leading-relaxed text-destructive">
          {step.errorMessage}
        </pre>
      )}
      {/* Token/timing metadata lives in the step's header row; the raw
          summary only fills in when the step has nothing else to show. */}
      {hasContent ? null : (
        <pre className="overflow-x-auto rounded-xl bg-muted/50 px-4 py-3 font-mono text-xs leading-relaxed text-foreground">
          {JSON.stringify(llmStepRawSummary(step), null, 2)}
        </pre>
      )}
    </>
  );
}

function llmStepRawSummary(step: AgentUiLlmStep) {
  return {
    ...(step.model == null ? {} : { model: step.model }),
    usage: { input_tokens: step.inputTokens ?? null, output_tokens: step.outputTokens ?? null },
    ...(step.durationMs == null ? {} : { duration_ms: step.durationMs }),
    status: step.outcome ?? step.status,
    ...(step.errorMessage == null ? {} : { error: step.errorMessage }),
  };
}

function CodeStepDetail({ step }: { step: AgentUiCodeStep }) {
  // No timestamp heading here: the step's header row already says when it
  // started — the detail is the code and what it returned.
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
// The live element: active requests and running code with expandable detail
// ---------------------------------------------------------------------------

/**
 * The virtual list's trailing item whenever work is in flight. Receives the
 * live reduced state on every chunk: finished steps collapse upward into quiet
 * rows while current requests or scripts keep the busy indicator visible.
 */
export function AgentLiveActivity({
  live,
  toggledIds,
  onToggle,
  onInspectLlmRequest,
}: {
  live: AgentUiActivity;
  toggledIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onInspectLlmRequest?: (llmRequestOffset: number) => void;
}) {
  const runningSteps = live.steps.filter((step) => step.status === "running");
  const liveStep = runningSteps.at(-1);
  const doneSteps = live.steps.filter((step) => step.status === "done");
  const working = runningSteps.length > 0;
  const toggleLive = useCallback((id: string) => onToggle(`live:${id}`), [onToggle]);
  const showStepRail =
    doneSteps.length > 0 ||
    runningSteps.some((step) => step.kind === "code" || liveStepHasVisibleContent(step));

  // The in-flight request's context is already committed history (the fold
  // reads offsets ≤ llmRequestOffset), so "what is it chewing on right now"
  // is inspectable mid-turn from the live label row.
  const runningLlmStep = runningSteps
    .filter((step): step is AgentUiLlmStep => step.kind === "llm")
    .at(-1);

  if (!working && activityWasInterrupted(live)) {
    return (
      <AgentActivityRow
        activity={live}
        expanded={toggledIds.has(live.id)}
        toggledIds={toggledIds}
        onToggle={onToggle}
        onInspectLlmRequest={onInspectLlmRequest}
      />
    );
  }

  return (
    <div className="flex flex-col py-0.5">
      {working ? (
        <div className="flex h-7 items-center gap-2 self-start px-0.5">
          <Spinner className="size-3 shrink-0 text-amber-600" />
          <span className="text-sm font-medium text-amber-700 dark:text-amber-500">
            {liveActivityLabel(runningSteps)}
          </span>
          {runningLlmStep != null && onInspectLlmRequest != null ? (
            <InspectLlmRequestButton
              llmRequestOffset={runningLlmStep.llmRequestOffset}
              onInspectLlmRequest={onInspectLlmRequest}
            />
          ) : null}
        </div>
      ) : null}
      {showStepRail ? (
        <div className="mb-1.5 ml-1 mt-0.5 flex flex-col gap-0.5 border-l-2 border-muted py-1 pl-4">
          {/* Steps in the live rail default to collapsed quiet rows — the
              streaming tail below is the focus while work is in flight. Toggle
              keys are namespaced with "live:" so they don't leak into the
              settled activity, where membership means the opposite (collapse
              a default-expanded step); a step expanded while streaming stays
              expanded after settling via the settled default. */}
          {doneSteps.map((step) => (
            <AgentActivityStep
              key={step.id}
              step={step}
              expanded={toggledIds.has(`live:${step.id}`)}
              onToggle={toggleLive}
              onInspectLlmRequest={onInspectLlmRequest}
            />
          ))}
          {runningSteps.map((step) =>
            step.kind === "code" ? (
              <AgentActivityStep
                key={step.id}
                step={step}
                expanded={toggledIds.has(`live:${step.id}`)}
                onToggle={toggleLive}
              />
            ) : step === liveStep && liveStepHasVisibleContent(step) ? (
              <LiveStepStream key={step.id} step={step} />
            ) : null,
          )}
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

function liveActivityLabel(runningSteps: AgentUiStep[]): string {
  const scriptCount = runningSteps.filter((step) => step.kind === "code").length;
  const llmCount = runningSteps.length - scriptCount;
  const parts: string[] = [];
  if (scriptCount > 0) {
    parts.push(`Running ${scriptCount} script${scriptCount === 1 ? "" : "s"}`);
  }
  if (llmCount > 0) {
    parts.push(`Making ${llmCount} LLM request${llmCount === 1 ? "" : "s"}`);
  }
  return parts.join(" · ") || "Working…";
}

/** Code-mode agents stream itx code as their response; chat agents stream prose. */
const CODE_START_PATTERN = /^\s*(async|await|function|const|let|import)\b/;
function looksLikeCode(text: string): boolean {
  return text.includes("```") || CODE_START_PATTERN.test(text);
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
// Formatting (number/time formatters live in ~/lib/feed-format.ts)
// ---------------------------------------------------------------------------

function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2) ?? String(result);
  } catch {
    return String(result);
  }
}

function compactStreamPath(path: string): string {
  if (path.length <= 64) return path;
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= 3) return path;
  return `.../${segments.slice(-3).join("/")}`;
}

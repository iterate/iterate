import { memo, type ReactNode } from "react";
import { decodeMessageMentions } from "@iterate-com/shared/message";
import {
  BanIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleQuestionMarkIcon,
  CodeIcon,
  GitBranchIcon,
  PaperclipIcon,
  FileIcon,
  PauseIcon,
  PlayIcon,
} from "lucide-react";
import {
  formatAgentUiActivitySummary,
  groupActivityRounds,
  formatAgentUiDuration,
  summarizeAgentUiActivity,
  type AgentUiActivity,
  type AgentUiCodeStep,
  type AgentUiFileAttachment,
  type AgentUiItem,
  type AgentUiLlmStep,
  type AgentUiMessageItem,
  type AgentUiMessageVia,
  type AgentUiMentionResolution,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@iterate-com/ui/components/ai-elements/message";
import { Button } from "@iterate-com/ui/components/button";
import { Badge } from "@iterate-com/ui/components/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@iterate-com/ui/components/tooltip";
import { cn } from "@iterate-com/ui/lib/utils";
import {
  formatDateTime,
  formatDateTimeAttribute,
  formatFileSize,
} from "@iterate-com/ui/components/events/feed-format";
import { AgentActivityRounds } from "./agent-activity-rounds.tsx";

// The clean agent chat rows: user and assistant messages plus archived
// activity rows ("Ran code 2× · 3 requests · 7.4 s"). The rows are `agent.*`
// feed_items from server publications; the live in-flight activity tail is
// agent-live-activity.tsx, and the virtualized list that windows over them
// lives in the app (apps/os/src/components/stream-feed-view.tsx) — this file
// owns only how each settled item renders.

// Memoized: the feed re-renders on every 16ms live-streaming tick, and settled
// rows (markdown, highlighted code) must not re-render along with it. Item
// objects keep their identity between ticks — the row map is only rebuilt when
// the underlying SQLite snapshot actually changes. The render props must be
// identity-stable too (memoize them in the app), or the memo is defeated.
export const AgentFeedItemRow = memo(function AgentFeedItemRow({
  item,
  toggledIds,
  onToggle,
  onInspectLlmRequest,
  onInspectScriptExecution,
  renderStreamLink,
  roundResult,
  roundMeta,
}: {
  item: AgentUiItem;
  toggledIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  /** Opens the LLM request inspector at this llmRequestOffset (llm steps only). */
  onInspectLlmRequest?: (llmRequestOffset: number) => void;
  /** Opens the script execution inspector at this execution id (code steps only). */
  onInspectScriptExecution?: (executionId: string) => void;
  /**
   * Wraps a child stream's label in the app's link to that stream path (the
   * OS uses its TanStack `Link` with className "min-w-0 truncate font-mono
   * text-foreground/80 underline-offset-4 hover:text-foreground
   * hover:underline"); absent, the label renders as plain text.
   */
  renderStreamLink?: (path: string, children: ReactNode) => ReactNode;
  /** A round's Result tab body when the app can show the agent's own view of the settlement; see {@link AgentActivityRounds}. */
  roundResult?: (code: AgentUiCodeStep) => ReactNode;
  /** A round's Meta tab body when the app can replay its exact prompt; see {@link AgentActivityRounds}. */
  roundMeta?: (llm: AgentUiLlmStep, code: AgentUiCodeStep) => ReactNode;
}) {
  if (item.kind === "stream-woken") {
    return <StreamWakeRow item={item} />;
  }

  if (item.kind === "processor-revived") {
    return <ProcessorRevivedRow item={item} />;
  }

  if (item.kind === "child-stream-created") {
    return <ChildStreamCreatedRow item={item} renderStreamLink={renderStreamLink} />;
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
        roundResult={roundResult}
        roundMeta={roundMeta}
      />
    );
  }

  return null;
});

/** The "Created child stream …" divider row; the app supplies the link to the child. */
export function ChildStreamCreatedRow({
  item,
  renderStreamLink,
}: {
  item: Extract<AgentUiItem, { kind: "child-stream-created" }>;
  renderStreamLink?: (path: string, children: ReactNode) => ReactNode;
}) {
  const dateTime = formatDateTimeAttribute(item.timestampMs);
  const streamLabel = compactStreamPath(item.childPath);

  return (
    <div
      className="flex items-center gap-2 py-2 text-xs text-muted-foreground"
      data-testid="agent-feed-child-stream-created"
      data-kind="child-stream-created"
    >
      <div className="h-px min-w-8 flex-1 bg-border/70" />
      <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />
      <span className="shrink-0">Created child stream</span>
      {renderStreamLink == null ? (
        <span className="min-w-0 truncate font-mono text-foreground/70">{streamLabel}</span>
      ) : (
        renderStreamLink(item.childPath, streamLabel)
      )}
      <time className="sr-only" dateTime={dateTime}>
        {formatDateTime(item.timestampMs)}
      </time>
      <div className="h-px min-w-8 flex-1 bg-border/70" />
    </div>
  );
}

/** The purple "stream durable object woke" divider row. */
export function StreamWakeRow({ item }: { item: Extract<AgentUiItem, { kind: "stream-woken" }> }) {
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
          {item.count != null && item.count > 1 ? ` (${item.count})` : ""}
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

/** The amber "processor revived" divider row. */
export function ProcessorRevivedRow({
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

/** The "stream paused" / "stream resumed" pill divider row. */
export function StreamPauseRow({
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

/** One settled activity: the quiet stats row and, when expanded, its rounds rail. */
export function AgentActivityRow({
  activity,
  expanded,
  onToggle,
  onInspectLlmRequest,
  onInspectScriptExecution,
  roundResult,
  roundMeta,
}: {
  activity: AgentUiActivity;
  expanded: boolean;
  onToggle: (id: string) => void;
  onInspectLlmRequest?: (llmRequestOffset: number) => void;
  onInspectScriptExecution?: (executionId: string) => void;
  roundResult?: (code: AgentUiCodeStep) => ReactNode;
  roundMeta?: (llm: AgentUiLlmStep, code: AgentUiCodeStep) => ReactNode;
}) {
  const summary = summarizeAgentUiActivity(activity);
  const failed = summary.outcome === "failed";
  // The agent's own latest activity line for this stretch of work
  // ("Factoring the number") — from the status attribute / summary-updated
  // fold stamped onto code steps. Leads the quiet stats so the header says
  // WHAT happened, not just how much.
  const activityLabel = [...activity.steps]
    .reverse()
    .flatMap((step) => (step.kind === "code" && step.activitySummary ? [step.activitySummary] : []))
    .at(0);

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
        {activityLabel == null || summary.outcome !== "clean"
          ? // No agent-authored label (or something went wrong — failures and
            // interruptions keep the full stats line): the quiet counts row.
            `${activityLabel == null ? "" : `${activityLabel} · `}${formatAgentUiActivitySummary(
              activity,
              { summary, interruptedPartialHint: "click to see partial response" },
            )}`
          : // The agent said WHAT it did — that plus the duration is the
            // headline; counts are one expand away.
            [
              activityLabel,
              activity.endedAtMs == null
                ? null
                : formatAgentUiDuration(Math.max(0, activity.endedAtMs - activity.startedAtMs)),
            ]
              .filter((part) => part != null)
              .join(" · ")}
        <ChevronRightIcon
          data-icon="inline-end"
          className={cn("text-muted-foreground/50 transition-transform", expanded && "rotate-90")}
        />
      </Button>
      {expanded ? (
        <div className="mb-1.5 ml-1 mt-0.5 flex flex-col gap-1 border-l-2 border-muted py-1 pl-4">
          {/* Rounds, like mobile's activity card: the llm request's meta moved
              into each round's Meta tab instead of spending a feed row. */}
          <AgentActivityRounds
            rounds={groupActivityRounds(activity.steps)}
            roundResult={roundResult}
            roundMeta={roundMeta}
            onInspectLlmRequest={onInspectLlmRequest}
            onInspectScriptExecution={onInspectScriptExecution}
          />
        </div>
      ) : null}
    </div>
  );
}

/** A user message's body: via label, mention pills or markdown text, attachments. */
export function UserMessageBody({ item }: { item: AgentUiMessageItem }) {
  const decodedMessage =
    item.mentions === undefined ? null : decodeMessageMentions(item.text, item.mentions);
  return (
    <>
      {item.via == null ? null : <MessageViaLabel via={item.via} className="opacity-70" />}
      {item.text === "" ? null : item.via == null ? (
        decodedMessage === null || decodedMessage.ranges.length === 0 ? (
          <div className="whitespace-pre-wrap leading-6">{item.text}</div>
        ) : (
          <div className="whitespace-pre-wrap leading-6">
            {decodedMessage.ranges.flatMap((mention, index) => {
              const previousEnd = decodedMessage.ranges[index - 1]?.to ?? 0;
              const warning = mentionResolutionWarning(
                item.mentionResolutions?.[mention.mention.id],
              );
              return [
                <span key={`text-${mention.from}`}>
                  {decodedMessage.text.slice(previousEnd, mention.from)}
                </span>,
                <Badge
                  key={`${mention.mention.id}-${mention.from}`}
                  variant="outline"
                  className={cn(
                    "mx-0.5 inline-flex max-w-full align-middle font-mono font-normal",
                    warning !== null &&
                      "border-amber-500/50 bg-amber-500/10 text-amber-800 dark:text-amber-300",
                  )}
                  title={warning ?? mention.mention.path}
                  aria-label={warning === null ? undefined : `${mention.display}: ${warning}`}
                  data-mention-type={mention.mention.type}
                  data-mention-resolution={item.mentionResolutions?.[mention.mention.id]?.status}
                >
                  {warning === null ? (
                    <FileIcon className="size-3" aria-hidden="true" />
                  ) : (
                    <CircleAlertIcon className="size-3" aria-hidden="true" />
                  )}
                  <span className="truncate">{mention.display}</span>
                </Badge>,
                ...(index === decodedMessage.ranges.length - 1
                  ? [<span key="text-tail">{decodedMessage.text.slice(mention.to)}</span>]
                  : []),
              ];
            })}
          </div>
        )
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

function mentionResolutionWarning(resolution: AgentUiMentionResolution | undefined): string | null {
  if (resolution === undefined) return null;
  if (resolution.status === "missing") return "File was not found when this message was processed";
  if (resolution.status === "binary") return "Binary file content was not included";
  if (resolution.status === "read-failed") return "File could not be read";
  return resolution.truncated === true ? "Only the beginning of this file was included" : null;
}

/** Small "slack · U0123ABC" marker on messages from external chat integrations. */
export function MessageViaLabel({
  via,
  className,
}: {
  via: AgentUiMessageVia;
  className?: string;
}) {
  return (
    <div className={cn("font-mono text-[11px] leading-none", className)}>
      {via.service}
      {via.sender == null ? "" : ` · ${via.sender}`}
    </div>
  );
}

/** A message's file attachments, stacked below its text. */
export function MessageAttachments({
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

/** One attachment: an inline image, or a filename + size chip for everything else. */
export function MessageAttachment({ file }: { file: AgentUiFileAttachment }) {
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
// Formatting (number/time formatters live in ../events/feed-format.ts)
// ---------------------------------------------------------------------------

/** A stream path shortened to its last three segments once it passes 64 characters. */
export function compactStreamPath(path: string): string {
  if (path.length <= 64) return path;
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= 3) return path;
  return `.../${segments.slice(-3).join("/")}`;
}

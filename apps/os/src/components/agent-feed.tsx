import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  BanIcon,
  ChevronRightIcon,
  CircleQuestionMarkIcon,
  CodeIcon,
  GitBranchIcon,
  PaperclipIcon,
  PauseIcon,
  PlayIcon,
} from "lucide-react";
import type {
  AgentUiActivity,
  AgentUiCodeStep,
  AgentUiFileAttachment,
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@iterate-com/ui/components/tooltip";
import { cn } from "@iterate-com/ui/lib/utils";
import { AGENT_UI_FEED_TABLE } from "~/domains/streams/client-libraries/processors/agent-ui-processor.ts";
import { useStreamQuery } from "~/domains/streams/client-libraries/browser/hooks/use-stream-query.ts";
import type { StreamBrowserDatabase } from "~/domains/streams/client-libraries/browser/stream-browser-db.ts";
import { linkOptionsForStreamPath } from "~/lib/stream-routes.ts";
/** How many rows past the virtualizer's window the tail query prefetches. */
const TAIL_PREFETCH_ROWS = 32;

/**
 * The clean agent chat feed: user and assistant messages plus archived
 * activity rows ("Ran code 2× · 3 requests · 7.4 s").
 *
 * Settled items are `agent_feed_items` rows written by the agent-ui
 * processor; the TanStack virtual list windows over them with reactive
 * SQLite queries. Active LLM/script work is the list's trailing virtual item,
 * rendered straight from the processor's reduced state, so the virtualizer's
 * end anchoring tracks its growth natively.
 *
 * Callers must remount this component when pointing it at a different
 * database (key it by the database identity): the virtualizer's measurement
 * and scroll state are only valid for one stream's history.
 */
export function AgentFeedView({
  database,
  liveState,
  search = "",
  emptyLabel = "No messages yet.",
  isPending = false,
  isInterruptingQueuedMessages = false,
  onInterruptQueuedMessages,
  projectSlug,
}: {
  database: StreamBrowserDatabase;
  liveState: AgentUiState | null;
  search?: string;
  emptyLabel?: string;
  isPending?: boolean;
  isInterruptingQueuedMessages?: boolean;
  onInterruptQueuedMessages?: () => Promise<void> | void;
  projectSlug?: string;
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

  // The live in-flight activity and the queued-messages panel are the list's
  // trailing items, so TanStack Virtual owns ALL tail behavior natively:
  // `followOnAppend` chases appends while the reader is pinned to the end, and
  // end-anchored resize adjustments keep the pin as the live item grows with
  // every streamed chunk. Rendering them outside the list would hide their
  // height from the virtualizer and require hand-rolled scroll chasing.
  const liveCount = live == null ? 0 : 1;
  const queuedCount = queuedUserMessages.length === 0 ? 0 : 1;
  const totalCount = itemCount + liveCount + queuedCount;

  const virtualizer = useVirtualizer({
    count: totalCount,
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

  // Open at the newest content. anchorTo/followOnAppend only act on option
  // UPDATES — when the deduped query registry already knows the count on the
  // first render (e.g. re-keyed remount for a previously-opened stream), there
  // is no 0→N transition for followOnAppend to chase, so set the initial
  // position explicitly. scrollToEnd's reconcile loop absorbs estimated→
  // measured size drift.
  useLayoutEffect(() => {
    virtualizer.scrollToEnd();
    // useVirtualizer returns one stable instance for the component's lifetime,
    // so this runs once on mount; later appends are followOnAppend's job.
  }, [virtualizer]);

  const virtualItems = virtualizer.getVirtualItems();
  const first = virtualItems[0]?.index ?? 0;
  const last = virtualItems.at(-1)?.index ?? -1;
  // The window extends TAIL_PREFETCH_ROWS past the virtualizer's range so rows
  // appended while pinned to the tail are already in this snapshot when the
  // count query grows: the live→settled handoff commits in one frame instead
  // of flashing a skeleton where the new message lands.
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
    query === ""
      ? [first, last + 1 + TAIL_PREFETCH_ROWS]
      : [`%${query}%`, Math.max(0, last + 1 + TAIL_PREFETCH_ROWS - first), first],
  );
  // Retain the last committed rows across range re-queries so already-visible
  // rows don't flash to skeletons while the shifted window's SQL runs. The
  // retained rows are only valid for the search they were fetched under —
  // reusing them across a filter change would briefly show unfiltered rows.
  const lastRowsRef = useRef<{ query: string; rows: Map<number, AgentUiItem> } | null>(null);
  const itemsByIndex = useMemo(() => {
    if (rowsResult.status !== "ok") {
      const retained = lastRowsRef.current;
      return retained?.query === query ? retained.rows : new Map<number, AgentUiItem>();
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

  // Stable identity so the memoized settled rows skip the per-chunk re-renders
  // driven by the live streaming state.
  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 pb-6 pt-5 md:px-6">
        {totalCount === 0 ? (
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
            const index = virtualItem.index;
            const isLiveItem = live != null && index === itemCount;
            const isQueuedItem = index === itemCount + liveCount && queuedCount > 0;
            const item = index < itemCount ? itemsByIndex.get(index) : undefined;
            return (
              <div
                key={virtualItem.key}
                data-index={index}
                ref={virtualizer.measureElement}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${virtualItem.start}px)` }}
              >
                {isLiveItem ? (
                  <AgentLiveActivity
                    live={live}
                    expandedIds={expandedIds}
                    onToggle={toggleExpanded}
                  />
                ) : isQueuedItem ? (
                  <QueuedMessagesPanel
                    messages={queuedUserMessages}
                    isInterrupting={isInterruptingQueuedMessages}
                    onInterrupt={onInterruptQueuedMessages}
                  />
                ) : item == null ? (
                  <div className="my-2 h-10 rounded-xl bg-muted/40" />
                ) : (
                  <AgentFeedItemRow
                    item={item}
                    expandedIds={expandedIds}
                    onToggle={toggleExpanded}
                    projectSlug={projectSlug}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Memoized: the feed re-renders on every 16ms live-streaming tick, and settled
// rows (markdown, highlighted code) must not re-render along with it. Item
// objects keep their identity between ticks — the row map is only rebuilt when
// the underlying SQLite snapshot actually changes.
const AgentFeedItemRow = memo(function AgentFeedItemRow({
  item,
  expandedIds,
  onToggle,
  projectSlug,
}: {
  item: AgentUiItem;
  expandedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
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
          <MessageResponse className="min-w-0 max-w-full overflow-hidden">
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
        expanded={expandedIds.has(item.id)}
        expandedIds={expandedIds}
        onToggle={onToggle}
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
      {item.text === "" ? null : <div className="whitespace-pre-wrap leading-6">{item.text}</div>}
      <MessageAttachments files={item.files} hasText={item.text !== ""} />
    </>
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

function activitySummary(activity: AgentUiActivity): string {
  const codeCount = activity.steps.filter((step) => step.kind === "code").length;
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
  if (step.kind === "code") return step.status === "running" ? "Running code" : "Ran code";
  return step.model ?? step.provider ?? "LLM request";
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
  const startedAtDateTime = formatDateTimeAttribute(step.startedAtMs);

  return (
    <>
      <time
        className="block px-1.5 font-mono text-xs text-muted-foreground"
        dateTime={startedAtDateTime}
      >
        Started {formatDateTime(step.startedAtMs)}
      </time>
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
 * Rendered below the virtual list whenever work is in flight. Receives the
 * live reduced state on every chunk: finished steps collapse upward into quiet
 * rows while current requests or scripts keep the busy indicator visible.
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
  const runningSteps = live.steps.filter((step) => step.status === "running");
  const liveStep = runningSteps.at(-1);
  const doneSteps = live.steps.filter((step) => step.status === "done");
  const working = runningSteps.length > 0;
  const showStepRail =
    doneSteps.length > 0 ||
    runningSteps.some((step) => step.kind === "code" || liveStepHasVisibleContent(step));

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
            {liveActivityLabel(runningSteps)}
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
          {runningSteps.map((step) =>
            step.kind === "code" ? (
              <AgentActivityStep
                key={step.id}
                step={step}
                expanded={expandedIds.has(step.id)}
                onToggle={onToggle}
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

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  const kilobytes = size / 1024;
  if (kilobytes < 1024) return `${kilobytes.toFixed(1).replace(/\.0$/, "")} KB`;
  return `${(kilobytes / 1024).toFixed(1).replace(/\.0$/, "")} MB`;
}

function formatClockTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDateTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}

function formatDateTimeAttribute(timestampMs: number): string | undefined {
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

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

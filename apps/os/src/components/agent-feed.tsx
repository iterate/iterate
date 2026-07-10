import {
  memo,
  useCallback,
  useEffect,
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
  AgentUiMessageVia,
  AgentUiState,
  AgentUiStep,
  AgentUiTokenUsage,
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
/** Cap on rows retained across window shifts (memory bound for long feeds). */
const MAX_RETAINED_ROWS = 2000;

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
/** Agent-ui item kinds hidden in Pretty mode (shown when showDebug is true). */
const DEBUG_KINDS_SQL = `kind NOT IN ('stream-woken')`;

export function AgentFeedView({
  database,
  liveState,
  search = "",
  showDebug = false,
  emptyLabel = "No messages yet.",
  isPending = false,
  isInterruptingQueuedMessages = false,
  onInterruptQueuedMessages,
  projectSlug,
}: {
  database: StreamBrowserDatabase;
  liveState: AgentUiState | null;
  search?: string;
  /** When false (Pretty), hide debug-only rows like stream-woken. */
  showDebug?: boolean;
  emptyLabel?: string;
  isPending?: boolean;
  isInterruptingQueuedMessages?: boolean;
  onInterruptQueuedMessages?: () => Promise<void> | void;
  projectSlug?: string;
}) {
  const query = search.trim().toLowerCase();
  const clauses: string[] = [];
  const params: string[] = [];
  if (!showDebug) clauses.push(DEBUG_KINDS_SQL);
  if (query !== "") {
    clauses.push(`json(data) LIKE ?`);
    params.push(`%${query}%`);
  }
  const whereSql = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
  const countResult = useStreamQuery(
    database,
    `SELECT COUNT(*) AS count FROM ${AGENT_UI_FEED_TABLE}${whereSql}`,
    params,
  );
  const itemCount = Number(countResult.data[0]?.count ?? 0);
  const live = liveState?.live ?? null;
  const queuedUserMessages = liveState?.queuedUserMessages ?? [];
  const scrollRef = useRef<HTMLDivElement>(null);
  // Ids whose disclosure the user flipped away from its default state.
  // Activities and live-rail steps default collapsed (has(id) = expanded);
  // steps inside an expanded settled activity default expanded when their
  // detail has content (has(id) = collapsed).
  const [toggledIds, setToggledIds] = useState<ReadonlySet<string>>(new Set());

  // The live in-flight activity and the queued-messages panel are the list's
  // trailing items, so TanStack Virtual owns ALL tail behavior natively:
  // `followOnAppend` chases appends while the reader is pinned to the end, and
  // end-anchored resize adjustments keep the pin as the live item grows with
  // every streamed chunk. Rendering them outside the list would hide their
  // height from the virtualizer and require hand-rolled scroll chasing.
  const liveCount = live == null ? 0 : 1;
  const queuedCount = queuedUserMessages.length === 0 ? 0 : 1;
  const totalCount = itemCount + liveCount + queuedCount;

  // Settled rows are append-only at dense indices, so the index is a stable
  // key for them. The live activity and queued panel keep their own keys:
  // their index shifts up every time a settled row lands, and keying them by
  // index would hand the (often tall) live block's cached measurement to the
  // new settled row — a visible jump right when a turn settles.
  const hasLive = live != null;
  const getItemKey = useCallback(
    (index: number) => {
      if (index < itemCount) return index;
      return hasLive && index === itemCount ? "live" : "queued";
    },
    [itemCount, hasLive],
  );

  const virtualizer = useVirtualizer({
    count: totalCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 56,
    getItemKey,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 80,
    overscan: 16,
    // Deliberately NOT directDomUpdates: in that mode the virtualizer owns
    // each row's transform and the container height, and this feed's async
    // row loading (SQL windows resolving after the rows render) triggers
    // remeasurement storms the direct-DOM path loses track of — the browser
    // clamps scrollTop against a stale container height and the end anchor
    // strands mid-history. The classic mode below (JSX-owned styles) rides
    // the same anchorTo/followOnAppend machinery and holds the pin.
  });

  const virtualItems = virtualizer.getVirtualItems();
  const first = virtualItems[0]?.index ?? 0;
  const last = virtualItems.at(-1)?.index ?? -1;
  // Dense virtual indices (search and/or Pretty debug filter) use LIMIT/OFFSET;
  // the unfiltered Pretty+debug path can address rows by local_index directly.
  const denseWindow = query !== "" || !showDebug;
  const windowLimit = Math.max(0, last + 1 + TAIL_PREFETCH_ROWS - first);
  // While the feed is opening (initial end-pin below), anchor the row window
  // to the TAIL regardless of the virtualizer's not-yet-scrolled range: the
  // opening jump must land on rows with real measured sizes, or estimate
  // error makes the total shrink under the clamped scroll offset and strands
  // the reader mid-history. Once pinned, the virtualizer's range drives the
  // window again.
  const [initialPinDone, setInitialPinDone] = useState(false);
  const windowStart = initialPinDone ? first : Math.max(0, itemCount - windowLimit);
  const rowClauses: string[] = [];
  const rowParams: Array<string | number> = [];
  if (!showDebug) rowClauses.push(DEBUG_KINDS_SQL);
  if (query !== "") {
    rowClauses.push(`json(data) LIKE ?`);
    rowParams.push(`%${query}%`);
  }
  const rowsResult = useStreamQuery(
    database,
    denseWindow
      ? `SELECT local_index, json(data) AS data FROM ${AGENT_UI_FEED_TABLE}
         ${rowClauses.length === 0 ? "" : `WHERE ${rowClauses.join(" AND ")}`}
         ORDER BY local_index ASC
         LIMIT ? OFFSET ?`
      : `SELECT local_index, json(data) AS data FROM ${AGENT_UI_FEED_TABLE}
         WHERE local_index >= ? AND local_index < ?
         ORDER BY local_index ASC`,
    denseWindow
      ? [...rowParams, windowLimit, windowStart]
      : [windowStart, windowStart + windowLimit],
  );
  // Retain rows across range re-queries by MERGING each resolved window into
  // the previously-loaded rows (bounded below). Replacing the map with just
  // the latest window would forget loaded rows the moment the window shifts;
  // rows scrolled back into view would then re-render as skeletons, and the
  // skeleton's measurement would overwrite the row's real size — with an
  // end-anchored virtualizer those size collapses cascade into the total
  // thrashing and the scroll position stranding mid-history. The retained
  // rows are only valid for the filter they were fetched under — reusing
  // them across a filter change would briefly show unfiltered rows.
  const filterKey = `${showDebug ? "debug" : "pretty"}:${query}`;
  const lastRowsRef = useRef<{
    filterKey: string;
    rows: Map<number, { raw: string; item: AgentUiItem }>;
  } | null>(null);
  const itemsByIndex = useMemo(() => {
    const retained =
      lastRowsRef.current?.filterKey === filterKey
        ? lastRowsRef.current.rows
        : new Map<number, { raw: string; item: AgentUiItem }>();
    if (rowsResult.status !== "ok") return retained;
    const rows = new Map(retained);
    rowsResult.data.forEach((row, position) => {
      const index = denseWindow ? windowStart + position : Number(row.local_index);
      const raw = String(row.data);
      // Identity stability is load-bearing: rows re-parse (new object) ONLY
      // when their JSON changed. Handing memoized rows fresh-but-equal items
      // on every window re-query re-renders their markdown, whose async
      // re-parse collapses the row to empty for a frame — and a burst of
      // rows momentarily measuring ~16px is exactly the kind of size storm
      // that breaks the virtualizer's end anchor.
      if (rows.get(index)?.raw === raw) return;
      try {
        rows.set(index, { raw, item: JSON.parse(raw) as AgentUiItem });
      } catch {
        // Skip unparseable rows; the row stays a skeleton.
      }
    });
    // Keep memory bounded on very long histories: drop the oldest-inserted
    // entries once well past what any viewport plus overscan can show.
    if (rows.size > MAX_RETAINED_ROWS) {
      const excess = rows.size - MAX_RETAINED_ROWS;
      let dropped = 0;
      for (const key of rows.keys()) {
        if (dropped >= excess) break;
        rows.delete(key);
        dropped++;
      }
    }
    lastRowsRef.current = { filterKey, rows };
    return rows;
  }, [rowsResult.data, rowsResult.status, filterKey, windowStart, denseWindow]);

  // Open at the newest content. A single scrollToEnd on mount can't get
  // there: the count and each row window resolve asynchronously, and a jump
  // against estimated sizes lands short. So while the feed is opening,
  // re-pin the end on every data wave, and stop once the pin has stuck (tail
  // row's real data rendered and the reader is still at the end) — from then
  // on TanStack's anchorTo/followOnAppend own the tail natively. A reader
  // who starts scrolling during the load takes over immediately (listeners
  // below).
  useLayoutEffect(() => {
    if (initialPinDone || totalCount === 0) return;
    const tailRowLoaded = itemCount === 0 || itemsByIndex.has(itemCount - 1);
    if (tailRowLoaded && virtualizer.isAtEnd()) {
      setInitialPinDone(true);
      return;
    }
    virtualizer.scrollToEnd();
  }, [initialPinDone, totalCount, itemCount, itemsByIndex, virtualizer]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element == null) return;
    const takeOver = () => setInitialPinDone(true);
    const events = ["wheel", "touchstart", "keydown"] as const;
    for (const name of events) element.addEventListener(name, takeOver, { passive: true });
    return () => {
      for (const name of events) element.removeEventListener(name, takeOver);
    };
  }, []);

  // Stable identity so the memoized settled rows skip the per-chunk re-renders
  // driven by the live streaming state.
  const toggleExpanded = useCallback((id: string) => {
    setToggledIds((previous) => {
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
            const item = index < itemCount ? itemsByIndex.get(index)?.item : undefined;
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
                    toggledIds={toggledIds}
                    onToggle={toggleExpanded}
                  />
                ) : isQueuedItem ? (
                  <QueuedMessagesPanel
                    messages={queuedUserMessages}
                    isInterrupting={isInterruptingQueuedMessages}
                    onInterrupt={onInterruptQueuedMessages}
                  />
                ) : item == null ? (
                  // Not-yet-loaded rows must measure exactly estimateSize
                  // (56px, margins don't count toward offsetHeight): the
                  // initial jump to the end renders these before their SQL
                  // window resolves, and if they measured smaller the total
                  // size would shrink under the scroll offset and break the
                  // end anchor before the real rows arrive.
                  <div className="h-14 py-2">
                    <div className="h-full rounded-xl bg-muted/40" />
                  </div>
                ) : (
                  <AgentFeedItemRow
                    item={item}
                    toggledIds={toggledIds}
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
      className="flex shrink-0 items-center justify-end gap-3 font-mono text-[11px] text-muted-foreground"
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
const AgentFeedItemRow = memo(function AgentFeedItemRow({
  item,
  toggledIds,
  onToggle,
  projectSlug,
}: {
  item: AgentUiItem;
  toggledIds: ReadonlySet<string>;
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
}: {
  activity: AgentUiActivity;
  expanded: boolean;
  toggledIds: ReadonlySet<string>;
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
              />
            );
          })}
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
 * Rendered below the virtual list whenever work is in flight. Receives the
 * live reduced state on every chunk: finished steps collapse upward into quiet
 * rows while current requests or scripts keep the busy indicator visible.
 */
function AgentLiveActivity({
  live,
  toggledIds,
  onToggle,
}: {
  live: AgentUiActivity;
  toggledIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  const runningSteps = live.steps.filter((step) => step.status === "running");
  const liveStep = runningSteps.at(-1);
  const doneSteps = live.steps.filter((step) => step.status === "done");
  const working = runningSteps.length > 0;
  const toggleLive = useCallback((id: string) => onToggle(`live:${id}`), [onToggle]);
  const showStepRail =
    doneSteps.length > 0 ||
    runningSteps.some((step) => step.kind === "code" || liveStepHasVisibleContent(step));

  if (!working && activityWasInterrupted(live)) {
    return (
      <AgentActivityRow
        activity={live}
        expanded={toggledIds.has(live.id)}
        toggledIds={toggledIds}
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

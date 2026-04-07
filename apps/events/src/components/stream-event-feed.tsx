import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangleIcon,
  BotIcon,
  Clock3Icon,
  BookOpenIcon,
  BracesIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleIcon,
  Code2Icon,
  CopyIcon,
  FolderPlusIcon,
  PauseCircleIcon,
  PlayCircleIcon,
  Settings2Icon,
  TerminalSquareIcon,
  XCircleIcon,
} from "lucide-react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@iterate-com/ui/components/ai-elements/conversation";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
  MessageToolbar,
} from "@iterate-com/ui/components/ai-elements/message";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@iterate-com/ui/components/collapsible";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import { Spinner } from "@iterate-com/ui/components/spinner";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@iterate-com/ui/components/sheet";
import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
import { toast } from "@iterate-com/ui/components/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@iterate-com/ui/components/tooltip";
import { cn } from "@iterate-com/ui/lib/utils";
import { StreamErrorAlert } from "~/components/stream-error-alert.tsx";
import { StreamPathLabel } from "~/components/stream-path-label.tsx";
import { StreamToolCard } from "~/components/stream-tool-card.tsx";
import { useCurrentProjectSlug } from "~/hooks/use-current-project-slug.ts";
import { getEventTypePageByType } from "~/lib/event-type-pages.ts";
import { formatElapsedTime } from "~/lib/stream-feed-time.ts";
import { getAdjacentEventOffset, getEventFeedItems } from "~/lib/stream-feed-projection.ts";
import { getRelativeStreamPath } from "~/lib/stream-path-relative.ts";
import { summarizeStreamFeed } from "~/lib/stream-feed-summary.ts";
import { streamPathToSplat } from "~/lib/stream-links.ts";
import { defaultStreamViewSearch } from "~/lib/stream-view-search.ts";
import type {
  CodemodeBlockFeedItem,
  CodemodeResultFeedItem,
  DynamicWorkerConfiguredFeedItem,
  ChildStreamCreatedFeedItem,
  EventFeedItem,
  GroupedEventFeedItem,
  SchedulerControlFeedItem,
  SchedulerExecutionFeedItem,
  StreamErrorOccurredFeedItem,
  StreamFeedItem,
  StreamLifecycleFeedItem,
  StreamMetadataUpdatedFeedItem,
  StreamPausedFeedItem,
  StreamRendererMode,
  StreamResumedFeedItem,
} from "~/lib/stream-feed-types.ts";

export function StreamEventFeed({
  feed,
  displayFeed,
  rendererMode,
  emptyLabel,
  isPending = false,
  openEventOffset,
  onOpenEventOffsetChange,
}: {
  feed: readonly StreamFeedItem[];
  displayFeed: readonly StreamFeedItem[] | null;
  rendererMode: StreamRendererMode;
  emptyLabel: string;
  isPending?: boolean;
  openEventOffset?: number;
  onOpenEventOffsetChange?: (offset?: number) => void;
}) {
  const eventFeedItems = useMemo(() => getEventFeedItems(feed), [feed]);
  const eventElapsedByOffset = useMemo(() => {
    const elapsedByOffset = new Map<number, string>();

    for (const [index, event] of eventFeedItems.entries()) {
      const previousEvent = eventFeedItems[index - 1];

      if (previousEvent == null) {
        continue;
      }

      elapsedByOffset.set(
        event.offset,
        formatElapsedTime(event.timestamp - previousEvent.timestamp),
      );
    }

    return elapsedByOffset;
  }, [eventFeedItems]);
  const rawEvents = eventFeedItems.map((item) => item.raw);
  const feedSummary = useMemo(() => summarizeStreamFeed(feed), [feed]);

  const items = displayFeed ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {rendererMode === "raw" ? (
        <div className="min-h-0 flex-1 overflow-auto p-4 md:p-6">
          {rawEvents.length === 0 ? (
            <ConversationEmptyState
              className="min-h-[240px] rounded-lg border bg-card text-sm text-muted-foreground"
              description={isPending ? "Connecting to the stream." : emptyLabel}
              icon={isPending ? <Spinner className="size-4" /> : undefined}
              title={isPending ? "Loading events" : "No events yet"}
            />
          ) : (
            <SerializedObjectCodeBlock
              data={rawEvents}
              className="min-h-80"
              initialFormat="yaml"
              showToggle
              showCopyButton
            />
          )}
        </div>
      ) : (
        <Conversation className="min-h-0 flex-1" resize="smooth">
          <ConversationContent className="gap-3 p-4 md:p-6">
            {items.length === 0 ? (
              isPending ? (
                <ConversationEmptyState
                  className="min-h-[240px] rounded-lg border bg-card text-sm text-muted-foreground"
                  icon={<Spinner className="size-4" />}
                  title="Loading events"
                  description="Connecting to the stream."
                />
              ) : rendererMode === "pretty" && feed.length > 0 ? (
                <ConversationEmptyState
                  className="min-h-[240px] rounded-lg border bg-card text-sm text-muted-foreground"
                  title="No semantic cards for this stream yet"
                  description={`${feedSummary.rawEvents} raw event${feedSummary.rawEvents === 1 ? "" : "s"} in the log · ${feedSummary.semanticItems} semantic item${feedSummary.semanticItems === 1 ? "" : "s"}. Use Raw + Pretty to see wire rows next to projections, or Raw for a full dump.`}
                />
              ) : (
                <ConversationEmptyState
                  className="min-h-[240px] rounded-lg border bg-card text-sm text-muted-foreground"
                  description={emptyLabel}
                  title="No events yet"
                />
              )
            ) : null}

            {items.map((item, index) => (
              <StreamFeedItemRenderer
                key={getFeedItemKey(item, index)}
                item={item}
                eventElapsedByOffset={eventElapsedByOffset}
                onOpenEventOffsetChange={onOpenEventOffsetChange}
              />
            ))}
          </ConversationContent>
          <ConversationScrollButton className="bottom-3 shadow-sm" />
        </Conversation>
      )}

      <EventInspectorSheet
        events={eventFeedItems}
        openEventOffset={openEventOffset}
        onOpenEventOffsetChange={onOpenEventOffsetChange}
      />
    </div>
  );
}

function StreamFeedItemRenderer({
  item,
  eventElapsedByOffset,
  onOpenEventOffsetChange,
}: {
  item: StreamFeedItem;
  eventElapsedByOffset: ReadonlyMap<number, string>;
  onOpenEventOffsetChange?: (offset?: number) => void;
}) {
  switch (item.kind) {
    case "event":
      return (
        <EventLine
          event={item}
          elapsedLabel={eventElapsedByOffset.get(item.offset)}
          onOpenEventOffsetChange={onOpenEventOffsetChange}
        />
      );
    case "grouped-event":
      return (
        <GroupedEventLine
          group={item}
          elapsedLabel={eventElapsedByOffset.get(item.events[0]?.offset ?? -1)}
          onOpenEventOffsetChange={onOpenEventOffsetChange}
        />
      );
    case "message":
      return <ChatMessageCard item={item} />;
    case "tool":
      return <StreamToolCard item={item} />;
    case "error":
      return <StreamErrorAlert item={item} />;
    case "child-stream-created":
      return <ChildStreamCreatedCard item={item} />;
    case "stream-metadata-updated":
      return <StreamMetadataUpdatedCard item={item} />;
    case "stream-lifecycle":
      return <StreamLifecycleLine item={item} />;
    case "dynamic-worker-configured":
      return <DynamicWorkerConfiguredCard item={item} />;
    case "stream-paused":
      return <StreamPausedCard item={item} />;
    case "stream-resumed":
      return <StreamResumedCard item={item} />;
    case "stream-error-occurred":
      return <StreamErrorOccurredCard item={item} />;
    case "scheduler-control":
      return <SchedulerControlCard item={item} />;
    case "scheduler-execution":
      return <SchedulerExecutionCard item={item} />;
    case "codemode-block":
      return <CodemodeBlockCard item={item} />;
    case "codemode-result":
      return <CodemodeResultCard item={item} />;
    default:
      return null;
  }
}

function ChildStreamCreatedCard({ item }: { item: ChildStreamCreatedFeedItem }) {
  const projectSlug = useCurrentProjectSlug();
  const relativePath = getRelativeStreamPath({
    basePath: item.parentPath,
    targetPath: item.createdPath,
  });

  return (
    <div className="flex w-full min-w-0 items-start gap-3 py-1.5">
      <div className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <FolderPlusIcon className="size-3.5" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
        <span className="shrink-0 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Child stream created
        </span>
        <Link
          to="/streams/$/"
          params={{ _splat: streamPathToSplat(item.createdPath) }}
          search={(previous) => ({
            event: undefined,
            composer: previous.composer ?? defaultStreamViewSearch.composer,
            projectSlug,
            renderer: previous.renderer ?? defaultStreamViewSearch.renderer,
          })}
          className="block min-w-0 max-w-full text-foreground hover:text-primary hover:underline sm:flex-1"
        >
          <StreamPathLabel
            path={item.createdPath}
            label={relativePath}
            className="w-full max-w-full overflow-hidden"
            startChars={28}
            endChars={18}
          />
        </Link>
      </div>
    </div>
  );
}

function ChatMessageCard({ item }: { item: Extract<StreamFeedItem, { kind: "message" }> }) {
  const content = item.content.map((block) => block.text).join("");
  const showStreaming = item.role === "assistant" && item.streamStatus === "streaming";
  const showCopyToolbar = item.role === "assistant" && content.length > 0;

  return (
    <Message from={item.role}>
      <MessageContent>
        <MessageResponse>{content.length > 0 ? content : showStreaming ? "…" : ""}</MessageResponse>
      </MessageContent>
      {showCopyToolbar ? (
        <MessageToolbar className="mt-1.5 w-fit max-w-full justify-start gap-2">
          <MessageActions className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <MessageAction
              tooltip="Copy message text"
              label="Copy message text"
              onClick={() => {
                void navigator.clipboard.writeText(content);
                toast.success("Copied");
              }}
            >
              <CopyIcon className="size-3.5" />
            </MessageAction>
          </MessageActions>
        </MessageToolbar>
      ) : null}
    </Message>
  );
}

function StreamMetadataUpdatedCard({ item }: { item: StreamMetadataUpdatedFeedItem }) {
  return (
    <AssistantArtifact
      eyebrow={<Settings2Icon className="size-3.5" />}
      eyebrowLabel="Metadata updated"
      title={item.path}
      meta={[formatTime(item.timestamp)]}
    >
      <ArtifactSection>
        <SerializedObjectCodeBlock
          data={item.metadata}
          className="min-h-24 max-h-56"
          initialFormat="yaml"
          showToggle
          showCopyButton
        />
      </ArtifactSection>
    </AssistantArtifact>
  );
}

function StreamLifecycleLine({ item }: { item: StreamLifecycleFeedItem }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <div className="h-px flex-1 bg-border" />
      <div className="inline-flex items-center gap-2 rounded-full border bg-background px-3 py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground shadow-sm">
        <CircleIcon className="size-2 fill-current" />
        <span>{item.label}</span>
      </div>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function DynamicWorkerConfiguredCard({ item }: { item: DynamicWorkerConfiguredFeedItem }) {
  const [open, setOpen] = useState(false);
  const previewCode = getSourceCodePreview(item.sourceCode, 10);
  const hasMoreCode = previewCode !== item.sourceCode;
  const gatewaySummary = item.outboundGateway
    ? item.outboundGateway.secretHeaderName
      ? `${item.outboundGateway.entrypoint} · injects ${item.outboundGateway.secretHeaderName}`
      : item.outboundGateway.entrypoint
    : undefined;

  return (
    <AssistantArtifact
      eyebrow={<BotIcon className="size-3.5" />}
      eyebrowLabel="Dynamic worker configured"
      title={item.slug}
      meta={[
        ...(item.compatibilityDate ? [item.compatibilityDate] : []),
        ...(item.compatibilityFlags.length > 0
          ? [
              `${item.compatibilityFlags.length} compatibility flag${item.compatibilityFlags.length === 1 ? "" : "s"}`,
            ]
          : []),
        ...(gatewaySummary ? [gatewaySummary] : []),
        formatTime(item.timestamp),
      ]}
    >
      <ArtifactSection>
        <div className="rounded-md border bg-muted/30 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Processor source
              </div>
              <div className="text-xs text-muted-foreground">
                {hasMoreCode ? "Showing first 10 lines" : "Full source"}
              </div>
            </div>
            {hasMoreCode ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 gap-1.5 px-2 text-xs"
                onClick={() => setOpen((value) => !value)}
              >
                {open ? "Collapse" : "Expand"}
                <ChevronDownIcon
                  className={cn("size-3.5 transition-transform duration-200", open && "rotate-180")}
                />
              </Button>
            ) : null}
          </div>

          <div
            className={cn(
              "grid transition-all duration-300 ease-in-out",
              open || !hasMoreCode ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-100",
            )}
          >
            <div className="overflow-hidden pt-3">
              <SourceCodeBlock
                code={open || !hasMoreCode ? item.sourceCode : previewCode}
                language="typescript"
                className={cn("min-h-32", open ? "max-h-[36rem]" : "max-h-72")}
                showCopyButton
              />
            </div>
          </div>
        </div>
      </ArtifactSection>
    </AssistantArtifact>
  );
}

function StreamPausedCard({ item }: { item: StreamPausedFeedItem }) {
  return (
    <AssistantArtifact
      eyebrow={<PauseCircleIcon className="size-3.5" />}
      eyebrowLabel="Stream paused"
      title={item.reason}
      meta={[formatTime(item.timestamp)]}
      tone="warning"
    />
  );
}

function StreamResumedCard({ item }: { item: StreamResumedFeedItem }) {
  return (
    <AssistantArtifact
      eyebrow={<PlayCircleIcon className="size-3.5" />}
      eyebrowLabel="Stream resumed"
      title={item.reason}
      meta={[formatTime(item.timestamp)]}
      tone="success"
    />
  );
}

function StreamErrorOccurredCard({ item }: { item: StreamErrorOccurredFeedItem }) {
  return (
    <AssistantArtifact
      eyebrow={<AlertTriangleIcon className="size-3.5" />}
      eyebrowLabel="Error occurred"
      title={item.message}
      meta={[formatTime(item.timestamp)]}
      tone="danger"
    />
  );
}

function SchedulerControlCard({ item }: { item: SchedulerControlFeedItem }) {
  const eyebrowLabel =
    item.action === "append-scheduled"
      ? "Append scheduled"
      : item.action === "configured"
        ? "Schedule configured"
        : "Schedule cancelled";
  const title = item.slug;
  const data =
    item.action === "append-scheduled"
      ? { slug: item.slug, schedule: item.schedule, append: item.append }
      : item.action === "configured"
        ? {
            slug: item.slug,
            callback: item.callback,
            schedule: item.schedule,
            nextRunAt: item.nextRunAt,
            payload: tryParseJson(item.payloadJson),
          }
        : { slug: item.slug };

  return (
    <AssistantArtifact
      eyebrow={<Clock3Icon className="size-3.5" />}
      eyebrowLabel={eyebrowLabel}
      title={title}
      meta={buildSchedulerControlMeta(item)}
      tone={item.action === "cancelled" ? "warning" : "default"}
    >
      <ArtifactSection>
        <SerializedObjectCodeBlock
          data={data}
          className="min-h-20 max-h-64"
          initialFormat="yaml"
          showToggle
          showCopyButton
        />
      </ArtifactSection>
    </AssistantArtifact>
  );
}

function SchedulerExecutionCard({ item }: { item: SchedulerExecutionFeedItem }) {
  const isFailure = item.action === "finished" && item.outcome === "failed";
  const isSuccess = item.action === "finished" && item.outcome === "succeeded";

  return (
    <AssistantArtifact
      eyebrow={
        item.action === "started" ? (
          <PlayCircleIcon className="size-3.5" />
        ) : isSuccess ? (
          <CheckCircle2Icon className="size-3.5" />
        ) : (
          <XCircleIcon className="size-3.5" />
        )
      }
      eyebrowLabel={
        item.action === "started"
          ? "Schedule execution started"
          : isFailure
            ? "Schedule execution failed"
            : "Schedule execution finished"
      }
      title={item.slug}
      meta={buildSchedulerExecutionMeta(item)}
      tone={item.action === "started" ? "default" : isFailure ? "danger" : "success"}
    />
  );
}

function CodemodeBlockCard({ item }: { item: CodemodeBlockFeedItem }) {
  return (
    <AssistantArtifact
      eyebrow={<Code2Icon className="size-3.5" />}
      eyebrowLabel="Codemode block"
      title={item.blockId}
      badge={item.requestId}
      meta={[item.language.toUpperCase(), formatTime(item.timestamp)]}
    >
      <ArtifactSection>
        <SourceCodeBlock
          code={item.code}
          language={item.language === "ts" ? "typescript" : "text"}
          className="min-h-40 max-h-[32rem]"
          showCopyButton
        />
      </ArtifactSection>
    </AssistantArtifact>
  );
}

function CodemodeResultCard({ item }: { item: CodemodeResultFeedItem }) {
  const [stdoutOpen, setStdoutOpen] = useState(item.stdout.length > 0);
  const [stderrOpen, setStderrOpen] = useState(item.stderr.length > 0 && !item.success);
  const StatusIcon = item.success ? CheckCircle2Icon : XCircleIcon;
  const statusLabel = item.success ? "Succeeded" : "Failed";

  return (
    <AssistantArtifact
      eyebrow={<TerminalSquareIcon className="size-3.5" />}
      eyebrowLabel="Codemode result"
      title={item.blockId}
      badge={item.requestId}
      meta={[
        `Block #${item.blockCount}`,
        `Exit ${item.exitCode}`,
        formatDuration(item.durationMs),
        formatTime(item.timestamp),
      ]}
      headerExtra={
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
            item.success
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : "border-destructive/30 bg-destructive/10 text-destructive",
          )}
        >
          <StatusIcon className="size-3.5" />
          {statusLabel}
        </span>
      }
      tone={item.success ? "success" : "danger"}
    >
      <ArtifactSection>
        <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <BracesIcon className="size-3.5" />
            <span className="font-medium text-foreground">Artifacts</span>
          </div>
          <div className="mt-2 space-y-1 font-mono">
            <div>{item.codePath}</div>
            <div>{item.outputPath}</div>
          </div>
        </div>
      </ArtifactSection>

      <ArtifactSection>
        <Collapsible open={stdoutOpen} onOpenChange={setStdoutOpen}>
          <CollapsibleTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="h-auto w-full justify-between gap-2 px-2 py-1.5 text-xs font-normal"
              />
            }
          >
            <span>Stdout{item.stdout.length === 0 ? " (empty)" : ""}</span>
            <CircleIcon
              className={`size-3.5 transition-transform ${stdoutOpen ? "fill-current" : ""}`}
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2">
            {item.stdout.length > 0 ? (
              <SourceCodeBlock
                code={item.stdout}
                language="text"
                className="min-h-24 max-h-72"
                showCopyButton
              />
            ) : (
              <p className="text-xs text-muted-foreground">No stdout.</p>
            )}
          </CollapsibleContent>
        </Collapsible>
      </ArtifactSection>

      <ArtifactSection>
        <Collapsible open={stderrOpen} onOpenChange={setStderrOpen}>
          <CollapsibleTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="h-auto w-full justify-between gap-2 px-2 py-1.5 text-xs font-normal"
              />
            }
          >
            <span>Stderr{item.stderr.length === 0 ? " (empty)" : ""}</span>
            <CircleIcon
              className={`size-3.5 transition-transform ${stderrOpen ? "fill-current" : ""}`}
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2">
            {item.stderr.length > 0 ? (
              <SourceCodeBlock
                code={item.stderr}
                language="text"
                className="min-h-24 max-h-72"
                showCopyButton
              />
            ) : (
              <p className="text-xs text-muted-foreground">No stderr.</p>
            )}
          </CollapsibleContent>
        </Collapsible>
      </ArtifactSection>
    </AssistantArtifact>
  );
}

function AssistantArtifact({
  eyebrow,
  eyebrowLabel,
  title,
  meta = [],
  badge,
  headerExtra,
  tone = "default",
  children,
}: {
  eyebrow: ReactNode;
  eyebrowLabel: string;
  title?: ReactNode;
  meta?: string[];
  badge?: string;
  headerExtra?: ReactNode;
  tone?: "default" | "success" | "warning" | "danger";
  children?: ReactNode;
}) {
  const toneClassName =
    tone === "success"
      ? "border-emerald-500/30"
      : tone === "warning"
        ? "border-amber-500/30"
        : tone === "danger"
          ? "border-destructive/30"
          : "border-border";

  return (
    <Message from="assistant" className="max-w-3xl">
      <MessageContent
        className={cn(
          "w-full gap-0 overflow-hidden rounded-xl border bg-card px-0 py-0 shadow-sm",
          toneClassName,
        )}
      >
        <div className="border-b px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {eyebrow}
                <span>{eyebrowLabel}</span>
              </div>
              {title ? (
                <div className="font-mono text-sm font-medium leading-snug">{title}</div>
              ) : null}
              {meta.length > 0 ? (
                <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                  {meta.map((part, index) => (
                    <div key={`${part}-${index}`} className="flex items-center gap-2">
                      {index > 0 ? <span>·</span> : null}
                      <span>{part}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {headerExtra}
              {badge ? (
                <div className="rounded-full border border-border bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {badge}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {children ? <div className="space-y-3 px-4 py-3">{children}</div> : null}
      </MessageContent>
    </Message>
  );
}

function ArtifactSection({ children }: { children: ReactNode }) {
  return <div className="space-y-2">{children}</div>;
}

function getSourceCodePreview(sourceCode: string, lineCount: number) {
  const lines = sourceCode.split("\n");
  if (lines.length <= lineCount) {
    return sourceCode;
  }

  return `${lines.slice(0, lineCount).join("\n")}\n...`;
}

function buildSchedulerControlMeta(item: SchedulerControlFeedItem) {
  const meta = [formatTime(item.timestamp)];

  if (item.schedule != null) {
    meta.unshift(describeSchedule(item.schedule));
  }

  if (item.action === "configured" && item.nextRunAt != null) {
    meta.push(`Next run ${formatTime(item.nextRunAt * 1000)}`);
  }

  return meta;
}

function buildSchedulerExecutionMeta(item: SchedulerExecutionFeedItem) {
  const meta = [formatTime(item.timestamp)];

  if (item.action === "finished") {
    meta.unshift(item.outcome === "failed" ? "Failed" : "Succeeded");
    meta.push(
      item.nextRunAt == null ? "No next run" : `Next run ${formatTime(item.nextRunAt * 1000)}`,
    );
  }

  return meta;
}

function describeSchedule(schedule: NonNullable<SchedulerControlFeedItem["schedule"]>) {
  switch (schedule.kind) {
    case "once-at":
      return `Once at ${schedule.at}`;
    case "once-in":
      return `Once in ${schedule.delaySeconds}s`;
    case "every":
      return `Every ${schedule.intervalSeconds}s`;
    case "cron":
      return `Cron ${schedule.cron}`;
  }
}

function tryParseJson(payloadJson: string | null | undefined) {
  if (payloadJson == null) {
    return null;
  }

  try {
    return JSON.parse(payloadJson);
  } catch {
    return payloadJson;
  }
}

function EventLine({
  event,
  elapsedLabel,
  onOpenEventOffsetChange,
}: {
  event: EventFeedItem;
  elapsedLabel?: string;
  onOpenEventOffsetChange?: (offset?: number) => void;
}) {
  return (
    <RawEventLineButton
      summary={
        <>
          <span className="truncate font-mono">{event.eventType}</span>
          {elapsedLabel ? (
            <>
              <span>·</span>
              <span>{elapsedLabel}</span>
            </>
          ) : null}
          <span>·</span>
          <span>{formatTime(event.timestamp)}</span>
        </>
      }
      hoverDetail={formatAbsoluteDateTimeRange(event.timestamp)}
      onClick={() => onOpenEventOffsetChange?.(event.offset)}
    />
  );
}

function GroupedEventLine({
  group,
  elapsedLabel,
  onOpenEventOffsetChange,
}: {
  group: GroupedEventFeedItem;
  elapsedLabel?: string;
  onOpenEventOffsetChange?: (offset?: number) => void;
}) {
  return (
    <RawEventLineButton
      summary={
        <>
          <span className="truncate font-mono">{group.eventType}</span>
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
            x{group.count}
          </Badge>
          {elapsedLabel ? (
            <>
              <span>·</span>
              <span>{elapsedLabel}</span>
            </>
          ) : null}
          <span>·</span>
          <span>{formatTime(group.firstTimestamp)}</span>
          {group.firstTimestamp !== group.lastTimestamp ? (
            <span className="text-muted-foreground/70">to {formatTime(group.lastTimestamp)}</span>
          ) : null}
        </>
      }
      hoverDetail={formatAbsoluteDateTimeRange(group.firstTimestamp, group.lastTimestamp)}
      onClick={() => onOpenEventOffsetChange?.(group.events[0]?.offset)}
    />
  );
}

function RawEventLineButton({
  summary,
  hoverDetail,
  onClick,
}: {
  summary: ReactNode;
  hoverDetail: string;
  onClick: () => void;
}) {
  return (
    <div className="flex justify-end">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="h-auto max-w-full px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={onClick}
            />
          }
        >
          <span className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
            {summary}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm flex-col items-start gap-1.5">
          <p>{hoverDetail}</p>
          <p>Click to see raw payload</p>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

function EventInspectorSheet({
  events,
  openEventOffset,
  onOpenEventOffsetChange,
}: {
  events: readonly EventFeedItem[];
  openEventOffset?: number;
  onOpenEventOffsetChange?: (offset?: number) => void;
}) {
  const selectedEvent = useMemo(
    () => events.find((event) => event.offset === openEventOffset),
    [events, openEventOffset],
  );
  const previousOffset = useMemo(
    () => getAdjacentEventOffset(events, openEventOffset, "previous"),
    [events, openEventOffset],
  );
  const nextOffset = useMemo(
    () => getAdjacentEventOffset(events, openEventOffset, "next"),
    [events, openEventOffset],
  );
  const previousEvent = useMemo(
    () => events.find((event) => event.offset === previousOffset),
    [events, previousOffset],
  );
  const nextEvent = useMemo(
    () => events.find((event) => event.offset === nextOffset),
    [events, nextOffset],
  );
  const docsHref = selectedEvent
    ? getEventTypePageByType(selectedEvent.eventType)?.href
    : undefined;
  const timeSincePreviousEvent =
    selectedEvent && previousEvent
      ? formatElapsedTime(selectedEvent.timestamp - previousEvent.timestamp)
      : undefined;
  const timeToNextEvent =
    selectedEvent && nextEvent
      ? formatElapsedTime(nextEvent.timestamp - selectedEvent.timestamp)
      : undefined;

  useEffect(() => {
    if (selectedEvent == null) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }

      if (event.key === "ArrowLeft" && previousOffset) {
        event.preventDefault();
        onOpenEventOffsetChange?.(previousOffset);
      }

      if (event.key === "ArrowRight" && nextOffset) {
        event.preventDefault();
        onOpenEventOffsetChange?.(nextOffset);
      }
    };

    // Route search state owns the currently selected event, so keyboard
    // navigation updates `?event=<offset>` instead of mutating local state.
    // TanStack Router docs:
    // https://github.com/tanstack/router/blob/main/docs/router/guide/search-params.md
    // https://github.com/tanstack/router/blob/main/docs/router/how-to/navigate-with-search-params.md
    //
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [nextOffset, onOpenEventOffsetChange, previousOffset, selectedEvent]);

  return (
    <Sheet
      open={selectedEvent != null}
      onOpenChange={(open) => {
        if (!open) {
          onOpenEventOffsetChange?.(undefined);
        }
      }}
    >
      <SheetContent className="w-full gap-0 data-[side=right]:sm:w-[min(96vw,120rem)] data-[side=right]:sm:max-w-[min(96vw,120rem)]">
        <SheetHeader className="space-y-2 border-b px-4 py-3 pr-14">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1 space-y-1">
              <SheetTitle className="truncate font-mono text-sm">
                {docsHref ? (
                  <a
                    href={docsHref}
                    className="inline-flex items-center gap-2 hover:text-primary hover:underline"
                  >
                    <span className="truncate">{selectedEvent?.eventType ?? "Event"}</span>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span className="inline-flex items-center text-muted-foreground hover:text-primary" />
                        }
                      >
                        <BookOpenIcon className="size-3.5" />
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>RTFM</p>
                      </TooltipContent>
                    </Tooltip>
                  </a>
                ) : (
                  (selectedEvent?.eventType ?? "Event")
                )}
              </SheetTitle>
              <SheetDescription>{selectedEvent?.createdAt ?? "No event selected"}</SheetDescription>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!previousOffset}
                onClick={() => onOpenEventOffsetChange?.(previousOffset)}
              >
                <ChevronLeftIcon />
                Prev
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!nextOffset}
                onClick={() => onOpenEventOffsetChange?.(nextOffset)}
              >
                Next
                <ChevronRightIcon />
              </Button>
            </div>
          </div>
          {selectedEvent ? (
            <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span>Event {selectedEvent.offset}</span>
                <span className="text-muted-foreground/70">Use left and right arrow keys.</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-2.5 py-1">
                <span className="text-muted-foreground/70">Since previous</span>
                <span className="font-mono text-foreground">
                  {timeSincePreviousEvent ?? "No previous event"}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-2.5 py-1">
                <span className="text-muted-foreground/70">Until next</span>
                <span className="font-mono text-foreground">
                  {timeToNextEvent ?? "No next event"}
                </span>
              </div>
            </div>
          ) : null}
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-hidden px-4 py-3">
          <div className="pb-2 text-xs text-muted-foreground">Raw event payload</div>
          <SerializedObjectCodeBlock
            data={selectedEvent?.raw ?? null}
            className="h-full min-h-[68vh]"
            initialFormat="yaml"
            showToggle
            showCopyButton
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString();
}

function formatAbsoluteDateTimeRange(startTimestamp: number, endTimestamp = startTimestamp) {
  const formatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: "full",
    timeStyle: "long",
  });

  if (startTimestamp === endTimestamp) {
    return formatter.format(new Date(startTimestamp));
  }

  return `${formatter.format(new Date(startTimestamp))} to ${formatter.format(new Date(endTimestamp))}`;
}

function getFeedItemKey(item: StreamFeedItem, index: number) {
  switch (item.kind) {
    case "event":
      return `event-${item.offset}-${item.eventType}-${index}`;
    case "grouped-event":
      return `group-${item.eventType}-${item.firstTimestamp}-${item.lastTimestamp}-${item.count}`;
    case "message":
      return `message-${item.role}-${item.timestamp}-${index}`;
    case "tool":
      return `tool-${item.toolCallId}-${item.startTimestamp}`;
    case "error":
      return `error-${item.timestamp}-${index}`;
    case "child-stream-created":
      return `child-stream-created-${item.createdPath}-${item.timestamp}-${index}`;
    case "stream-metadata-updated":
      return `stream-metadata-${item.path}-${item.timestamp}-${index}`;
    case "stream-lifecycle":
      return `lifecycle-${item.label}-${item.timestamp}-${index}`;
    case "dynamic-worker-configured":
      return `dynamic-worker-configured-${item.slug}-${item.timestamp}`;
    case "stream-paused":
      return `stream-paused-${item.timestamp}-${index}`;
    case "stream-resumed":
      return `stream-resumed-${item.timestamp}-${index}`;
    case "stream-error-occurred":
      return `stream-error-occurred-${item.timestamp}-${index}`;
    case "codemode-block":
      return `codemode-block-${item.blockId}-${item.timestamp}-${index}`;
    case "codemode-result":
      return `codemode-result-${item.blockId}-${item.blockCount}-${item.timestamp}-${index}`;
    case "scheduler-control":
      return `scheduler-control-${item.action}-${item.slug}-${item.raw.offset}`;
    case "scheduler-execution":
      return `scheduler-execution-${item.action}-${item.slug}-${item.raw.offset}`;
    default:
      return `feed-item-${index}`;
  }
}

function formatDuration(durationMs: number) {
  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }

  return `${(durationMs / 1_000).toFixed(1)}s`;
}

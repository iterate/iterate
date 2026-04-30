import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { Event, EventInput, StreamPath, StreamState } from "@iterate-com/events-contract";
import {
  AlertTriangleIcon,
  BracesIcon,
  CableIcon,
  CheckCircle2Icon,
  CircleIcon,
  Code2Icon,
  CopyIcon,
  FolderPlusIcon,
  SendIcon,
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
import { EventsStreamEventInspectorSheet } from "@iterate-com/ui/components/events/event-inspector-sheet";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
import { toast } from "@iterate-com/ui/components/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@iterate-com/ui/components/tooltip";
import { cn } from "@iterate-com/ui/lib/utils";
import { StreamErrorAlert } from "~/components/stream-error-alert.tsx";
import { CoreEventTypeLabel } from "~/components/event-type.tsx";
import { StreamPathLabel } from "~/components/stream-path-label.tsx";
import { StreamToolCard } from "~/components/stream-tool-card.tsx";
import { getProcessorEventDocByType } from "~/lib/processor-docs.ts";
import { orderEventKeysForYamlDisplay } from "~/lib/order-event-keys-for-yaml-display.ts";
import { formatElapsedTime } from "~/lib/stream-feed-time.ts";
import { getEventFeedItems } from "~/lib/stream-feed-projection.ts";
import { getRelativeStreamPath } from "~/lib/stream-path-relative.ts";
import { summarizeStreamFeed } from "~/lib/stream-feed-summary.ts";
import { streamPathToSplat } from "~/lib/stream-links.ts";
import { defaultStreamViewSearch } from "~/lib/stream-view-search.ts";
import type {
  AgentStatusFeedItem,
  CodemodeBlockFeedItem,
  CodemodeResultFeedItem,
  CustomHtmlRenderErrorFeedItem,
  CustomHtmlRenderedEventFeedItem,
  ChildStreamCreatedFeedItem,
  EventFeedItem,
  ExternalSubscriberConfiguredFeedItem,
  GroupedEventFeedItem,
  StreamErrorOccurredFeedItem,
  StreamFeedItem,
  StreamLifecycleFeedItem,
  StreamMetadataUpdatedFeedItem,
  StreamPausedFeedItem,
  StreamRendererMode,
  StreamResumedFeedItem,
} from "~/lib/stream-feed-types.ts";

type StreamLinkSearch = {
  composer?: string;
  event?: number;
  renderer?: string;
  view?: string;
  [key: string]: unknown;
};

function isLiveStreamFailureStatus(status: string | undefined) {
  if (status == null) return false;
  return status.startsWith("Error:") || status.startsWith("Timed out");
}

export type CustomHtmlRendererApi = {
  streamPath: StreamPath;
  events: readonly Event[];
  append: (event: EventInput) => Promise<Event>;
  getState: () => Promise<StreamState>;
  history: () => Promise<Event[]>;
};

declare global {
  interface Window {
    __iterateEventsRendererApi?: CustomHtmlRendererApi;
  }
}

export function StreamEventFeed({
  feed,
  displayFeed,
  rendererMode,
  emptyLabel,
  isPending = false,
  liveStreamStatus,
  openEventOffset,
  onOpenEventOffsetChange,
  rendererApi,
}: {
  feed: readonly StreamFeedItem[];
  displayFeed: readonly StreamFeedItem[] | null;
  rendererMode: StreamRendererMode;
  emptyLabel: string;
  isPending?: boolean;
  /** From `useLiveStreamEvents` — oRPC connect errors / timeouts, independent of the event log. */
  liveStreamStatus?: string;
  openEventOffset?: number;
  onOpenEventOffsetChange?: (offset?: number) => void;
  rendererApi?: CustomHtmlRendererApi;
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
  const rawEvents = useMemo(
    () => eventFeedItems.map((item) => orderEventKeysForYamlDisplay(item.raw)),
    [eventFeedItems],
  );
  const feedSummary = useMemo(() => summarizeStreamFeed(feed), [feed]);

  const items = displayFeed ?? [];
  const liveStreamFailed = !isPending && isLiveStreamFailureStatus(liveStreamStatus);

  useEffect(() => {
    if (rendererApi == null) {
      window.__iterateEventsRendererApi = undefined;
      return;
    }

    window.__iterateEventsRendererApi = rendererApi;

    return () => {
      if (window.__iterateEventsRendererApi === rendererApi) {
        window.__iterateEventsRendererApi = undefined;
      }
    };
  }, [rendererApi]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {rendererMode === "raw-single-json" ? (
        <div className="min-h-0 flex-1 overflow-hidden p-4 md:p-6">
          {rawEvents.length === 0 ? (
            <ConversationEmptyState
              className="h-full min-h-[240px] rounded-lg border bg-card text-sm text-muted-foreground"
              description={
                isPending
                  ? "Connecting to the stream."
                  : liveStreamFailed
                    ? (liveStreamStatus ?? "")
                    : emptyLabel
              }
              icon={isPending ? <Spinner className="size-4" /> : undefined}
              title={
                isPending
                  ? "Loading events"
                  : liveStreamFailed
                    ? "Could not open live stream"
                    : "No events yet"
              }
            />
          ) : (
            <SerializedObjectCodeBlock
              data={rawEvents}
              className="h-full min-h-80"
              initialFormat="yaml"
              showToggle
              showCopyButton
              scrollToBottom
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
              ) : liveStreamFailed ? (
                <ConversationEmptyState
                  className="min-h-[240px] rounded-lg border border-destructive/30 bg-destructive/5 text-sm text-muted-foreground"
                  title="Could not open live stream"
                  description={liveStreamStatus ?? "Unknown error"}
                />
              ) : rendererMode === "pretty" && feed.length > 0 ? (
                <ConversationEmptyState
                  className="min-h-[240px] rounded-lg border bg-card text-sm text-muted-foreground"
                  title="No semantic cards for this stream yet"
                  description={`${feedSummary.rawEvents} raw event${feedSummary.rawEvents === 1 ? "" : "s"} in the log · ${feedSummary.semanticItems} semantic item${feedSummary.semanticItems === 1 ? "" : "s"}. Use Raw + Pretty to see wire rows next to projections, Raw for every event as its own YAML item, or Raw Single JSON for a full dump.`}
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
                rendererMode={rendererMode}
                eventElapsedByOffset={eventElapsedByOffset}
                onOpenEventOffsetChange={onOpenEventOffsetChange}
              />
            ))}
          </ConversationContent>
          <ConversationScrollButton className="bottom-3 shadow-sm" />
        </Conversation>
      )}

      <EventsStreamEventInspectorSheet
        events={eventFeedItems.map((item) => item.raw)}
        openEventOffset={openEventOffset}
        onOpenEventOffsetChange={onOpenEventOffsetChange}
        getEventTypeHref={(eventType) => getProcessorEventDocByType(eventType)?.href}
      />
    </div>
  );
}

function StreamFeedItemRenderer({
  item,
  rendererMode,
  eventElapsedByOffset,
  onOpenEventOffsetChange,
}: {
  item: StreamFeedItem;
  rendererMode: StreamRendererMode;
  eventElapsedByOffset: ReadonlyMap<number, string>;
  onOpenEventOffsetChange?: (offset?: number) => void;
}) {
  switch (item.kind) {
    case "event":
      return rendererMode === "raw" ? (
        <RawEventCard
          event={item}
          elapsedLabel={eventElapsedByOffset.get(item.offset)}
          onOpenEventOffsetChange={onOpenEventOffsetChange}
        />
      ) : (
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
    case "external-subscriber-configured":
      return <ExternalSubscriberConfiguredCard item={item} />;
    case "custom-html-rendered-event":
      return <CustomHtmlRenderedEventCard item={item} />;
    case "custom-html-render-error":
      return <CustomHtmlRenderErrorCard item={item} />;
    case "stream-lifecycle":
      return <StreamLifecycleLine item={item} />;
    case "stream-paused":
      return <StreamPausedCard item={item} />;
    case "stream-resumed":
      return <StreamResumedCard item={item} />;
    case "stream-error-occurred":
      return <StreamErrorOccurredCard item={item} />;
    case "agent-status":
      return <AgentStatusLine item={item} />;
    case "codemode-block":
      return <CodemodeBlockCard item={item} />;
    case "codemode-result":
      return <CodemodeResultCard item={item} />;
    default:
      return null;
  }
}

function ChildStreamCreatedCard({ item }: { item: ChildStreamCreatedFeedItem }) {
  const relativePath = getRelativeStreamPath({
    basePath: item.parentPath,
    targetPath: item.createdPath,
  });

  return (
    <div className="flex w-full min-w-0 items-start gap-3 py-1.5">
      <div className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <FolderPlusIcon className="size-3.5" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="shrink-0 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Child stream created
        </span>
        <Link
          to="/streams/$/"
          params={{ _splat: streamPathToSplat(item.createdPath) }}
          search={(previous: StreamLinkSearch) => ({
            event: undefined,
            composer: previous.composer ?? defaultStreamViewSearch.composer,
            renderer: previous.renderer ?? defaultStreamViewSearch.renderer,
            view: previous.view ?? defaultStreamViewSearch.view,
          })}
          className="block min-w-0 max-w-full text-foreground hover:text-primary hover:underline"
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
  const isMarkdownMessage = item.content.every((block) => block.type === "markdown");
  const showStreaming = item.role === "assistant" && item.streamStatus === "streaming";
  const showCopyToolbar = item.role === "assistant" && content.length > 0;

  return (
    <Message from={item.role}>
      <MessageContent>
        {isMarkdownMessage ? (
          <MessageResponse className="min-w-0 max-w-full overflow-hidden">
            {content.length > 0 ? content : showStreaming ? "…" : ""}
          </MessageResponse>
        ) : item.role === "user" ? (
          <UserMessageText>{content}</UserMessageText>
        ) : (
          <MessageResponse className="min-w-0 max-w-full overflow-hidden">
            {content.length > 0 ? content : showStreaming ? "…" : ""}
          </MessageResponse>
        )}
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

function UserMessageText({ children }: { children: string }) {
  return (
    <div className="max-h-[40vh] max-w-full overflow-auto whitespace-pre-wrap wrap-break-word leading-6">
      {children}
    </div>
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

function ExternalSubscriberConfiguredCard({
  item,
}: {
  item: ExternalSubscriberConfiguredFeedItem;
}) {
  const isWebhook = item.subscriber.type === "webhook";
  const SubscriberIcon = isWebhook ? SendIcon : CableIcon;
  const title = isWebhook ? "Webhook subscriber configured" : "Websocket subscriber configured";

  return (
    <AssistantArtifact
      eyebrow={<SubscriberIcon className="size-3.5" />}
      eyebrowLabel="Subscription configured"
      title={title}
      badge={item.subscriber.slug}
      meta={[item.subscriber.type, formatTime(item.timestamp)]}
    >
      <ArtifactSection>
        <SerializedObjectCodeBlock
          data={item.subscriber}
          className="min-h-24 max-h-56"
          initialFormat="json"
          showToggle
          showCopyButton
        />
      </ArtifactSection>
    </AssistantArtifact>
  );
}

function CustomHtmlRenderedEventCard({ item }: { item: CustomHtmlRenderedEventFeedItem }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container == null) return;

    const timeoutId = window.setTimeout(() => {
      const scripts = Array.from(container.querySelectorAll("script"));
      for (const script of scripts) {
        const executableScript = document.createElement("script");
        for (const attribute of Array.from(script.attributes)) {
          executableScript.setAttribute(attribute.name, attribute.value);
        }
        executableScript.textContent = script.textContent;
        script.replaceWith(executableScript);
      }
    }, 50);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [item.html]);

  return (
    <div ref={containerRef} className="contents" dangerouslySetInnerHTML={{ __html: item.html }} />
  );
}

function CustomHtmlRenderErrorCard({ item }: { item: CustomHtmlRenderErrorFeedItem }) {
  return (
    <AssistantArtifact
      eyebrow={<AlertTriangleIcon className="size-3.5" />}
      eyebrowLabel="HTML renderer failed"
      title={item.eventType}
      badge={item.slug}
      meta={[formatTime(item.timestamp)]}
      tone="danger"
    >
      <ArtifactSection>
        <p className="text-sm text-muted-foreground">{item.message}</p>
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

function AgentStatusLine({ item }: { item: AgentStatusFeedItem }) {
  const working = item.status === "working";
  const label = working ? "Agent working" : "Agent idle";
  return (
    <div className="flex items-center gap-3 py-2">
      <div className="h-px flex-1 bg-border" />
      <div
        className={cn(
          "inline-flex items-center gap-2 rounded-full border bg-background px-3 py-1 text-[11px] font-medium uppercase tracking-[0.14em] shadow-sm",
          working ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground",
        )}
      >
        <CircleIcon className={`size-2 fill-current ${working ? "animate-pulse" : ""}`} />
        <span>{label}</span>
        <span className="normal-case tracking-normal text-muted-foreground">{item.reason}</span>
      </div>
      <div className="h-px flex-1 bg-border" />
    </div>
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

function CodemodeBlockCard({ item }: { item: CodemodeBlockFeedItem }) {
  const languageLabel = item.language.toUpperCase();
  const sourceLanguage = item.language === "ts" || item.language === "js" ? "typescript" : "text";

  return (
    <AssistantArtifact
      eyebrow={<Code2Icon className="size-3.5" />}
      eyebrowLabel="Codemode block"
      title={item.blockId}
      badge={item.requestId}
      meta={[languageLabel, formatTime(item.timestamp)]}
    >
      <ArtifactSection>
        <SourceCodeBlock
          code={item.code}
          language={sourceLanguage}
          className="min-h-40 max-h-128"
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
  const meta = [
    item.blockCount == null ? null : `Block #${item.blockCount}`,
    item.exitCode == null ? null : `Exit ${item.exitCode}`,
    item.durationMs == null ? null : formatDuration(item.durationMs),
    formatTime(item.timestamp),
  ].filter((value): value is string => value != null);
  const hasArtifacts = item.codePath != null || item.outputPath != null;

  return (
    <AssistantArtifact
      eyebrow={<TerminalSquareIcon className="size-3.5" />}
      eyebrowLabel="Codemode result"
      title={item.blockId}
      badge={item.requestId}
      meta={meta}
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
      {hasArtifacts ? (
        <ArtifactSection>
          <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <BracesIcon className="size-3.5" />
              <span className="font-medium text-foreground">Artifacts</span>
            </div>
            <div className="mt-2 space-y-1 font-mono">
              {item.codePath == null ? null : <div>{item.codePath}</div>}
              {item.outputPath == null ? null : <div>{item.outputPath}</div>}
            </div>
          </div>
        </ArtifactSection>
      ) : null}

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
      summary={renderEventSummary({ event, elapsedLabel })}
      hoverDetail={formatAbsoluteDateTimeRange(event.timestamp)}
      onClick={() => onOpenEventOffsetChange?.(event.offset)}
    />
  );
}

function RawEventCard({
  event,
  elapsedLabel,
  onOpenEventOffsetChange,
}: {
  event: EventFeedItem;
  elapsedLabel?: string;
  onOpenEventOffsetChange?: (offset?: number) => void;
}) {
  return (
    <div className="flex w-full flex-col gap-2">
      <RawEventLineButton
        summary={renderEventSummary({ event, elapsedLabel })}
        hoverDetail={formatAbsoluteDateTimeRange(event.timestamp)}
        onClick={() => onOpenEventOffsetChange?.(event.offset)}
      />
      <Message from="assistant" className="max-w-3xl" data-label="stream-raw-event-card">
        <MessageContent className="w-full">
          <SerializedObjectCodeBlock
            data={orderEventKeysForYamlDisplay(event.raw)}
            className="min-h-28 max-h-128"
            initialFormat="yaml"
            showToggle
            showCopyButton
            showLineNumbers={false}
          />
        </MessageContent>
      </Message>
    </div>
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
          <span className="font-mono">
            {group.events[0]?.offset}
            {group.events[group.events.length - 1]?.offset !== group.events[0]?.offset
              ? `-${group.events[group.events.length - 1]?.offset}`
              : ""}
          </span>
          <span>·</span>
          <CoreEventTypeLabel type={group.eventType} className="truncate" />
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

function renderEventSummary({
  event,
  elapsedLabel,
}: {
  event: EventFeedItem;
  elapsedLabel?: string;
}) {
  return (
    <>
      <span className="font-mono">{event.offset}</span>
      <span>·</span>
      <CoreEventTypeLabel type={event.eventType} className="truncate" />
      {elapsedLabel ? (
        <>
          <span>·</span>
          <span>{elapsedLabel}</span>
        </>
      ) : null}
      <span>·</span>
      <span>{formatTime(event.timestamp)}</span>
    </>
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
      return item.messageId ?? `message-${item.role}-${item.timestamp}-${index}`;
    case "tool":
      return `tool-${item.toolCallId}-${item.startTimestamp}`;
    case "error":
      return `error-${item.timestamp}-${index}`;
    case "child-stream-created":
      return `child-stream-created-${item.createdPath}-${item.timestamp}-${index}`;
    case "stream-metadata-updated":
      return `stream-metadata-${item.path}-${item.timestamp}-${index}`;
    case "external-subscriber-configured":
      return `external-subscriber-${item.subscriber.slug}-${item.timestamp}-${index}`;
    case "custom-html-rendered-event":
      return `custom-html-rendered-${item.slug}-${item.raw.offset}-${index}`;
    case "custom-html-render-error":
      return `custom-html-render-error-${item.slug}-${item.raw.offset}-${index}`;
    case "stream-lifecycle":
      return `lifecycle-${item.label}-${item.timestamp}-${index}`;
    case "stream-paused":
      return `stream-paused-${item.timestamp}-${index}`;
    case "stream-resumed":
      return `stream-resumed-${item.timestamp}-${index}`;
    case "stream-error-occurred":
      return `stream-error-occurred-${item.timestamp}-${index}`;
    case "agent-status":
      return `agent-status-${item.status}-${item.reason}-${item.raw.offset}`;
    case "codemode-block":
      return `codemode-block-${item.blockId}-${item.timestamp}-${index}`;
    case "codemode-result":
      return `codemode-result-${item.blockId}-${item.blockCount}-${item.timestamp}-${index}`;
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

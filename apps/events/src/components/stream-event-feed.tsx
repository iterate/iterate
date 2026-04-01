import { useEffect, useMemo } from "react";
import {
  BookOpenIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  FolderPlusIcon,
  Settings2Icon,
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
} from "@iterate-com/ui/components/ai-elements/message";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import { Identifier } from "@iterate-com/ui/components/identifier";
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
import { StreamErrorAlert } from "~/components/stream-error-alert.tsx";
import { StreamToolCard } from "~/components/stream-tool-card.tsx";
import { getEventTypePageByType } from "~/lib/event-type-pages.ts";
import { getAdjacentEventOffset, getEventFeedItems } from "~/lib/stream-feed-projection.ts";
import { summarizeStreamFeed } from "~/lib/stream-feed-summary.ts";
import type {
  EventFeedItem,
  GroupedEventFeedItem,
  StreamInitializedFeedItem,
  StreamFeedItem,
  StreamMetadataUpdatedFeedItem,
  StreamRendererMode,
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
  openEventOffset?: string;
  onOpenEventOffsetChange?: (offset?: string) => void;
}) {
  const eventFeedItems = useMemo(() => getEventFeedItems(feed), [feed]);
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
  onOpenEventOffsetChange,
}: {
  item: StreamFeedItem;
  onOpenEventOffsetChange?: (offset?: string) => void;
}) {
  switch (item.kind) {
    case "event":
      return <EventLine event={item} onOpenEventOffsetChange={onOpenEventOffsetChange} />;
    case "grouped-event":
      return <GroupedEventLine group={item} onOpenEventOffsetChange={onOpenEventOffsetChange} />;
    case "message":
      return <ChatMessageCard item={item} />;
    case "tool":
      return <StreamToolCard item={item} />;
    case "error":
      return <StreamErrorAlert item={item} />;
    case "stream-initialized":
      return <StreamInitializedCard item={item} />;
    case "stream-metadata-updated":
      return <StreamMetadataUpdatedCard item={item} />;
    default:
      return null;
  }
}

function StreamInitializedCard({ item }: { item: StreamInitializedFeedItem }) {
  return (
    <article className="max-w-md rounded-lg border bg-card p-4 shadow-sm">
      <div className="space-y-2">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <FolderPlusIcon className="size-3.5" />
            <span>Child stream initialized</span>
          </div>
          <p className="font-mono text-sm">{item.createdPath}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>From {item.parentPath}</span>
          <span>·</span>
          <span>{formatTime(item.timestamp)}</span>
        </div>
      </div>
    </article>
  );
}

function ChatMessageCard({ item }: { item: Extract<StreamFeedItem, { kind: "message" }> }) {
  const content = item.content.map((block) => block.text).join("");
  const showStreaming = item.role === "assistant" && item.streamStatus === "streaming";
  const showCopyAction = content.length > 0;

  return (
    <Message from={item.role}>
      <MessageContent className="gap-1.5">
        <div
          className={`mb-1 flex w-full min-w-0 items-start gap-2 ${
            showCopyAction
              ? "justify-between"
              : item.role === "user"
                ? "justify-end"
                : "justify-start"
          }`}
        >
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span>{formatTime(item.timestamp)}</span>
            {showStreaming ? (
              <>
                <span>·</span>
                <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                  <Spinner className="size-3" />
                  Streaming
                </span>
              </>
            ) : null}
          </div>
          {showCopyAction ? (
            <MessageActions className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
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
          ) : null}
        </div>
        <MessageResponse>{content.length > 0 ? content : showStreaming ? "…" : ""}</MessageResponse>
      </MessageContent>
    </Message>
  );
}

function StreamMetadataUpdatedCard({ item }: { item: StreamMetadataUpdatedFeedItem }) {
  return (
    <article className="max-w-md rounded-lg border bg-card p-4 shadow-sm">
      <div className="space-y-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Settings2Icon className="size-3.5" />
            <span>Metadata updated</span>
          </div>
          <p className="font-mono text-xs text-muted-foreground">{item.path}</p>
        </div>

        <pre className="max-h-40 overflow-auto rounded-md bg-muted p-3 text-xs">
          {JSON.stringify(item.metadata, null, 2)}
        </pre>

        <div className="text-xs text-muted-foreground">{formatTime(item.timestamp)}</div>
      </div>
    </article>
  );
}

function EventLine({
  event,
  onOpenEventOffsetChange,
}: {
  event: EventFeedItem;
  onOpenEventOffsetChange?: (offset?: string) => void;
}) {
  return (
    <div className="flex justify-end">
      <Button
        variant="ghost"
        size="sm"
        className="h-auto max-w-full gap-2 px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => onOpenEventOffsetChange?.(event.offset)}
      >
        <span className="truncate font-mono">{event.eventType}</span>
        <span>·</span>
        <span>{formatTime(event.timestamp)}</span>
      </Button>
    </div>
  );
}

function GroupedEventLine({
  group,
  onOpenEventOffsetChange,
}: {
  group: GroupedEventFeedItem;
  onOpenEventOffsetChange?: (offset?: string) => void;
}) {
  return (
    <div className="flex justify-end">
      <Button
        variant="ghost"
        size="sm"
        className="h-auto max-w-full gap-2 px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => onOpenEventOffsetChange?.(group.events[0]?.offset)}
      >
        <span className="truncate font-mono">{group.eventType}</span>
        <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
          x{group.count}
        </Badge>
        <span>·</span>
        <span>{formatTime(group.firstTimestamp)}</span>
        {group.firstTimestamp !== group.lastTimestamp ? (
          <span className="text-muted-foreground/70">to {formatTime(group.lastTimestamp)}</span>
        ) : null}
      </Button>
    </div>
  );
}

function EventInspectorSheet({
  events,
  openEventOffset,
  onOpenEventOffsetChange,
}: {
  events: readonly EventFeedItem[];
  openEventOffset?: string;
  onOpenEventOffsetChange?: (offset?: string) => void;
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
  const docsHref = selectedEvent
    ? getEventTypePageByType(selectedEvent.eventType)?.href
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
        <SheetHeader className="space-y-3 border-b pr-14">
          <div className="min-w-0 space-y-1">
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
          {selectedEvent ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Identifier value={selectedEvent.offset} textClassName="text-xs" />
              <span>Use left and right arrow keys to move between events.</span>
            </div>
          ) : null}
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-hidden p-4">
          <div className="flex items-center justify-between gap-3 pb-3">
            <div className="text-xs text-muted-foreground">Raw event payload</div>
            <div className="flex items-center gap-2">
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
          <SerializedObjectCodeBlock
            data={selectedEvent?.raw ?? null}
            className="h-full min-h-[72vh]"
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
    case "stream-initialized":
      return `stream-initialized-${item.createdPath}-${item.timestamp}-${index}`;
    case "stream-metadata-updated":
      return `stream-metadata-${item.path}-${item.timestamp}-${index}`;
    default:
      return `feed-item-${index}`;
  }
}

import { type ReactNode } from "react";
import { AlertTriangleIcon, BotIcon, CircleIcon, FolderPlusIcon } from "lucide-react";

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@iterate-com/ui/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@iterate-com/ui/components/ai-elements/message";
import { Badge } from "@iterate-com/ui/components/badge";
import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
import { Spinner } from "@iterate-com/ui/components/spinner";
import type {
  EventsStreamChildStreamCreatedFeedItem,
  EventsStreamErrorFeedItem,
  EventsStreamFeedItem,
  EventsStreamGroupedRawEventFeedItem,
  EventsStreamMessageFeedItem,
  EventsStreamMetadataUpdatedFeedItem,
  EventsStreamRawEventFeedItem,
  EventsStreamRawJsonDumpFeedItem,
} from "@iterate-com/ui/components/events/feed-items";
import { cn } from "@iterate-com/ui/lib/utils";

export function EventsStreamFeed({
  feedItems,
  emptyLabel = "No events yet",
  isPending = false,
  errorLabel,
  className,
}: {
  feedItems: readonly EventsStreamFeedItem[];
  emptyLabel?: string;
  isPending?: boolean;
  errorLabel?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex h-full min-h-0 flex-col overflow-hidden", className)}>
      <Conversation className="min-h-0 flex-1" resize="smooth">
        <ConversationContent className="gap-3 p-4 md:p-6">
          {feedItems.length === 0 ? (
            <ConversationEmptyState
              className={cn(
                "min-h-[240px] rounded-lg border bg-card text-sm text-muted-foreground",
                errorLabel != null && "border-destructive/30 bg-destructive/5",
              )}
              icon={isPending ? <Spinner className="size-4" /> : undefined}
              title={
                isPending
                  ? "Loading events"
                  : errorLabel == null
                    ? "No events yet"
                    : "Could not open stream"
              }
              description={isPending ? "Connecting to the stream." : (errorLabel ?? emptyLabel)}
            />
          ) : null}

          {feedItems.map((item) => (
            <EventsStreamFeedItemRenderer key={item.id} item={item} />
          ))}
        </ConversationContent>
        <ConversationScrollButton className="bottom-3 shadow-sm" />
      </Conversation>
    </div>
  );
}

function EventsStreamFeedItemRenderer({ item }: { item: EventsStreamFeedItem }) {
  // This is the renderer registry. Keep it mode-agnostic; modes select
  // processors upstream, and processors can emit any mix of feed item types.
  switch (item.type) {
    case "message":
      return <MessageFeedItemCard item={item} />;
    case "raw-event":
      return <RawEventLine item={item} />;
    case "grouped-raw-event":
      return <GroupedRawEventLine item={item} />;
    case "raw-json-dump":
      return <RawJsonDump item={item} />;
    case "lifecycle":
      return (
        <TimelineLine icon={<CircleIcon className="size-2 fill-current" />} label={item.label} />
      );
    case "child-stream-created":
      return <ChildStreamCreatedCard item={item} />;
    case "metadata-updated":
      return <MetadataUpdatedCard item={item} />;
    case "error":
      return <ErrorEventCard item={item} />;
  }
}

function RawJsonDump({ item }: { item: EventsStreamRawJsonDumpFeedItem }) {
  return (
    <SerializedObjectCodeBlock
      data={item.events}
      className="h-full min-h-80"
      initialFormat="yaml"
      showToggle
      showCopyButton
      scrollToBottom
    />
  );
}

function MessageFeedItemCard({ item }: { item: EventsStreamMessageFeedItem }) {
  return (
    <Message from={item.role}>
      <MessageContent>
        {item.role === "user" ? (
          <div className="max-h-[40vh] max-w-full overflow-auto whitespace-pre-wrap wrap-break-word leading-6">
            {item.text}
          </div>
        ) : (
          <MessageResponse className="min-w-0 max-w-full overflow-hidden">
            {item.text}
          </MessageResponse>
        )}
      </MessageContent>
    </Message>
  );
}

function RawEventLine({ item }: { item: EventsStreamRawEventFeedItem }) {
  return (
    <div className="flex justify-end">
      <div className="flex max-w-full flex-wrap items-center justify-end gap-2 px-2 py-1 text-xs text-muted-foreground">
        <span className="font-mono">{item.offset}</span>
        <span>·</span>
        <span className="truncate font-mono">{item.eventType}</span>
        <span>·</span>
        <span>{formatTime(item.timestamp)}</span>
      </div>
    </div>
  );
}

function GroupedRawEventLine({ item }: { item: EventsStreamGroupedRawEventFeedItem }) {
  const firstOffset = item.events[0]?.offset;
  const lastOffset = item.events[item.events.length - 1]?.offset;

  return (
    <div className="flex justify-end">
      <div className="flex max-w-full flex-wrap items-center justify-end gap-2 px-2 py-1 text-xs text-muted-foreground">
        <span className="font-mono">
          {firstOffset}
          {lastOffset !== firstOffset ? `-${lastOffset}` : ""}
        </span>
        <span>·</span>
        <span className="truncate font-mono">{item.eventType}</span>
        <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
          x{item.count}
        </Badge>
        <span>·</span>
        <span>{formatTime(item.firstTimestamp)}</span>
      </div>
    </div>
  );
}

function ChildStreamCreatedCard({ item }: { item: EventsStreamChildStreamCreatedFeedItem }) {
  return (
    <FeedArtifact
      icon={<FolderPlusIcon className="size-3.5" />}
      eyebrow="Child stream created"
      title={item.childPath}
      meta={[item.parentPath, formatTime(item.timestamp)]}
    />
  );
}

function MetadataUpdatedCard({ item }: { item: EventsStreamMetadataUpdatedFeedItem }) {
  return (
    <FeedArtifact
      icon={<BotIcon className="size-3.5" />}
      eyebrow="Metadata updated"
      title={item.path}
      meta={[formatTime(item.timestamp)]}
    >
      <SerializedObjectCodeBlock
        data={item.metadata}
        className="min-h-24 max-h-56"
        initialFormat="yaml"
        showToggle
        showCopyButton
      />
    </FeedArtifact>
  );
}

function ErrorEventCard({ item }: { item: EventsStreamErrorFeedItem }) {
  return (
    <FeedArtifact
      icon={<AlertTriangleIcon className="size-3.5" />}
      eyebrow="Error occurred"
      title={item.message}
      meta={[formatTime(item.timestamp)]}
      tone="danger"
    />
  );
}

function TimelineLine({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <div className="h-px flex-1 bg-border" />
      <div className="inline-flex items-center gap-2 rounded-full border bg-background px-3 py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground shadow-sm">
        {icon}
        <span>{label}</span>
      </div>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function FeedArtifact({
  icon,
  eyebrow,
  title,
  meta = [],
  tone = "default",
  children,
}: {
  icon: ReactNode;
  eyebrow: string;
  title: ReactNode;
  meta?: string[];
  tone?: "default" | "danger";
  children?: ReactNode;
}) {
  return (
    <Message from="assistant" className="max-w-3xl">
      <MessageContent
        className={cn(
          "w-full gap-0 overflow-hidden rounded-xl border bg-card px-0 py-0 shadow-sm",
          tone === "danger" && "border-destructive/30",
        )}
      >
        <div className="border-b px-4 py-3">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {icon}
              <span>{eyebrow}</span>
            </div>
            <div className="font-mono text-sm font-medium leading-snug">{title}</div>
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
        </div>
        {children ? <div className="px-4 py-3">{children}</div> : null}
      </MessageContent>
    </Message>
  );
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString();
}

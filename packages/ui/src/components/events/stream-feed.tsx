import { type ReactNode } from "react";
import { getCoreEventTypeSlug, type Event } from "@iterate-com/events-contract";
import {
  AlertTriangleIcon,
  BotIcon,
  CheckCircle2Icon,
  CircleIcon,
  Code2Icon,
  FolderPlusIcon,
  SparklesIcon,
  TerminalSquareIcon,
  WrenchIcon,
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
  MessageContent,
  MessageResponse,
} from "@iterate-com/ui/components/ai-elements/message";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import { IterateMark } from "@iterate-com/ui/components/iterate-mark";
import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { EventsStreamEventInspectorSheet } from "@iterate-com/ui/components/events/event-inspector-sheet";
import type {
  EventsStreamActivityElement,
  EventsStreamBuiltInElement,
  EventsStreamChildStreamCreatedElement,
  EventsStreamCodemodeBlockElement,
  EventsStreamCodemodeResultElement,
  EventsStreamCodemodeToolProviderElement,
  EventsStreamComposerSuggestionElement,
  EventsStreamErrorElement,
  EventsStreamGroupedRawEventElement,
  EventsStreamInputAction,
  EventsStreamMessageElement,
  EventsStreamMetadataUpdatedElement,
  EventsStreamRawEventElement,
  EventsStreamRawJsonDumpElement,
  EventsStreamViewState,
} from "@iterate-com/ui/components/events/feed-items";
import { cn } from "@iterate-com/ui/lib/utils";

/**
 * Renders a complete stream view snapshot for browser clients.
 *
 * The reducer owns event interpretation and slot contents. This component only
 * renders the package-owned built-in element types that appear in those slots.
 */
export function EventsStreamView({
  viewState,
  events = collectRawEventsFromElements(viewState.slots.feed),
  openEventOffset,
  onOpenEventOffsetChange,
  getEventTypeHref,
  emptyLabel,
  isPending,
  errorLabel,
  className,
}: {
  viewState: EventsStreamViewState;
  events?: readonly Event[];
  openEventOffset?: number;
  onOpenEventOffsetChange?: (offset?: number) => void;
  getEventTypeHref?: (eventType: string) => string | undefined;
  emptyLabel?: string;
  isPending?: boolean;
  errorLabel?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex h-full min-h-0 flex-col overflow-hidden", className)}>
      <EventsStreamHeader elements={viewState.slots.header} />
      <EventsStreamFeed
        elements={viewState.slots.feed}
        emptyLabel={emptyLabel}
        isPending={isPending}
        errorLabel={errorLabel}
        onOpenEventOffsetChange={onOpenEventOffsetChange}
      />
      <EventsStreamEventInspectorSheet
        events={events}
        openEventOffset={openEventOffset}
        onOpenEventOffsetChange={onOpenEventOffsetChange}
        getEventTypeHref={getEventTypeHref}
      />
    </div>
  );
}

function EventsStreamHeader({ elements }: { elements: readonly EventsStreamBuiltInElement[] }) {
  if (elements.length === 0) {
    return null;
  }

  return (
    <div className="shrink-0 border-b bg-background/95 px-4 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {elements.map((element) => (
          <EventsStreamHeaderElementRenderer key={element.id} element={element} />
        ))}
      </div>
    </div>
  );
}

function EventsStreamHeaderElementRenderer({ element }: { element: EventsStreamBuiltInElement }) {
  switch (element.type) {
    case "activity":
      return <ActivityHeaderElement element={element} />;
    default:
      return <UnknownStreamElement element={element} />;
  }
}

/**
 * Renders elements that belong near the composer.
 *
 * Input-slot elements do not mutate composer state during replay. They expose a
 * serializable action, and the host app decides what to do when the user clicks
 * it.
 */
export function EventsStreamInputSlot({
  elements,
  onAction,
  className,
}: {
  elements: readonly EventsStreamBuiltInElement[];
  onAction: (action: EventsStreamInputAction) => void;
  className?: string;
}) {
  if (elements.length === 0) {
    return null;
  }

  return (
    <div className={cn("space-y-2", className)}>
      {elements.map((element) => (
        <EventsStreamInputElementRenderer key={element.id} element={element} onAction={onAction} />
      ))}
    </div>
  );
}

function EventsStreamInputElementRenderer({
  element,
  onAction,
}: {
  element: EventsStreamBuiltInElement;
  onAction: (action: EventsStreamInputAction) => void;
}) {
  switch (element.type) {
    case "composer-suggestion":
      return <ComposerSuggestionElement element={element} onAction={onAction} />;
    default:
      return <UnknownStreamElement element={element} />;
  }
}

function ComposerSuggestionElement({
  element,
  onAction,
}: {
  element: EventsStreamComposerSuggestionElement;
  onAction: (action: EventsStreamInputAction) => void;
}) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2 text-sm">
      <div className="flex min-w-0 items-start gap-2">
        <SparklesIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 space-y-0.5">
          <p className="truncate font-medium leading-5">{element.props.label}</p>
          <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">
            {element.props.text}
          </p>
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 shrink-0 px-2 text-xs"
        onClick={() => onAction(element.props.action)}
      >
        Use
      </Button>
    </div>
  );
}

/**
 * Renders the feed slot from a reduced stream view state.
 *
 * Raw summary rows, chat messages, lifecycle markers, and dedicated event cards
 * are all the same Rendered Element model; the slot decides where they appear.
 */
export function EventsStreamFeed({
  elements,
  onOpenEventOffsetChange,
  emptyLabel = "No events yet",
  isPending = false,
  errorLabel,
  className,
}: {
  elements: readonly EventsStreamBuiltInElement[];
  onOpenEventOffsetChange?: (offset?: number) => void;
  emptyLabel?: string;
  isPending?: boolean;
  errorLabel?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex h-full min-h-0 flex-col overflow-hidden", className)}>
      <Conversation className="min-h-0 flex-1" resize="smooth">
        <ConversationContent className="gap-2 p-4 md:p-6">
          {elements.length === 0 ? (
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

          {elements.map((element) => (
            <EventsStreamFeedElementRenderer
              key={element.id}
              element={element}
              onOpenEventOffsetChange={onOpenEventOffsetChange}
            />
          ))}
        </ConversationContent>
        <ConversationScrollButton className="bottom-3 shadow-sm" />
      </Conversation>
    </div>
  );
}

function EventsStreamFeedElementRenderer({
  element,
  onOpenEventOffsetChange,
}: {
  element: EventsStreamBuiltInElement;
  onOpenEventOffsetChange?: (offset?: number) => void;
}) {
  /*
   * This is the renderer registry. Keep it mode-agnostic: modes select
   * processors upstream, and processors emit Rendered Elements into slots.
   */
  switch (element.type) {
    case "message":
      return <MessageFeedItemCard element={element} />;
    case "raw-event":
      return <RawEventLine element={element} onOpenEventOffsetChange={onOpenEventOffsetChange} />;
    case "grouped-raw-event":
      return (
        <GroupedRawEventLine element={element} onOpenEventOffsetChange={onOpenEventOffsetChange} />
      );
    case "raw-json-dump":
      return <RawJsonDump element={element} />;
    case "lifecycle":
      return (
        <TimelineLine
          icon={<CircleIcon className="size-2 fill-current" />}
          label={element.props.label}
        />
      );
    case "child-stream-created":
      return <ChildStreamCreatedCard element={element} />;
    case "metadata-updated":
      return <MetadataUpdatedCard element={element} />;
    case "error":
      return <ErrorEventCard element={element} />;
    case "codemode-block":
      return <CodemodeBlockCard element={element} />;
    case "codemode-result":
      return <CodemodeResultCard element={element} />;
    case "codemode-tool-provider":
      return <CodemodeToolProviderCard element={element} />;
    default:
      return <UnknownStreamElement element={element} />;
  }
}

function ActivityHeaderElement({ element }: { element: EventsStreamActivityElement }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2 rounded-md border bg-muted/40 px-2 py-1">
      <CircleIcon className="size-2 shrink-0 animate-pulse fill-current text-amber-600" />
      <span className="font-medium text-foreground">{element.props.label}</span>
      {element.props.detail ? <span className="truncate">{element.props.detail}</span> : null}
    </span>
  );
}

function RawJsonDump({ element }: { element: EventsStreamRawJsonDumpElement }) {
  return (
    <SerializedObjectCodeBlock
      data={element.props.events}
      className="h-full min-h-80"
      initialFormat="yaml"
      showToggle
      showCopyButton
      scrollToBottom
    />
  );
}

function MessageFeedItemCard({ element }: { element: EventsStreamMessageElement }) {
  return (
    <Message from={element.props.role}>
      <MessageContent>
        {element.props.role === "user" ? (
          <div className="max-h-[40vh] max-w-full overflow-auto whitespace-pre-wrap wrap-break-word leading-6">
            {element.props.text}
          </div>
        ) : (
          <MessageResponse className="min-w-0 max-w-full overflow-hidden">
            {element.props.text}
          </MessageResponse>
        )}
      </MessageContent>
    </Message>
  );
}

function RawEventLine({
  element,
  onOpenEventOffsetChange,
}: {
  element: EventsStreamRawEventElement;
  onOpenEventOffsetChange?: (offset?: number) => void;
}) {
  return (
    <div className="flex justify-end">
      <button
        type="button"
        className="flex min-w-0 max-w-full items-center justify-end gap-2 rounded-md px-1 py-0.5 text-[11px] text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        onClick={() => onOpenEventOffsetChange?.(element.props.offset)}
      >
        <span className="shrink-0 font-mono tabular-nums">{element.props.offset}</span>
        <span className="shrink-0">·</span>
        <CoreEventTypeLabel type={element.props.eventType} className="min-w-0 truncate" />
        <span className="shrink-0">·</span>
        <span className="shrink-0 tabular-nums">{formatTime(element.props.timestamp)}</span>
      </button>
    </div>
  );
}

function GroupedRawEventLine({
  element,
  onOpenEventOffsetChange,
}: {
  element: EventsStreamGroupedRawEventElement;
  onOpenEventOffsetChange?: (offset?: number) => void;
}) {
  const firstOffset = element.props.events[0]?.props.offset;
  const lastOffset = element.props.events[element.props.events.length - 1]?.props.offset;

  return (
    <div className="flex justify-end">
      <button
        type="button"
        className="flex min-w-0 max-w-full items-center justify-end gap-2 rounded-md px-1 py-0.5 text-[11px] text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        onClick={() => onOpenEventOffsetChange?.(firstOffset)}
      >
        <span className="shrink-0 font-mono tabular-nums">
          {firstOffset}
          {lastOffset !== firstOffset ? `-${lastOffset}` : ""}
        </span>
        <span className="shrink-0">·</span>
        <CoreEventTypeLabel type={element.props.eventType} className="min-w-0 truncate" />
        <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px]">
          x{element.props.count}
        </Badge>
        <span className="shrink-0">·</span>
        <span className="shrink-0 tabular-nums">{formatTime(element.props.firstTimestamp)}</span>
      </button>
    </div>
  );
}

function CoreEventTypeLabel({ type, className }: { type: string; className?: string }) {
  const slug = getCoreEventTypeSlug(type);

  if (slug == null) {
    return <span className={cn("font-mono", className)}>{type}</span>;
  }

  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1 font-mono", className)}>
      <IterateMark aria-hidden />
      <span className="truncate">{`core/${slug}`}</span>
    </span>
  );
}

function ChildStreamCreatedCard({ element }: { element: EventsStreamChildStreamCreatedElement }) {
  return (
    <FeedEventCard
      icon={<FolderPlusIcon className="size-3.5" />}
      eyebrow="Child stream created"
      title={element.props.childPath}
      meta={[element.props.parentPath, formatTime(element.props.timestamp)]}
    />
  );
}

function MetadataUpdatedCard({ element }: { element: EventsStreamMetadataUpdatedElement }) {
  return (
    <FeedEventCard
      icon={<BotIcon className="size-3.5" />}
      eyebrow="Metadata updated"
      title={element.props.path}
      meta={[formatTime(element.props.timestamp)]}
    >
      <SerializedObjectCodeBlock
        data={element.props.metadata}
        className="min-h-24 max-h-56"
        initialFormat="yaml"
        showToggle
        showCopyButton
      />
    </FeedEventCard>
  );
}

function ErrorEventCard({ element }: { element: EventsStreamErrorElement }) {
  return (
    <FeedEventCard
      icon={<AlertTriangleIcon className="size-3.5" />}
      eyebrow="Error occurred"
      title={element.props.message}
      meta={[formatTime(element.props.timestamp)]}
      tone="danger"
    />
  );
}

function CodemodeBlockCard({ element }: { element: EventsStreamCodemodeBlockElement }) {
  return (
    <FeedEventCard
      icon={<Code2Icon className="size-3.5" />}
      eyebrow="Codemode block"
      title="JavaScript"
      meta={[formatTime(element.props.timestamp)]}
    >
      <SourceCodeBlock
        code={element.props.script}
        language="typescript"
        className="min-h-40 max-h-128"
        showCopyButton
      />
    </FeedEventCard>
  );
}

function CodemodeResultCard({ element }: { element: EventsStreamCodemodeResultElement }) {
  const StatusIcon = element.props.success ? CheckCircle2Icon : XCircleIcon;

  return (
    <FeedEventCard
      icon={<TerminalSquareIcon className="size-3.5" />}
      eyebrow="Codemode result"
      title={
        <span className="inline-flex min-w-0 items-center gap-2">
          <StatusIcon
            className={cn(
              "size-4 shrink-0",
              element.props.success ? "text-emerald-600" : "text-destructive",
            )}
          />
          <span>{element.props.success ? "Succeeded" : "Failed"}</span>
        </span>
      }
      meta={[formatDuration(element.props.durationMs), formatTime(element.props.timestamp)]}
      tone={element.props.success ? "default" : "danger"}
    >
      <div className="space-y-3">
        <SerializedObjectCodeBlock
          data={element.props.result}
          className="min-h-24 max-h-72"
          initialFormat="yaml"
          showToggle
          showCopyButton
        />
        {element.props.error == null ? null : (
          <SourceCodeBlock
            code={element.props.error}
            language="text"
            className="min-h-20 max-h-48"
            showCopyButton
          />
        )}
        {element.props.logs.length === 0 ? null : (
          <SourceCodeBlock
            code={element.props.logs.join("\n")}
            language="text"
            className="min-h-20 max-h-56"
            showCopyButton
          />
        )}
      </div>
    </FeedEventCard>
  );
}

function CodemodeToolProviderCard({
  element,
}: {
  element: EventsStreamCodemodeToolProviderElement;
}) {
  return (
    <FeedEventCard
      icon={<WrenchIcon className="size-3.5" />}
      eyebrow="Codemode tool provider"
      title={element.props.slug}
      meta={[
        element.props.operation,
        element.props.hasTypesCallable ? "types available" : "no types callable",
        formatTime(element.props.timestamp),
      ]}
    />
  );
}

function UnknownStreamElement({ element }: { element: EventsStreamBuiltInElement }) {
  return (
    <div className="rounded-md border border-dashed bg-muted/30 px-3 py-2 font-mono text-xs text-muted-foreground">
      Unknown stream element: {element.type}
    </div>
  );
}

function TimelineLine({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <div className="h-px flex-1 bg-border" />
      <div className="inline-flex items-center gap-2 rounded-full border bg-background px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm">
        {icon}
        <span>{label}</span>
      </div>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

/**
 * Shared card chrome for explicit event renderers.
 *
 * This is only a React helper, not a catch-all Rendered Element type. New event
 * families should add a named element type before they use this chrome.
 */
function FeedEventCard({
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
          "w-full gap-0 overflow-hidden rounded-lg border bg-card px-0 py-0 shadow-sm",
          tone === "danger" && "border-destructive/30",
        )}
      >
        <div className="border-b px-4 py-3">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
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

function formatDuration(durationMs: number) {
  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }

  const seconds = Math.round(durationMs / 100) / 10;
  return `${seconds.toFixed(1).replace(/\.0$/, "")}s`;
}

function collectRawEventsFromElements(elements: readonly EventsStreamBuiltInElement[]): Event[] {
  const rawEvents = new Map<number, Event>();

  for (const element of elements) {
    if (element.type === "raw-event") {
      rawEvents.set(element.props.raw.offset, element.props.raw);
      continue;
    }

    if (element.type === "grouped-raw-event") {
      for (const event of element.props.events) {
        rawEvents.set(event.props.raw.offset, event.props.raw);
      }
      continue;
    }

    if (element.type === "raw-json-dump") {
      for (const event of element.props.events) {
        rawEvents.set(event.offset, event);
      }
    }
  }

  return [...rawEvents.values()].sort((a, b) => a.offset - b.offset);
}

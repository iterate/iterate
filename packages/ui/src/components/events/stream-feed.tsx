import { type ReactNode } from "react";
import { getCoreEventTypeSlug, type Event, type StreamPath } from "@iterate-com/events-contract";
import {
  AlertTriangleIcon,
  BotIcon,
  CheckCircle2Icon,
  CircleIcon,
  Code2Icon,
  FolderPlusIcon,
  SparklesIcon,
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
  EventsStreamComposerSuggestionElement,
  EventsStreamErrorElement,
  EventsStreamEventCounterElement,
  EventsStreamGroupedRawEventElement,
  EventsStreamInputAction,
  EventsStreamMessageElement,
  EventsStreamMetadataUpdatedElement,
  EventsStreamRawEventElement,
  EventsStreamRawJsonDumpElement,
  EventsStreamViewState,
} from "@iterate-com/ui/components/events/feed-items";
import {
  EventsStreamLayout,
  EventsStreamLayoutHeader,
  EventsStreamLayoutMain,
} from "@iterate-com/ui/components/events/stream-layout";
import { EventsStreamPathLabel } from "@iterate-com/ui/components/events/stream-path-label";
import { cn } from "@iterate-com/ui/lib/utils";

export type EventsStreamPathLinkRenderer = (args: {
  path: StreamPath;
  children: ReactNode;
  className?: string;
}) => ReactNode;

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
  renderStreamPathLink,
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
  renderStreamPathLink?: EventsStreamPathLinkRenderer;
  emptyLabel?: string;
  isPending?: boolean;
  errorLabel?: string;
  className?: string;
}) {
  return (
    <EventsStreamLayout className={className}>
      {viewState.slots.header.length === 0 ? null : (
        <EventsStreamLayoutHeader>
          <EventsStreamHeader elements={viewState.slots.header} />
        </EventsStreamLayoutHeader>
      )}
      <EventsStreamLayoutMain>
        <EventsStreamFeed
          elements={viewState.slots.feed}
          emptyLabel={emptyLabel}
          isPending={isPending}
          errorLabel={errorLabel}
          onOpenEventOffsetChange={onOpenEventOffsetChange}
          renderStreamPathLink={renderStreamPathLink}
        />
      </EventsStreamLayoutMain>
      <EventsStreamEventInspectorSheet
        events={events}
        openEventOffset={openEventOffset}
        onOpenEventOffsetChange={onOpenEventOffsetChange}
        getEventTypeHref={getEventTypeHref}
      />
    </EventsStreamLayout>
  );
}

/**
 * Renders header-slot elements from reduced stream state.
 */
export function EventsStreamHeader({
  elements,
}: {
  elements: readonly EventsStreamBuiltInElement[];
}) {
  if (elements.length === 0) {
    return null;
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
      {elements.map((element) => (
        <EventsStreamHeaderElementRenderer key={element.id} element={element} />
      ))}
    </div>
  );
}

function EventsStreamHeaderElementRenderer({ element }: { element: EventsStreamBuiltInElement }) {
  switch (element.type) {
    case "event-counter":
      return <EventCounterHeaderElement element={element} />;
    case "activity":
      return <ActivityHeaderElement element={element} />;
    default:
      return <UnknownStreamElement element={element} />;
  }
}

function EventCounterHeaderElement({ element }: { element: EventsStreamEventCounterElement }) {
  return (
    <Badge
      variant="outline"
      className="px-1.5 font-mono text-[10px] font-normal tabular-nums text-muted-foreground"
      aria-label={`${element.props.count} event${element.props.count === 1 ? "" : "s"} in stream`}
    >
      {element.props.count} {element.props.count === 1 ? "event" : "events"}
    </Badge>
  );
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
  renderStreamPathLink,
  emptyLabel = "No events yet",
  isPending = false,
  errorLabel,
  className,
}: {
  elements: readonly EventsStreamBuiltInElement[];
  onOpenEventOffsetChange?: (offset?: number) => void;
  renderStreamPathLink?: EventsStreamPathLinkRenderer;
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
              renderStreamPathLink={renderStreamPathLink}
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
  renderStreamPathLink,
}: {
  element: EventsStreamBuiltInElement;
  onOpenEventOffsetChange?: (offset?: number) => void;
  renderStreamPathLink?: EventsStreamPathLinkRenderer;
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
      return (
        <ChildStreamCreatedLine element={element} renderStreamPathLink={renderStreamPathLink} />
      );
    case "metadata-updated":
      return <MetadataUpdatedBlock element={element} />;
    case "error":
      return <ErrorEventLine element={element} />;
    case "codemode-block":
      return <CodemodeBlockBlock element={element} />;
    case "codemode-result":
      return <CodemodeResultBlock element={element} />;
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
  if (element.props.format === "markdown") {
    return (
      <Message from={element.props.role}>
        <MessageContent>
          <MessageResponse className="min-w-0 max-w-full overflow-hidden">
            {element.props.text}
          </MessageResponse>
        </MessageContent>
      </Message>
    );
  }

  return (
    <Message from={element.props.role}>
      <MessageContent>
        <div className="max-h-[40vh] max-w-full overflow-auto whitespace-pre-wrap wrap-break-word leading-6">
          {element.props.text}
        </div>
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

function ChildStreamCreatedLine({
  element,
  renderStreamPathLink,
}: {
  element: EventsStreamChildStreamCreatedElement;
  renderStreamPathLink?: EventsStreamPathLinkRenderer;
}) {
  const label = getRelativeStreamPath({
    basePath: element.props.parentPath,
    targetPath: element.props.childPath,
  });
  const pathLabel = (
    <EventsStreamPathLabel
      path={element.props.childPath}
      label={label}
      className="w-full max-w-full overflow-hidden"
      startChars={28}
      endChars={18}
    />
  );
  const value =
    renderStreamPathLink == null
      ? pathLabel
      : renderStreamPathLink({
          path: element.props.childPath,
          className:
            "inline-flex min-w-0 max-w-full text-foreground hover:text-primary hover:underline",
          children: pathLabel,
        });

  return (
    <FeedEvent
      icon={<FolderPlusIcon className="size-3.5" />}
      label="Child stream created"
      value={value}
    />
  );
}

function MetadataUpdatedBlock({ element }: { element: EventsStreamMetadataUpdatedElement }) {
  return (
    <FeedEvent
      icon={<BotIcon className="size-3.5" />}
      label="Metadata updated"
      value={element.props.path}
    >
      <SerializedObjectCodeBlock
        data={element.props.metadata}
        className="min-h-24 max-h-56"
        initialFormat="yaml"
        showToggle
        showCopyButton
      />
    </FeedEvent>
  );
}

function ErrorEventLine({ element }: { element: EventsStreamErrorElement }) {
  return (
    <FeedEvent
      icon={<AlertTriangleIcon className="size-3.5" />}
      label="Error"
      value={element.props.message}
      tone="danger"
    />
  );
}

function CodemodeBlockBlock({ element }: { element: EventsStreamCodemodeBlockElement }) {
  return (
    <FeedEvent icon={<Code2Icon className="size-3.5" />} label="Codemode block">
      <SourceCodeBlock
        code={element.props.script}
        language="typescript"
        className="min-h-40 max-h-128"
        showCopyButton
      />
    </FeedEvent>
  );
}

function CodemodeResultBlock({ element }: { element: EventsStreamCodemodeResultElement }) {
  const StatusIcon = element.props.success ? CheckCircle2Icon : XCircleIcon;

  return (
    <FeedEvent
      icon={<TerminalSquareIcon className="size-3.5" />}
      label="Codemode result"
      value={
        <span className="inline-flex min-w-0 items-center gap-2">
          <StatusIcon
            className={cn(
              "size-4 shrink-0",
              element.props.success ? "text-emerald-600" : "text-destructive",
            )}
          />
          <span>{element.props.success ? "Succeeded" : "Failed"}</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">{formatDuration(element.props.durationMs)}</span>
        </span>
      }
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
    </FeedEvent>
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
 * Compact chrome for explicit event renderers.
 *
 * Semantic event rows should stay lighter than raw payload inspection. The
 * inspector owns timestamps and full event metadata; these rows show the useful
 * domain fact and only add payload UI when the event actually carries payload.
 */
function FeedEvent({
  icon,
  label,
  value,
  detail,
  tone = "default",
  children,
}: {
  icon: ReactNode;
  label: string;
  value?: ReactNode;
  detail?: ReactNode;
  tone?: "default" | "danger";
  children?: ReactNode;
}) {
  return (
    <Message from="assistant" className="max-w-3xl">
      <MessageContent
        className={cn(
          "w-full gap-2 rounded-none border-0 bg-transparent px-0 py-0",
          tone === "danger" && "text-destructive",
        )}
      >
        <div
          className={cn(
            "flex min-w-0 items-center gap-2 py-1 text-xs text-muted-foreground",
            tone === "danger" && "text-destructive",
          )}
        >
          <span className="shrink-0">{icon}</span>
          <span className="shrink-0 font-medium">
            {label}
            {value == null && detail == null ? "" : ":"}
          </span>
          {value == null ? null : (
            <span className="min-w-0 truncate font-mono text-foreground">{value}</span>
          )}
          {detail == null ? null : (
            <>
              <span className="shrink-0 text-muted-foreground/70">·</span>
              <span className="min-w-0 truncate text-muted-foreground">{detail}</span>
            </>
          )}
        </div>
        {children == null ? null : <div className="min-w-0">{children}</div>}
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

function getRelativeStreamPath({
  basePath,
  targetPath,
}: {
  basePath: StreamPath;
  targetPath: StreamPath;
}) {
  if (basePath === "/") {
    return `.${targetPath}`;
  }

  const childPrefix = `${basePath}/`;
  if (targetPath.startsWith(childPrefix)) {
    return `.${targetPath.slice(basePath.length)}`;
  }

  return targetPath;
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

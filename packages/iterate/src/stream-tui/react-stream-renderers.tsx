/** @jsxImportSource @opentui/react */
import type { StreamPath } from "@iterate-com/shared/streams/types";
import { StyledText, TextAttributes, bg, fg, type ScrollBoxRenderable } from "@opentui/core";
import type {
  EventsStreamBuiltInElement,
  EventsStreamCodemodeBlockElement,
  EventsStreamCodemodeResultElement,
  EventsStreamErrorElement,
  EventsStreamGroupedRawEventElement,
  EventsStreamLlmRequestBoundaryElement,
  EventsStreamMessageElement,
  EventsStreamMetadataUpdatedElement,
  EventsStreamPromptContextElement,
  EventsStreamRawEventSummary,
  EventsStreamSystemPromptElement,
  EventsStreamViewState,
} from "@iterate-com/ui/components/events/feed-items";
import { useTerminalDimensions } from "@opentui/react";
import { Fragment, useEffect, useRef, type ReactNode } from "react";
import { stringify as stringifyYaml } from "yaml";
import type { StreamTuiView } from "./navigation-state.ts";
import {
  formatElapsedTime,
  formatTime,
  getElapsedByOffset,
  orderEventKeysForYamlDisplay,
  rightAlign,
  wrapLine,
} from "./feed-formatting.ts";
import { getRawEventSummariesForTui, type TuiSlashSuggestion } from "./react-stream-view-model.ts";
import type { StreamTreeRow } from "./stream-tree.ts";

const TUI_COLORS = {
  bg: "#0b0f14",
  surface: "#27272a",
  surfaceDark: "#111827",
  surfaceCard: "#0f172a",
  surfaceMuted: "#27272a",
  selected: "#1f2937",
  border: "#3f3f46",
  accent: "#22c55e",
  accentDim: "#16a34a",
  warning: "#facc15",
  text: "#e5e7eb",
  textSecondary: "#9ca3af",
  textBody: "#d1d5db",
  textMuted: "#6b7280",
  textDim: "#71717a",
  textSubdued: "#94a3b8",
  agent: "#a78bfa",
  danger: "#ef4444",
} as const;

export function TuiEventsStreamView(props: {
  streamPath: StreamPath;
  viewState: EventsStreamViewState;
  modeLabel: string;
  status: string;
  appendStatus: string;
  pulseOn: boolean;
  focusedRegion: "header" | "feed" | "composer";
  activeView: StreamTuiView;
  detailEventOffset?: number;
  selectedOffset?: number;
  streamRows: readonly StreamTreeRow[];
  streamSearchOpen: boolean;
  streamSearchQuery: string;
  composerValue: string;
  composerRevision: number;
  composerPlaceholder: string;
  slashSuggestions: readonly TuiSlashSuggestion[];
  selectedSlashCommandPath?: string;
  commandDocs: readonly string[];
  onComposerInput: (value: string) => void;
  onComposerSubmit: (value: string) => void;
}): ReactNode {
  const { width } = useTerminalDimensions();
  // Full terminal width minus scrollbox borders and content padding, with one
  // extra right gutter so right-aligned feed rows do not touch the scrollbar.
  const contentWidth = Math.max(20, width - 5);
  const rawSummaries = getRawSummaries(props.viewState.slots.feed);
  const detailEvent =
    props.detailEventOffset == null
      ? undefined
      : rawSummaries.find((summary) => summary.offset === props.detailEventOffset);

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={TUI_COLORS.bg}>
      <TuiEventsStreamHeader
        streamPath={props.streamPath}
        viewState={props.viewState}
        modeLabel={props.modeLabel}
        status={props.status}
        appendStatus={props.appendStatus}
        pulseOn={props.pulseOn}
        focused={props.focusedRegion === "header"}
        activeView={props.activeView}
        detailEventOffset={props.detailEventOffset}
      />
      <TuiEventsStreamFeed
        viewState={props.viewState}
        activeView={props.activeView}
        detailEvent={detailEvent}
        selectedOffset={props.selectedOffset}
        streamRows={props.streamRows}
        streamSearchOpen={props.streamSearchOpen}
        streamSearchQuery={props.streamSearchQuery}
        focused={props.focusedRegion === "feed"}
        contentWidth={contentWidth}
      />
      <TuiSlashPanel
        suggestions={props.slashSuggestions}
        selectedPath={props.selectedSlashCommandPath}
        commandDocs={props.commandDocs}
      />
      <TuiComposer
        value={props.composerValue}
        revision={props.composerRevision}
        placeholder={props.composerPlaceholder}
        focused={props.focusedRegion === "composer"}
        onInput={props.onComposerInput}
        onSubmit={props.onComposerSubmit}
      />
    </box>
  );
}

function TuiEventsStreamHeader(props: {
  streamPath: StreamPath;
  viewState: EventsStreamViewState;
  modeLabel: string;
  status: string;
  appendStatus: string;
  pulseOn: boolean;
  focused: boolean;
  activeView: StreamTuiView;
  detailEventOffset?: number;
}) {
  const eventCount = countRawEvents(props.viewState.slots.feed);
  const title =
    props.detailEventOffset == null
      ? props.activeView === "streams"
        ? "Streams"
        : props.activeView === "state"
          ? "State"
          : props.streamPath
      : `Event ${props.detailEventOffset}`;
  const statusColor =
    props.status === "streaming"
      ? props.pulseOn
        ? TUI_COLORS.accent
        : TUI_COLORS.accentDim
      : TUI_COLORS.warning;
  const parts = [
    props.modeLabel,
    `${eventCount} event${eventCount === 1 ? "" : "s"}`,
    `${props.viewState.slots.feed.length} item${props.viewState.slots.feed.length === 1 ? "" : "s"}`,
    props.status === "streaming" ? "" : props.status,
    props.appendStatus,
  ].filter(Boolean);

  return (
    <box
      width="100%"
      height={3}
      border
      borderStyle="single"
      borderColor={props.focused ? TUI_COLORS.accent : TUI_COLORS.border}
      focusedBorderColor={TUI_COLORS.accent}
      backgroundColor={TUI_COLORS.surface}
      flexDirection="row"
      paddingLeft={1}
      paddingRight={1}
      gap={1}
      focused={props.focused}
    >
      <text width={6} content={getBrandMarkText()} />
      <text flexGrow={1} fg={TUI_COLORS.text} content={title} />
      <text fg={TUI_COLORS.textSecondary} content={parts.join(" · ")} />
      <text width={2} fg={statusColor}>
        ●
      </text>
    </box>
  );
}

function TuiEventsStreamFeed(props: {
  viewState: EventsStreamViewState;
  activeView: StreamTuiView;
  detailEvent?: EventsStreamRawEventSummary;
  selectedOffset?: number;
  streamRows: readonly StreamTreeRow[];
  streamSearchOpen: boolean;
  streamSearchQuery: string;
  focused: boolean;
  contentWidth: number;
}) {
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const feedItemCount = props.viewState.slots.feed.length;

  useEffect(() => {
    if (props.activeView !== "feed" || props.detailEvent != null) return;
    const scrollbox = scrollRef.current;
    if (scrollbox == null) return;

    const scrollIntoPosition = () => {
      if (props.focused && props.selectedOffset != null) {
        scrollbox.scrollChildIntoView(`raw-event-${props.selectedOffset}`);
        return;
      }

      scrollbox.scrollTo(scrollbox.scrollHeight);
    };

    const frames = [
      setTimeout(scrollIntoPosition, 0),
      setTimeout(scrollIntoPosition, 16),
      setTimeout(scrollIntoPosition, 33),
    ];

    return () => {
      for (const frame of frames) clearTimeout(frame);
    };
  }, [feedItemCount, props.activeView, props.detailEvent, props.focused, props.selectedOffset]);

  return (
    <scrollbox
      ref={scrollRef}
      width="100%"
      flexGrow={1}
      border
      borderStyle="single"
      borderColor={props.focused ? TUI_COLORS.accent : TUI_COLORS.surfaceMuted}
      focusedBorderColor={TUI_COLORS.accent}
      backgroundColor={TUI_COLORS.bg}
      stickyScroll={props.activeView === "feed" && props.detailEvent == null}
      stickyStart="bottom"
      contentOptions={{ flexDirection: "column", paddingLeft: 1, paddingRight: 1 }}
      focused={props.focused}
    >
      {props.activeView === "state" ? (
        <TuiStateView viewState={props.viewState} contentWidth={props.contentWidth} />
      ) : props.activeView === "streams" ? (
        <TuiStreamsView
          rows={props.streamRows}
          searchOpen={props.streamSearchOpen}
          searchQuery={props.streamSearchQuery}
          contentWidth={props.contentWidth}
        />
      ) : props.detailEvent == null ? (
        <TuiEventsStreamFeedSlot
          elements={props.viewState.slots.feed}
          selectedOffset={props.selectedOffset}
          contentWidth={props.contentWidth}
        />
      ) : (
        <TuiEventDetailView
          event={props.detailEvent}
          rawSummaries={getRawSummaries(props.viewState.slots.feed)}
          contentWidth={props.contentWidth}
        />
      )}
    </scrollbox>
  );
}

function TuiEventsStreamFeedSlot(props: {
  elements: readonly EventsStreamBuiltInElement[];
  selectedOffset?: number;
  contentWidth: number;
}) {
  const elapsedByOffset = getElapsedByOffset(props.elements);
  let lastDateStr: string | undefined;

  if (props.elements.length === 0) {
    return <text fg={TUI_COLORS.textBody}>Waiting for events...</text>;
  }

  return (
    <>
      {props.elements.map((element) => {
        const timestamp = getElementTimestamp(element);
        const dateStr =
          timestamp == null
            ? undefined
            : new Date(timestamp).toLocaleDateString(undefined, {
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "numeric",
              });
        const boundary =
          dateStr != null && lastDateStr != null && dateStr !== lastDateStr ? dateStr : undefined;
        if (dateStr != null) lastDateStr = dateStr;

        return (
          <Fragment key={element.id}>
            {boundary == null ? null : (
              <TuiTimelineRule
                label={boundary}
                color={TUI_COLORS.textDim}
                contentWidth={props.contentWidth}
              />
            )}
            <TuiEventsStreamFeedElementRenderer
              element={element}
              selectedOffset={props.selectedOffset}
              elapsedByOffset={elapsedByOffset}
              contentWidth={props.contentWidth}
            />
          </Fragment>
        );
      })}
    </>
  );
}

function TuiEventsStreamFeedElementRenderer(props: {
  element: EventsStreamBuiltInElement;
  selectedOffset?: number;
  elapsedByOffset: ReadonlyMap<number, string>;
  contentWidth: number;
}) {
  switch (props.element.type) {
    case "message":
      return <TuiMessageItem element={props.element} contentWidth={props.contentWidth} />;
    case "prompt-context":
      return <TuiPromptContextItem element={props.element} contentWidth={props.contentWidth} />;
    case "agent-output":
      return (
        <TuiSimpleBlock
          label={`Agent output · ${formatTime(props.element.props.timestamp)}`}
          text={props.element.props.text}
          color={TUI_COLORS.agent}
          contentWidth={props.contentWidth}
          maxLines={12}
        />
      );
    case "system-prompt":
      return <TuiSystemPromptItem element={props.element} contentWidth={props.contentWidth} />;
    case "llm-request-boundary":
      return (
        <TuiLlmRequestBoundaryItem element={props.element} contentWidth={props.contentWidth} />
      );
    case "lifecycle":
      return (
        <TuiTimelineRule
          label={`${props.element.props.label} · ${formatTime(props.element.props.timestamp)}`}
          contentWidth={props.contentWidth}
        />
      );
    case "error":
      return <TuiErrorItem element={props.element} contentWidth={props.contentWidth} />;
    case "metadata-updated":
      return <TuiMetadataItem element={props.element} contentWidth={props.contentWidth} />;
    case "codemode-block":
      return <TuiCodemodeBlockItem element={props.element} contentWidth={props.contentWidth} />;
    case "codemode-result":
      return <TuiCodemodeResultItem element={props.element} contentWidth={props.contentWidth} />;
    case "grouped-raw-event":
      return (
        <TuiGroupedRawEventItem
          element={props.element}
          selectedOffset={props.selectedOffset}
          elapsedLabel={props.elapsedByOffset.get(props.element.props.events[0]?.offset ?? -1)}
          contentWidth={props.contentWidth}
        />
      );
    case "child-stream-created":
      return (
        <TuiOneLine
          text={`+ Child stream: ${props.element.props.childPath} · ${formatTime(
            props.element.props.timestamp,
          )}`}
          color={TUI_COLORS.textSubdued}
        />
      );
    case "raw-json-dump":
      return (
        <TuiSimpleBlock
          label="Raw stream JSON"
          text={stringifyYaml(props.element.props.events).trimEnd()}
          color={TUI_COLORS.textSubdued}
          contentWidth={props.contentWidth}
        />
      );
    default:
      return <TuiOneLine text={`Unknown stream element: ${props.element.type}`} />;
  }
}

function TuiMessageItem(props: { element: EventsStreamMessageElement; contentWidth: number }) {
  const isUser = props.element.props.role === "user";
  const label = isUser ? "You" : "Agent";
  const color = isUser ? TUI_COLORS.accent : TUI_COLORS.agent;
  const header = `${label} · ${formatTime(props.element.props.timestamp)}`;

  const lines = props.element.props.text
    .split("\n")
    .flatMap((line) => wrapLine(line, props.contentWidth - 2));

  return (
    <box width="100%" flexDirection="column" paddingTop={1}>
      <text fg={color}>
        <b>{isUser ? rightAlign(header, props.contentWidth) : header}</b>
      </text>
      {lines.map((line, index) => (
        <text
          key={`${props.element.id}-${index}`}
          fg={TUI_COLORS.text}
          content={isUser ? rightAlign(line, props.contentWidth) : `  ${line}`}
        />
      ))}
    </box>
  );
}

function TuiPromptContextItem(props: {
  element: EventsStreamPromptContextElement;
  contentWidth: number;
}) {
  const source = props.element.props.source == null ? "" : ` · from ${props.element.props.source}`;
  const trigger = props.element.props.llmRequestPolicy.behaviour;
  const label = `Prompt context${source} · ${trigger} · ${formatTime(props.element.props.timestamp)}`;

  return (
    <TuiSimpleBlock
      label={label}
      text={props.element.props.text}
      color={trigger === "dont-trigger-request" ? TUI_COLORS.textDim : "#b45309"}
      contentWidth={props.contentWidth}
      maxLines={12}
      align="right"
    />
  );
}

function TuiSystemPromptItem(props: {
  element: EventsStreamSystemPromptElement;
  contentWidth: number;
}) {
  return (
    <TuiSimpleBlock
      label={`⚙ System prompt updated · ${formatTime(props.element.props.timestamp)}`}
      text={props.element.props.text}
      color={TUI_COLORS.textSubdued}
      contentWidth={props.contentWidth}
      maxLines={12}
    />
  );
}

function TuiLlmRequestBoundaryItem(props: {
  element: EventsStreamLlmRequestBoundaryElement;
  contentWidth: number;
}) {
  const label =
    props.element.props.phase === "started"
      ? "LLM request started"
      : props.element.props.outcome === "cancelled"
        ? "LLM request cancelled"
        : props.element.props.outcome === "failed"
          ? "LLM request failed"
          : "LLM request completed";

  return (
    <TuiTimelineRule
      label={`${label} · ${props.element.props.requestId} · ${formatTime(
        props.element.props.timestamp,
      )}`}
      color={TUI_COLORS.textDim}
      contentWidth={props.contentWidth}
    />
  );
}

function TuiErrorItem(props: { element: EventsStreamErrorElement; contentWidth: number }) {
  return (
    <TuiSimpleBlock
      label={`⚠ Error · ${formatTime(props.element.props.timestamp)}`}
      text={props.element.props.message}
      color={TUI_COLORS.danger}
      contentWidth={props.contentWidth}
    />
  );
}

function TuiMetadataItem(props: {
  element: EventsStreamMetadataUpdatedElement;
  contentWidth: number;
}) {
  return (
    <TuiSimpleBlock
      label={`Metadata updated · ${props.element.props.path} · ${formatTime(
        props.element.props.timestamp,
      )}`}
      text={stringifyYaml(props.element.props.metadata).trimEnd()}
      color={TUI_COLORS.textSubdued}
      contentWidth={props.contentWidth}
      maxLines={12}
    />
  );
}

function TuiCodemodeBlockItem(props: {
  element: EventsStreamCodemodeBlockElement;
  contentWidth: number;
}) {
  return (
    <TuiSimpleBlock
      label={`Codemode block · ${formatTime(props.element.props.timestamp)}`}
      text={props.element.props.script}
      color={TUI_COLORS.textSubdued}
      contentWidth={props.contentWidth}
      maxLines={18}
    />
  );
}

function TuiCodemodeResultItem(props: {
  element: EventsStreamCodemodeResultElement;
  contentWidth: number;
}) {
  const details = [
    stringifyYaml(props.element.props.result).trimEnd(),
    props.element.props.error == null ? undefined : `error:\n${props.element.props.error}`,
    props.element.props.logs.length === 0
      ? undefined
      : `logs:\n${props.element.props.logs.join("\n")}`,
  ].filter(Boolean);

  return (
    <TuiSimpleBlock
      label={`Codemode ${props.element.props.success ? "succeeded" : "failed"} · ${
        props.element.props.durationMs
      }ms · ${formatTime(props.element.props.timestamp)}`}
      text={details.join("\n\n")}
      color={props.element.props.success ? TUI_COLORS.textSubdued : TUI_COLORS.danger}
      contentWidth={props.contentWidth}
      maxLines={18}
    />
  );
}

function TuiGroupedRawEventItem(props: {
  element: EventsStreamGroupedRawEventElement;
  selectedOffset?: number;
  elapsedLabel?: string;
  contentWidth: number;
}) {
  const firstEvent = props.element.props.events[0];
  if (firstEvent == null) return null;

  const countLabel = props.element.props.count > 1 ? `×${props.element.props.count}` : undefined;
  const selected =
    props.selectedOffset != null &&
    props.element.props.events.some((event) => event.offset === props.selectedOffset);
  const renderableId = `raw-event-${selected ? props.selectedOffset : firstEvent.offset}`;
  const rangeLabel =
    props.element.props.count > 1 &&
    props.element.props.firstTimestamp !== props.element.props.lastTimestamp
      ? `to ${formatTime(props.element.props.lastTimestamp)}`
      : undefined;
  const summary = [
    firstEvent.offset,
    props.element.props.eventType,
    countLabel,
    props.elapsedLabel,
    formatTime(props.element.props.firstTimestamp),
    rangeLabel,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <text
      id={renderableId}
      fg={selected ? TUI_COLORS.text : TUI_COLORS.textDim}
      bg={selected ? TUI_COLORS.selected : undefined}
      content={rightAlign(summary, props.contentWidth)}
    />
  );
}

function TuiTimelineRule(props: { label: string; contentWidth: number; color?: string }) {
  const label = ` ${props.label} `;
  const lineLen = Math.max(0, props.contentWidth - label.length);
  const left = "─".repeat(Math.floor(lineLen / 2));
  const right = "─".repeat(Math.ceil(lineLen / 2));
  return <text fg={props.color ?? TUI_COLORS.textDim} content={`${left}${label}${right}`} />;
}

function TuiSimpleBlock(props: {
  label: string;
  text: string;
  color: string;
  contentWidth: number;
  maxLines?: number;
  align?: "left" | "right";
}) {
  const lines = props.text.split("\n").flatMap((line) => wrapLine(line, props.contentWidth - 2));
  const visibleLines = props.maxLines == null ? lines : lines.slice(0, props.maxLines);
  const hiddenCount = lines.length - visibleLines.length;
  const align = (value: string) =>
    props.align === "right" ? rightAlign(value, props.contentWidth) : value;

  return (
    <box width="100%" flexDirection="column" paddingTop={1}>
      <text fg={props.color}>
        <b>{align(props.label)}</b>
      </text>
      {visibleLines.map((line, index) => (
        <text key={`${props.label}-${index}`} fg={props.color} content={align(`  ${line}`)} />
      ))}
      {hiddenCount > 0 ? (
        <text fg={TUI_COLORS.textDim} content={align(`  ... ${hiddenCount} more lines`)} />
      ) : null}
    </box>
  );
}

function TuiOneLine(props: { text: string; color?: string }) {
  return <text fg={props.color ?? TUI_COLORS.textSubdued} content={props.text} />;
}

function TuiStateView(props: { viewState: EventsStreamViewState; contentWidth: number }) {
  const yaml = stringifyYaml(props.viewState).trimEnd();
  return (
    <box width="100%" flexDirection="column">
      {yaml
        .split("\n")
        .flatMap((line, index) =>
          wrapLine(line, props.contentWidth).map((wrapped, wrappedIndex) => (
            <text key={`${index}-${wrappedIndex}`} fg={TUI_COLORS.textSubdued} content={wrapped} />
          )),
        )}
    </box>
  );
}

function TuiStreamsView(props: {
  rows: readonly StreamTreeRow[];
  searchOpen: boolean;
  searchQuery: string;
  contentWidth: number;
}) {
  const help = props.searchOpen
    ? `Streams focus: filter: ${props.searchQuery}|`
    : "Streams focus: up/down navigate · left/right expand · space toggle · enter open · type to filter";

  if (props.rows.length === 0) {
    return (
      <box width="100%" flexDirection="column">
        <text fg={TUI_COLORS.textDim} content={help} />
        <text fg={TUI_COLORS.textDim} content="No streams loaded. Type /streams to load." />
      </box>
    );
  }

  return (
    <box width="100%" flexDirection="column">
      <text fg={TUI_COLORS.textDim} content={help} />
      {props.rows.map((row) => (
        <TuiStreamRow key={row.path} row={row} contentWidth={props.contentWidth} />
      ))}
    </box>
  );
}

function TuiStreamRow(props: { row: StreamTreeRow; contentWidth: number }) {
  const prefix = `${"  ".repeat(props.row.depth)}${
    props.row.hasChildren ? (props.row.expanded ? "▾" : "▸") : " "
  } `;
  const label = props.row.labelSegments.map((segment) => segment.text).join("");
  const suffix = [
    props.row.current ? "●" : "",
    props.row.createdAt == null ? "" : formatTime(new Date(props.row.createdAt).getTime()),
  ]
    .filter(Boolean)
    .join("  ");
  const gap = Math.max(2, props.contentWidth - prefix.length - label.length - suffix.length);

  return (
    <text
      fg={props.row.current ? TUI_COLORS.text : TUI_COLORS.textSubdued}
      bg={props.row.selected ? TUI_COLORS.selected : undefined}
    >
      <span>{prefix}</span>
      {props.row.labelSegments.map((segment, index) =>
        segment.matched ? (
          <b key={index}>{segment.text}</b>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
      <span>{" ".repeat(gap)}</span>
      <span>{suffix}</span>
    </text>
  );
}

function TuiEventDetailView(props: {
  event: EventsStreamRawEventSummary;
  rawSummaries: readonly EventsStreamRawEventSummary[];
  contentWidth: number;
}) {
  const index = props.rawSummaries.findIndex((summary) => summary.offset === props.event.offset);
  const previous = props.rawSummaries[index - 1];
  const next = props.rawSummaries[index + 1];
  const event = props.event.raw;
  const meta = [
    `offset ${event.offset}`,
    event.createdAt,
    previous == null
      ? undefined
      : `since prev: ${formatElapsedTime(Date.parse(event.createdAt) - Date.parse(previous.createdAt))}`,
    next == null
      ? undefined
      : `until next: ${formatElapsedTime(Date.parse(next.createdAt) - Date.parse(event.createdAt))}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const yaml = stringifyYaml(orderEventKeysForYamlDisplay(event)).trimEnd();

  return (
    <box width="100%" flexDirection="column">
      <text fg={TUI_COLORS.text} content={event.type} />
      <text fg={TUI_COLORS.textSubdued} content={meta} />
      <text fg={TUI_COLORS.textDim} content="left prev · right next · esc close" />
      <text fg={TUI_COLORS.textDim} content={"-".repeat(props.contentWidth)} />
      {yaml
        .split("\n")
        .flatMap((line, index) =>
          wrapLine(line, props.contentWidth - 2).map((wrapped, wrappedIndex) => (
            <text
              key={`${index}-${wrappedIndex}`}
              fg={TUI_COLORS.textBody}
              bg={TUI_COLORS.surfaceCard}
              content={` ${wrapped}`}
            />
          )),
        )}
    </box>
  );
}

function TuiSlashPanel(props: {
  suggestions: readonly TuiSlashSuggestion[];
  selectedPath?: string;
  commandDocs: readonly string[];
}) {
  const lines = props.commandDocs.length > 0 ? props.commandDocs : props.suggestions;
  if (lines.length === 0) return <box height={0} />;

  return (
    <box
      width="100%"
      height={Math.min(lines.length, 8)}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={TUI_COLORS.surfaceDark}
    >
      {props.commandDocs.length > 0
        ? props.commandDocs.map((line, index) => (
            <text
              key={`${line}-${index}`}
              fg={index === 0 ? TUI_COLORS.text : TUI_COLORS.textSubdued}
            >
              {index === 0 ? <b>{line}</b> : line}
            </text>
          ))
        : props.suggestions.map((suggestion) => (
            <text
              key={suggestion.path}
              fg={suggestion.path === props.selectedPath ? TUI_COLORS.text : TUI_COLORS.textSubdued}
              bg={suggestion.path === props.selectedPath ? TUI_COLORS.selected : undefined}
              attributes={suggestion.path === props.selectedPath ? TextAttributes.BOLD : undefined}
            >
              {suggestion.segments.map((segment, index) =>
                segment.matched ? (
                  <b key={index}>{segment.text}</b>
                ) : (
                  <span key={index}>{segment.text}</span>
                ),
              )}
            </text>
          ))}
    </box>
  );
}

function TuiComposer(props: {
  value: string;
  revision: number;
  placeholder: string;
  focused: boolean;
  onInput: (value: string) => void;
  onSubmit: (value: string) => void;
}) {
  return (
    <box
      width="100%"
      height={3}
      border
      borderStyle="single"
      borderColor={props.focused ? TUI_COLORS.accent : TUI_COLORS.surfaceMuted}
      focusedBorderColor={TUI_COLORS.accent}
      backgroundColor={TUI_COLORS.bg}
      paddingLeft={1}
      paddingRight={1}
      focused={props.focused}
    >
      <input
        key={props.revision}
        width="100%"
        value={props.value}
        placeholder={props.placeholder}
        focused={props.focused}
        backgroundColor="transparent"
        focusedBackgroundColor="transparent"
        textColor={TUI_COLORS.text}
        focusedTextColor={TUI_COLORS.text}
        placeholderColor={TUI_COLORS.textMuted}
        cursorColor={TUI_COLORS.accent}
        onInput={props.onInput}
        onSubmit={(value) => {
          if (typeof value === "string") props.onSubmit(value);
        }}
      />
    </box>
  );
}

const getRawSummaries = getRawEventSummariesForTui;

function getBrandMarkText() {
  return new StyledText([
    fg("#000000")(bg(TUI_COLORS.surface)("▐")),
    bg("#000000")(fg("#ffffff")(" 𝑖 ")),
    fg("#000000")(bg(TUI_COLORS.surface)("▌")),
  ]);
}

function getElementTimestamp(element: EventsStreamBuiltInElement) {
  if ("timestamp" in element.props) return element.props.timestamp as number;
  if ("firstTimestamp" in element.props) return element.props.firstTimestamp as number;
  return undefined;
}

function countRawEvents(elements: readonly EventsStreamBuiltInElement[]) {
  let count = 0;
  for (const element of elements) {
    if (element.type === "grouped-raw-event") count += element.props.count;
    if (element.type === "raw-json-dump") count += element.props.events.length;
  }
  return count;
}

import type { Event, StreamPath } from "@iterate-com/shared/streams/types";

/**
 * Serializable data that selects a known stream UI renderer and passes props to
 * it.
 *
 * `id` is model identity. React renderers pass it through as `key`, but the
 * stream view model is intentionally not React-specific.
 */
export type EventsStreamRenderedElement<
  TType extends string = string,
  TProps extends Record<string, unknown> = Record<string, unknown>,
> = {
  id: string;
  type: TType;
  props: TProps;
};

/**
 * Props for a chat-style message element in the feed slot.
 */
export type EventsStreamMessageElementProps = {
  role: "user" | "assistant";
  text: string;
  /**
   * How the message text should be interpreted by the built-in message
   * renderer. Plain text preserves whitespace; markdown enables fenced code
   * blocks for agent prompts that embed structured instructions.
   */
  format?: "text" | "markdown";
  timestamp: number;
  raw: Event;
};

/**
 * Chat-style message element.
 */
export type EventsStreamMessageElement = EventsStreamRenderedElement<
  "message",
  EventsStreamMessageElementProps
>;

/**
 * Props for agent prompt context supplied to the LLM.
 */
export type EventsStreamPromptContextElementProps = {
  source?: string;
  text: string;
  triggerLlmRequest: EventsStreamPromptContextTriggerLlmRequest;
  timestamp: number;
  raw: Event;
};

export type EventsStreamPromptContextTriggerLlmRequest =
  | { behaviour: "auto" }
  | { behaviour: "dont-trigger-request" }
  | { behaviour: "interrupt-current-request" }
  | { behaviour: "after-current-request" }
  | { behaviour: "trigger-request-within-time-period"; withinMs: number };

/**
 * Agent prompt context element.
 */
export type EventsStreamPromptContextElement = EventsStreamRenderedElement<
  "prompt-context",
  EventsStreamPromptContextElementProps
>;

/**
 * Props for agent output supplied by the LLM.
 */
export type EventsStreamAgentOutputElementProps = {
  text: string;
  timestamp: number;
  raw: Event;
};

/**
 * Agent output element.
 */
export type EventsStreamAgentOutputElement = EventsStreamRenderedElement<
  "agent-output",
  EventsStreamAgentOutputElementProps
>;

/**
 * Props for the current system prompt supplied to the LLM.
 */
export type EventsStreamSystemPromptElementProps = {
  text: string;
  timestamp: number;
  raw: Event;
};

/**
 * System prompt element.
 */
export type EventsStreamSystemPromptElement = EventsStreamRenderedElement<
  "system-prompt",
  EventsStreamSystemPromptElementProps
>;

/**
 * Props for LLM request boundary separators.
 */
export type EventsStreamLlmRequestBoundaryElementProps = {
  phase: "started" | "ended";
  outcome?: "completed" | "failed" | "cancelled";
  requestId: string;
  timestamp: number;
  raw: Event;
};

/**
 * Horizontal separator for LLM request start/end events.
 */
export type EventsStreamLlmRequestBoundaryElement = EventsStreamRenderedElement<
  "llm-request-boundary",
  EventsStreamLlmRequestBoundaryElementProps
>;

/**
 * Raw wire event summary carried by grouped raw feed elements.
 */
export type EventsStreamRawEventSummary = {
  streamPath: StreamPath;
  offset: number;
  eventType: string;
  createdAt: string;
  timestamp: number;
  raw: Event;
};

/**
 * Props for a compressed run of consecutive raw event lines with the same event
 * type.
 */
export type EventsStreamGroupedRawEventElementProps = {
  eventType: string;
  count: number;
  events: EventsStreamRawEventSummary[];
  firstTimestamp: number;
  lastTimestamp: number;
};

/**
 * Grouped raw event element.
 */
export type EventsStreamGroupedRawEventElement = EventsStreamRenderedElement<
  "grouped-raw-event",
  EventsStreamGroupedRawEventElementProps
>;

/**
 * Props for a single JSON/YAML dump of the full event stream.
 */
export type EventsStreamRawJsonDumpElementProps = {
  events: Event[];
};

/**
 * Raw JSON/YAML dump element.
 */
export type EventsStreamRawJsonDumpElement = EventsStreamRenderedElement<
  "raw-json-dump",
  EventsStreamRawJsonDumpElementProps
>;

/**
 * Props for a lifecycle timeline marker.
 */
export type EventsStreamLifecycleElementProps = {
  label: string;
  timestamp: number;
  raw: Event;
};

/**
 * Lifecycle timeline marker element.
 */
export type EventsStreamLifecycleElement = EventsStreamRenderedElement<
  "lifecycle",
  EventsStreamLifecycleElementProps
>;

/**
 * Props for a child-stream-created event card.
 */
export type EventsStreamChildStreamCreatedElementProps = {
  parentPath: StreamPath;
  childPath: StreamPath;
  timestamp: number;
  raw: Event;
};

/**
 * Child-stream-created event card element.
 */
export type EventsStreamChildStreamCreatedElement = EventsStreamRenderedElement<
  "child-stream-created",
  EventsStreamChildStreamCreatedElementProps
>;

/**
 * Props for a stream metadata update event card.
 */
export type EventsStreamMetadataUpdatedElementProps = {
  path: StreamPath;
  metadata: Record<string, unknown>;
  timestamp: number;
  raw: Event;
};

/**
 * Metadata update event card element.
 */
export type EventsStreamMetadataUpdatedElement = EventsStreamRenderedElement<
  "metadata-updated",
  EventsStreamMetadataUpdatedElementProps
>;

/**
 * Props for an error event card.
 */
export type EventsStreamErrorElementProps = {
  message: string;
  timestamp: number;
  raw: Event;
};

/**
 * Error event card element.
 */
export type EventsStreamErrorElement = EventsStreamRenderedElement<
  "error",
  EventsStreamErrorElementProps
>;

/**
 * Props for a codemode block event card.
 */
export type EventsStreamCodemodeBlockElementProps = {
  script: string;
  language: "javascript";
  timestamp: number;
  raw: Event;
};

/**
 * Codemode block event card element.
 */
export type EventsStreamCodemodeBlockElement = EventsStreamRenderedElement<
  "codemode-block",
  EventsStreamCodemodeBlockElementProps
>;

/**
 * Props for a codemode execution result event card.
 */
export type EventsStreamCodemodeResultElementProps = {
  success: boolean;
  result: unknown;
  error?: string;
  logs: string[];
  durationMs: number;
  timestamp: number;
  raw: Event;
};

/**
 * Codemode execution result event card element.
 */
export type EventsStreamCodemodeResultElement = EventsStreamRenderedElement<
  "codemode-result",
  EventsStreamCodemodeResultElementProps
>;

/**
 * Props for the current stream activity indicator, usually rendered in the
 * header slot.
 */
export type EventsStreamActivityElementProps = {
  status: "working";
  label: string;
  detail?: string;
};

/**
 * Current activity indicator element.
 */
export type EventsStreamActivityElement = EventsStreamRenderedElement<
  "activity",
  EventsStreamActivityElementProps
>;

/**
 * Props for the reduced stream event counter, usually rendered in the header
 * slot.
 */
export type EventsStreamEventCounterElementProps = {
  count: number;
};

/**
 * Header-slot event counter element.
 */
export type EventsStreamEventCounterElement = EventsStreamRenderedElement<
  "event-counter",
  EventsStreamEventCounterElementProps
>;

/**
 * Action requested by an input-slot element.
 *
 * The action is serializable UI intent. The reducer does not mutate a composer
 * during stream replay; the host app decides what this action means when a user
 * explicitly accepts it.
 */
export type EventsStreamInputAction = {
  type: "prefill-agent-message";
  text: string;
};

/**
 * Props for a composer suggestion rendered near the input composer.
 */
export type EventsStreamComposerSuggestionElementProps = {
  label: string;
  text: string;
  action: EventsStreamInputAction;
  sourceOffset: number;
};

/**
 * Composer suggestion element.
 */
export type EventsStreamComposerSuggestionElement = EventsStreamRenderedElement<
  "composer-suggestion",
  EventsStreamComposerSuggestionElementProps
>;

/**
 * Built-in stream elements shipped by `packages/ui`.
 *
 * Slots can contain any built-in element. Slot placement is represented by the
 * slot array, not by separate header/feed/input item base types.
 */
export type EventsStreamBuiltInElement =
  | EventsStreamMessageElement
  | EventsStreamPromptContextElement
  | EventsStreamAgentOutputElement
  | EventsStreamSystemPromptElement
  | EventsStreamLlmRequestBoundaryElement
  | EventsStreamGroupedRawEventElement
  | EventsStreamRawJsonDumpElement
  | EventsStreamLifecycleElement
  | EventsStreamChildStreamCreatedElement
  | EventsStreamMetadataUpdatedElement
  | EventsStreamErrorElement
  | EventsStreamCodemodeBlockElement
  | EventsStreamCodemodeResultElement
  | EventsStreamActivityElement
  | EventsStreamEventCounterElement
  | EventsStreamComposerSuggestionElement;

/**
 * Named UI regions populated by the stream view reducer.
 */
export type EventsStreamSlots<
  TElement extends EventsStreamRenderedElement = EventsStreamBuiltInElement,
> = {
  header: TElement[];
  feed: TElement[];
  input: TElement[];
};

/**
 * Slot name understood by the stream view renderer.
 */
export type EventsStreamSlotName = keyof EventsStreamSlots;

/**
 * Small reducer-owned state that is useful for deriving rendered elements.
 *
 * This is not directly rendered. It exists so a reducer can track facts across
 * the event log, then project them into slots.
 */
export type EventsStreamActivityState = {
  eventCount: number;
  currentLlmRequestId: string | null;
  latestStreamError: {
    message: string;
    offset: number;
  } | null;
};

/**
 * Reduced view state for an event stream.
 *
 * The canonical render surface is `slots`: each slot contains the same
 * Rendered Element model.
 */
export type EventsStreamViewState = {
  slots: EventsStreamSlots;
  activity: EventsStreamActivityState;
};

/**
 * Browser-side stream view reducer.
 *
 * Reducers synchronously reduce raw stream events into renderer-neutral view
 * state. React, terminal, and future renderers consume that state without
 * owning event interpretation.
 */
export type EventsStreamViewReducer = {
  slug: string;
  createInitialState: () => EventsStreamViewState;
  reduce: (args: {
    event: Event;
    state: EventsStreamViewState;
  }) => EventsStreamViewState | undefined;
};

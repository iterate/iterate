import {
  STREAM_CHILD_STREAM_CREATED_TYPE,
  STREAM_DURABLE_OBJECT_WOKE_UP_TYPE,
  STREAM_ERROR_OCCURRED_TYPE,
  STREAM_METADATA_UPDATED_TYPE,
  StreamPath,
  type Event,
} from "@iterate-com/shared/streams/types";

import type {
  EventsStreamBuiltInElement,
  EventsStreamGroupedRawEventElement,
  EventsStreamRawEventSummary,
  EventsStreamViewReducer,
  EventsStreamViewState,
} from "@iterate-com/ui/components/events/feed-items";

const MAX_SAME_TYPE_RAW_GROUP = 50_000;
const AGENT_SYSTEM_PROMPT_UPDATED_TYPE = "events.iterate.com/agent/system-prompt-updated";
const AGENT_INPUT_ADDED_TYPE = "events.iterate.com/agent/input-added";
const AGENT_OUTPUT_ADDED_TYPE = "events.iterate.com/agent/output-added";
const AGENT_LLM_REQUEST_REQUESTED_TYPE = "events.iterate.com/agent/llm-request-requested";
const AGENT_LLM_REQUEST_COMPLETED_TYPE = "events.iterate.com/agent/llm-request-completed";
const AGENT_LLM_REQUEST_CANCELLED_TYPE = "events.iterate.com/agent/llm-request-cancelled";
const CODEMODE_BLOCK_ADDED_TYPE = "events.iterate.com/codemode/block-added";
const CODEMODE_RESULT_ADDED_TYPE = "events.iterate.com/codemode/result-added";
const CODEMODE_SCRIPT_EXECUTION_REQUESTED_TYPE =
  "events.iterate.com/codemode/script-execution-requested";
const CODEMODE_SCRIPT_EXECUTION_COMPLETED_TYPE =
  "events.iterate.com/codemode/script-execution-completed";

/**
 * Renderer modes available in the shared stream view component.
 *
 * "raw-pretty" is the default interleaved view; "raw-single-json" dumps every
 * event as a single YAML/JSON block.
 */
export const eventsStreamRendererModes = ["raw-pretty", "pretty", "raw-single-json"] as const;
export type EventsStreamRendererMode = (typeof eventsStreamRendererModes)[number];

export const eventsStreamRendererModeOptions: ReadonlyArray<{
  value: EventsStreamRendererMode;
  label: string;
}> = [
  { value: "raw-pretty", label: "Raw + Pretty" },
  { value: "pretty", label: "Pretty" },
  { value: "raw-single-json", label: "Raw YAML" },
];

export function selectEventsStreamViewReducer(
  mode: EventsStreamRendererMode,
): EventsStreamViewReducer {
  switch (mode) {
    case "raw-pretty":
      return rawPrettyEventsStreamViewReducer;
    case "pretty":
      return prettyEventsStreamViewReducer;
    case "raw-single-json":
      return rawJsonDumpEventsStreamViewReducer;
  }
}

function createInitialEventsStreamViewState(): EventsStreamViewState {
  return createEventsStreamViewState({
    feed: [],
    activity: {
      eventCount: 0,
      currentLlmRequestId: null,
      latestStreamError: null,
    },
  });
}

function createEventsStreamViewState(args: {
  feed: EventsStreamBuiltInElement[];
  activity: EventsStreamViewState["activity"];
}): EventsStreamViewState {
  const slots = {
    feed: args.feed,
    header: createHeaderSlotElements(args.activity),
    input: createInputSlotElements(args.activity),
  };

  return {
    slots,
    activity: args.activity,
  };
}

export function processEventsWithViewReducer(args: {
  events: readonly Event[];
  reducer: EventsStreamViewReducer;
}) {
  let state = args.reducer.createInitialState();

  for (const event of args.events) {
    state = args.reducer.reduce({ event, state }) ?? state;
  }

  return state;
}

/**
 * Raw + Pretty is the default stream view: every event contributes to a raw
 * summary row, and events with semantic meaning contribute one additional
 * pretty element immediately after that raw summary.
 *
 * Consecutive unsupported events with the same type can collapse into one
 * grouped raw summary only when each event produced no other feed item. The
 * group still carries every raw event so the inspector can navigate through the
 * underlying wire log.
 */
export const rawPrettyEventsStreamViewReducer = createEventsStreamViewReducer({
  slug: "raw-pretty",
  reduceEventToFeedItems: reduceEventToRawPrettyFeedItems,
  groupConsecutiveRawEvents: true,
});

/** Raw mode is one grouped raw feed item per wire event. */
export const rawEventsStreamViewReducer = createEventsStreamViewReducer({
  slug: "raw",
  reduceEventToFeedItems: (event) => [toRawEventFeedItem(event)],
  groupConsecutiveRawEvents: false,
});

/** Pretty mode emits only semantic items; unsupported event types disappear. */
export const prettyEventsStreamViewReducer = createEventsStreamViewReducer({
  slug: "pretty",
  reduceEventToFeedItems: reduceEventToSemanticFeedItems,
  groupConsecutiveRawEvents: false,
});

/** Raw Single JSON keeps the full stream in one feed item for renderer-level inspection. */
export const rawJsonDumpEventsStreamViewReducer: EventsStreamViewReducer = {
  slug: "raw-single-json",
  createInitialState: createInitialEventsStreamViewState,
  reduce: ({ event, state }) => {
    const previousDump = state.slots.feed[0];
    const previousEvents = previousDump?.type === "raw-json-dump" ? previousDump.props.events : [];
    const activity = reduceActivityState({ event, state });

    return createEventsStreamViewState({
      feed: [
        {
          type: "raw-json-dump",
          id: "raw-json-dump",
          props: { events: [...previousEvents, event] },
        },
      ],
      activity,
    });
  },
};

function createEventsStreamViewReducer(args: {
  slug: string;
  reduceEventToFeedItems: (event: Event) => EventsStreamBuiltInElement[];
  groupConsecutiveRawEvents: boolean;
}): EventsStreamViewReducer {
  return {
    slug: args.slug,
    createInitialState: createInitialEventsStreamViewState,
    reduce: ({ event, state }) => {
      const feedItems = appendFeedItems({
        feedItems: state.slots.feed,
        nextItems: args.reduceEventToFeedItems(event),
        groupConsecutiveRawEvents: args.groupConsecutiveRawEvents,
      });
      const activity = reduceActivityState({ event, state });

      return createEventsStreamViewState({ feed: feedItems, activity });
    },
  };
}

function createHeaderSlotElements(
  activity: EventsStreamViewState["activity"],
): EventsStreamBuiltInElement[] {
  const elements: EventsStreamBuiltInElement[] = [];
  const eventCount = activity.eventCount;

  if (eventCount > 0) {
    elements.push({
      type: "event-counter",
      id: "event-counter",
      props: {
        count: eventCount,
      },
    });
  }

  if (activity.currentLlmRequestId != null) {
    elements.push({
      type: "activity",
      id: "activity",
      props: {
        status: "working",
        label: "Agent working",
        detail: activity.currentLlmRequestId,
      },
    });
  }

  return elements;
}

function createInputSlotElements(
  activity: EventsStreamViewState["activity"],
): EventsStreamBuiltInElement[] {
  if (activity.latestStreamError == null) {
    return [];
  }

  const text = `Can you help debug this stream error?\n\n${activity.latestStreamError.message}`;

  return [
    {
      type: "composer-suggestion",
      id: `composer-suggestion-stream-error-${activity.latestStreamError.offset}`,
      props: {
        label: "Ask agent to debug this error",
        text,
        action: {
          type: "prefill-agent-message",
          text,
        },
        sourceOffset: activity.latestStreamError.offset,
      },
    },
  ];
}

function reduceEventToRawPrettyFeedItems(event: Event): EventsStreamBuiltInElement[] {
  return [toRawEventFeedItem(event), ...reduceEventToSemanticFeedItems(event)];
}

function appendFeedItems(args: {
  feedItems: EventsStreamBuiltInElement[];
  nextItems: readonly EventsStreamBuiltInElement[];
  groupConsecutiveRawEvents: boolean;
}): EventsStreamBuiltInElement[] {
  if (args.nextItems.length === 0) {
    return args.feedItems;
  }

  const feedItems = [...args.feedItems];
  const canGroupNextItems =
    args.groupConsecutiveRawEvents &&
    args.nextItems.length === 1 &&
    args.nextItems[0]?.type === "grouped-raw-event";

  for (const item of args.nextItems) {
    if (!canGroupNextItems) {
      feedItems.push(item);
      continue;
    }

    const previousItem = feedItems[feedItems.length - 1];
    if (previousItem?.type === "grouped-raw-event" && item.type === "grouped-raw-event") {
      if (previousItem.props.eventType === item.props.eventType) {
        feedItems[feedItems.length - 1] = mergeRawEventGroups(previousItem, item);
        continue;
      }
    }

    feedItems.push(item);
  }

  return feedItems;
}

function reduceActivityState(args: {
  event: Event;
  state: EventsStreamViewState;
}): EventsStreamViewState["activity"] {
  const activity = {
    ...args.state.activity,
    eventCount: args.state.activity.eventCount + 1,
  };

  if (args.event.type === STREAM_ERROR_OCCURRED_TYPE) {
    const message = readStringPayloadField(args.event, "message") ?? "Stream error";

    return {
      ...activity,
      latestStreamError: {
        message,
        offset: args.event.offset,
      },
    };
  }

  const requestId = readStringPayloadField(args.event, "requestId");
  const llmRequestId = readNumberPayloadField(args.event, "llmRequestId");

  if (args.event.type === AGENT_LLM_REQUEST_REQUESTED_TYPE) {
    return {
      ...activity,
      currentLlmRequestId: String(llmRequestId ?? args.event.offset),
    };
  }

  if (requestId == null && llmRequestId == null) {
    return activity;
  }

  const currentRequestId = requestId ?? String(llmRequestId);
  if (
    args.state.activity.currentLlmRequestId === currentRequestId &&
    (args.event.type === AGENT_LLM_REQUEST_COMPLETED_TYPE ||
      args.event.type === AGENT_LLM_REQUEST_CANCELLED_TYPE)
  ) {
    return { ...activity, currentLlmRequestId: null };
  }

  return activity;
}

function reduceEventToSemanticFeedItems(event: Event): EventsStreamBuiltInElement[] {
  const timestamp = getTimestamp(event.createdAt);

  if (event.type === AGENT_INPUT_ADDED_TYPE) {
    const content = readStringPayloadField(event, "content");
    if (content == null) return [];
    return [
      {
        type: "prompt-context",
        id: `prompt-context-${event.offset}`,
        props: {
          source: readStringPayloadField(event, "source") ?? undefined,
          text: content,
          triggerLlmRequest: readTriggerLlmRequest(event),
          timestamp,
          raw: event,
        },
      },
    ];
  }

  if (event.type === AGENT_SYSTEM_PROMPT_UPDATED_TYPE) {
    const systemPrompt = readStringPayloadField(event, "systemPrompt");
    if (systemPrompt == null) return [];
    return [
      {
        type: "system-prompt",
        id: `system-prompt-${event.offset}`,
        props: {
          text: systemPrompt,
          timestamp,
          raw: event,
        },
      },
    ];
  }

  if (event.type === AGENT_OUTPUT_ADDED_TYPE) {
    const content = readStringPayloadField(event, "content");
    if (content == null) return [];
    return [
      {
        type: "agent-output",
        id: `agent-output-${event.offset}`,
        props: {
          text: content,
          timestamp,
          raw: event,
        },
      },
    ];
  }

  if (event.type === AGENT_LLM_REQUEST_REQUESTED_TYPE) {
    return [
      {
        type: "llm-request-boundary",
        id: `llm-request-requested-${event.offset}`,
        props: {
          phase: "started",
          requestId: String(event.offset),
          timestamp,
          raw: event,
        },
      },
    ];
  }

  if (
    event.type === AGENT_LLM_REQUEST_COMPLETED_TYPE ||
    event.type === AGENT_LLM_REQUEST_CANCELLED_TYPE
  ) {
    const requestId =
      readStringPayloadField(event, "requestId") ??
      readNumberPayloadField(event, "llmRequestId")?.toString();
    if (requestId == null) return [];
    return [
      {
        type: "llm-request-boundary",
        id: `llm-request-ended-${event.offset}`,
        props: {
          phase: "ended",
          outcome: readLlmRequestOutcome(event.type),
          requestId,
          timestamp,
          raw: event,
        },
      },
    ];
  }

  if (event.type === "events.iterate.com/agent-chat/user-message-added") {
    const content = readStringPayloadField(event, "content");
    if (content == null) return [];
    return [
      {
        type: "message",
        id: `message-user-${event.offset}`,
        props: {
          role: "user",
          text: content,
          timestamp,
          raw: event,
        },
      },
    ];
  }

  if (event.type === "events.iterate.com/agent-chat/assistant-response-added") {
    const message = readStringPayloadField(event, "message");
    if (message == null) return [];
    return [
      {
        type: "message",
        id: `message-assistant-${event.offset}`,
        props: {
          role: "assistant",
          text: message,
          format: "markdown",
          timestamp,
          raw: event,
        },
      },
    ];
  }

  if (event.type === STREAM_DURABLE_OBJECT_WOKE_UP_TYPE) {
    return [
      {
        type: "lifecycle",
        id: `lifecycle-woke-up-${event.offset}`,
        props: {
          label: "Durable object woke up",
          timestamp,
          raw: event,
        },
      },
    ];
  }

  if (event.type === STREAM_CHILD_STREAM_CREATED_TYPE) {
    const childPath = readStringPayloadField(event, "childPath");
    if (childPath == null) return [];
    const parsedChildPath = StreamPath.safeParse(childPath);
    if (!parsedChildPath.success) return [];
    return [
      {
        type: "child-stream-created",
        id: `child-stream-created-${event.offset}`,
        props: {
          parentPath: event.streamPath,
          childPath: parsedChildPath.data,
          timestamp,
          raw: event,
        },
      },
    ];
  }

  if (event.type === STREAM_METADATA_UPDATED_TYPE) {
    const metadata = readRecordPayloadField(event, "metadata");
    if (metadata == null) return [];
    return [
      {
        type: "metadata-updated",
        id: `metadata-updated-${event.offset}`,
        props: {
          path: event.streamPath,
          metadata,
          timestamp,
          raw: event,
        },
      },
    ];
  }

  if (event.type === STREAM_ERROR_OCCURRED_TYPE) {
    const message = readStringPayloadField(event, "message") ?? "Stream error";
    return [
      {
        type: "error",
        id: `error-${event.offset}`,
        props: {
          message,
          timestamp,
          raw: event,
        },
      },
    ];
  }

  if (event.type === CODEMODE_BLOCK_ADDED_TYPE) {
    const script = readStringPayloadField(event, "script");
    if (script == null) return [];
    return [
      {
        type: "codemode-block",
        id: `codemode-block-${event.offset}`,
        props: {
          script,
          language: "javascript",
          timestamp,
          raw: event,
        },
      },
    ];
  }

  if (event.type === CODEMODE_RESULT_ADDED_TYPE) {
    const payload = readPayloadRecord(event);
    const durationMs = readNumberPayloadField(event, "durationMs");
    if (payload == null || durationMs == null || !("result" in payload)) return [];
    const error = readStringPayloadField(event, "error") ?? undefined;
    return [
      {
        type: "codemode-result",
        id: `codemode-result-${event.offset}`,
        props: {
          success: error == null,
          result: payload.result,
          ...(error == null ? {} : { error }),
          logs: readStringArrayPayloadField(event, "logs"),
          durationMs,
          timestamp,
          raw: event,
        },
      },
    ];
  }

  if (event.type === CODEMODE_SCRIPT_EXECUTION_REQUESTED_TYPE) {
    const code = readStringPayloadField(event, "code");
    if (code == null) return [];
    return [
      {
        type: "codemode-block",
        id: `codemode-block-${event.offset}`,
        props: {
          script: code,
          language: "javascript",
          timestamp,
          raw: event,
        },
      },
    ];
  }

  if (event.type === CODEMODE_SCRIPT_EXECUTION_COMPLETED_TYPE) {
    const durationMs = readNumberPayloadField(event, "durationMs") ?? 0;
    const outcome = readRecordPayloadField(event, "outcome");
    const status = outcome?.status;
    const success = status === "returned";
    const error = readCodemodeOutcomeError(outcome);
    return [
      {
        type: "codemode-result",
        id: `codemode-result-${event.offset}`,
        props: {
          success,
          result: readCodemodeOutcomeResult(outcome),
          ...(error == null ? {} : { error }),
          logs: readStringArrayPayloadField(event, "logs"),
          durationMs,
          timestamp,
          raw: event,
        },
      },
    ];
  }

  /*
   * Keep unsupported semantic events as raw summaries for now. Add a dedicated
   * Rendered Element type when an event family earns a real renderer; avoid a
   * vague catch-all card that hides product decisions behind generic UI.
   */
  return [];
}

function readCodemodeOutcomeResult(outcome: Record<string, unknown> | null): unknown {
  if (outcome == null) return {};
  if (outcome.status === "returned" && "value" in outcome) return outcome.value;
  return outcome;
}

function readCodemodeOutcomeError(outcome: Record<string, unknown> | null) {
  if (outcome == null) return undefined;
  if (outcome.status !== "threw") return undefined;
  if (!("error" in outcome)) return undefined;
  return stringifyCodemodeError(outcome.error);
}

function stringifyCodemodeError(error: unknown) {
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

function readLlmRequestOutcome(eventType: string): "completed" | "failed" | "cancelled" {
  if (eventType === AGENT_LLM_REQUEST_COMPLETED_TYPE) return "completed";
  return "cancelled";
}

function toRawEventFeedItem(event: Event): EventsStreamGroupedRawEventElement {
  return createRawEventGroup([toRawEventSummary(event)]);
}

function toRawEventSummary(event: Event): EventsStreamRawEventSummary {
  return {
    streamPath: event.streamPath,
    offset: event.offset,
    createdAt: event.createdAt,
    eventType: event.type,
    timestamp: getTimestamp(event.createdAt),
    raw: event,
  };
}

function mergeRawEventGroups(
  group: EventsStreamGroupedRawEventElement,
  nextGroup: EventsStreamGroupedRawEventElement,
): EventsStreamGroupedRawEventElement {
  const events = [...group.props.events, ...nextGroup.props.events];
  const count = group.props.count + nextGroup.props.count;

  if (events.length > MAX_SAME_TYPE_RAW_GROUP) {
    return createRawEventGroup(events.slice(-MAX_SAME_TYPE_RAW_GROUP), {
      count,
      firstTimestamp: group.props.firstTimestamp,
    });
  }

  return createRawEventGroup(events, { count, firstTimestamp: group.props.firstTimestamp });
}

function createRawEventGroup(
  events: readonly EventsStreamRawEventSummary[],
  state?: { count: number; firstTimestamp: number },
): EventsStreamGroupedRawEventElement {
  const firstEvent = events[0];
  const lastEvent = events[events.length - 1];

  return {
    type: "grouped-raw-event",
    id: `grouped-raw-event-${firstEvent.eventType}-${firstEvent.offset}-${lastEvent.offset}`,
    props: {
      eventType: firstEvent.eventType,
      count: state?.count ?? events.length,
      events: [...events],
      firstTimestamp: state?.firstTimestamp ?? firstEvent.timestamp,
      lastTimestamp: lastEvent.timestamp,
    },
  };
}

function readStringPayloadField(event: Event, key: string) {
  const value = readPayloadRecord(event)?.[key];
  return typeof value === "string" ? value : null;
}

function readRecordPayloadField(event: Event, key: string): Record<string, unknown> | null {
  const value = readPayloadRecord(event)?.[key];
  return isRecord(value) ? value : null;
}

function readTriggerLlmRequest(event: Event) {
  const trigger = readRecordPayloadField(event, "triggerLlmRequest");
  if (trigger == null) return { behaviour: "auto" as const };

  switch (trigger.behaviour) {
    case "auto":
    case "dont-trigger-request":
    case "interrupt-current-request":
    case "after-current-request":
      return { behaviour: trigger.behaviour };
    case "trigger-request-within-time-period":
      return typeof trigger.withinMs === "number"
        ? { behaviour: trigger.behaviour, withinMs: trigger.withinMs }
        : { behaviour: "auto" as const };
    default:
      return { behaviour: "auto" as const };
  }
}

function readNumberPayloadField(event: Event, key: string) {
  const value = readPayloadRecord(event)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStringArrayPayloadField(event: Event, key: string) {
  const value = readPayloadRecord(event)?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function readPayloadRecord(event: Event) {
  return isRecord(event.payload) ? event.payload : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function getTimestamp(createdAt: string) {
  return Date.parse(createdAt);
}

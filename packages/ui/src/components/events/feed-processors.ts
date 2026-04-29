import {
  STREAM_CHILD_STREAM_CREATED_TYPE,
  STREAM_DURABLE_OBJECT_WOKE_UP_TYPE,
  STREAM_ERROR_OCCURRED_TYPE,
  STREAM_FIRST_INITIALIZED_TYPE,
  STREAM_METADATA_UPDATED_TYPE,
  StreamPath,
  type Event,
} from "@iterate-com/events-contract";

import type {
  EventsStreamBuiltInElement,
  EventsStreamGroupedRawEventElement,
  EventsStreamRawEventElement,
  EventsStreamViewReducer,
  EventsStreamViewState,
} from "@iterate-com/ui/components/events/feed-items";

const MAX_SAME_TYPE_RAW_GROUP = 50_000;
const AGENT_INPUT_ADDED_TYPE = "events.iterate.com/agent/input-added";
const CODEMODE_BLOCK_ADDED_TYPE = "events.iterate.com/codemode/block-added";
const CODEMODE_RESULT_ADDED_TYPE = "events.iterate.com/codemode/result-added";

function createInitialEventsStreamViewState(): EventsStreamViewState {
  return createEventsStreamViewState({
    feed: [],
    activity: {
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
    header: createHeaderSlotElements({ activity: args.activity, feed: args.feed }),
    input: createInputSlotElements(args.activity),
  };

  return {
    slots,
    outlets: slots,
    feedItems: slots.feed,
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

/** Raw mode is one feed item per wire event. */
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

      if (feedItems === state.slots.feed && activity === state.activity) {
        return undefined;
      }

      return createEventsStreamViewState({ feed: feedItems, activity });
    },
  };
}

function createHeaderSlotElements(args: {
  activity: EventsStreamViewState["activity"];
  feed: readonly EventsStreamBuiltInElement[];
}): EventsStreamBuiltInElement[] {
  const elements: EventsStreamBuiltInElement[] = [];
  const eventCount = countRawEventsInFeed(args.feed);

  if (eventCount > 0) {
    elements.push({
      type: "event-counter",
      id: "event-counter",
      props: {
        count: eventCount,
      },
    });
  }

  if (args.activity.currentLlmRequestId != null) {
    elements.push({
      type: "activity",
      id: "activity",
      props: {
        status: "working",
        label: "Agent working",
        detail: args.activity.currentLlmRequestId,
      },
    });
  }

  return elements;
}

function countRawEventsInFeed(elements: readonly EventsStreamBuiltInElement[]) {
  let count = 0;

  for (const element of elements) {
    if (element.type === "raw-event") {
      count += 1;
      continue;
    }

    if (element.type === "grouped-raw-event") {
      count += element.props.count;
      continue;
    }

    if (element.type === "raw-json-dump") {
      count += element.props.events.length;
    }
  }

  return count;
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
    args.nextItems[0]?.type === "raw-event";

  for (const item of args.nextItems) {
    if (!canGroupNextItems) {
      feedItems.push(item);
      continue;
    }

    const previousItem = feedItems[feedItems.length - 1];
    if (previousItem?.type === "grouped-raw-event" && item.type === "raw-event") {
      if (previousItem.props.eventType === item.props.eventType) {
        feedItems[feedItems.length - 1] = addRawEventToGroup(previousItem, item);
        continue;
      }
    }

    if (previousItem?.type === "raw-event" && item.type === "raw-event") {
      if (previousItem.props.eventType === item.props.eventType) {
        feedItems[feedItems.length - 1] = createRawEventGroup([previousItem, item]);
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
  if (args.event.type === STREAM_ERROR_OCCURRED_TYPE) {
    const message = readStringPayloadField(args.event, "message") ?? "Stream error";

    return {
      ...args.state.activity,
      latestStreamError: {
        message,
        offset: args.event.offset,
      },
    };
  }

  const requestId = readStringPayloadField(args.event, "requestId");

  if (requestId == null) {
    return args.state.activity;
  }

  if (
    args.event.type === "llm-request-started" ||
    args.event.type === "events.iterate.com/agent/llm-request-started"
  ) {
    return { ...args.state.activity, currentLlmRequestId: requestId };
  }

  if (
    args.state.activity.currentLlmRequestId === requestId &&
    (args.event.type === "llm-request-completed" ||
      args.event.type === "llm-request-cancelled" ||
      args.event.type === "llm-request-failed" ||
      args.event.type === "events.iterate.com/agent/llm-request-completed" ||
      args.event.type === "events.iterate.com/agent/llm-request-cancelled" ||
      args.event.type === "events.iterate.com/agent/llm-request-failed")
  ) {
    return { ...args.state.activity, currentLlmRequestId: null };
  }

  return args.state.activity;
}

function reduceEventToSemanticFeedItems(event: Event): EventsStreamBuiltInElement[] {
  const timestamp = getTimestamp(event.createdAt);

  if (event.type === AGENT_INPUT_ADDED_TYPE) {
    const content = readStringPayloadField(event, "content");
    const role = readAgentMessageRole(event);
    if (content == null || role == null) return [];
    return [
      {
        type: "message",
        id: `message-${role}-${event.offset}`,
        props: {
          role,
          text: content,
          format: "markdown",
          timestamp,
          raw: event,
        },
      },
    ];
  }

  if (
    event.type === "events.iterate.com/webchat/user-message-added" ||
    event.type === "events.iterate.com/tui/user-message-added" ||
    event.type === "webchat-message-received" ||
    event.type === "events.iterate.com/agent/webchat-message-received"
  ) {
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

  if (
    event.type === "events.iterate.com/webchat/agent-response-added" ||
    event.type === "events.iterate.com/tui/agent-response-added" ||
    event.type === "webchat-response-added" ||
    event.type === "events.iterate.com/agent/webchat-response-added"
  ) {
    const message = readStringPayloadField(event, "message");
    if (message == null) return [];
    return [
      {
        type: "message",
        id: `message-assistant-${event.offset}`,
        props: {
          role: "assistant",
          text: message,
          timestamp,
          raw: event,
        },
      },
    ];
  }

  if (event.type === STREAM_FIRST_INITIALIZED_TYPE) {
    return [
      {
        type: "lifecycle",
        id: `lifecycle-initialized-${event.offset}`,
        props: {
          label: "Stream initialized",
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

  /*
   * Keep unsupported semantic events as raw summaries for now. Add a dedicated
   * Rendered Element type when an event family earns a real renderer; avoid a
   * vague catch-all card that hides product decisions behind generic UI.
   */
  return [];
}

function toRawEventFeedItem(event: Event): EventsStreamRawEventElement {
  return {
    type: "raw-event",
    id: `raw-event-${event.offset}`,
    props: {
      streamPath: event.streamPath,
      offset: event.offset,
      createdAt: event.createdAt,
      eventType: event.type,
      timestamp: getTimestamp(event.createdAt),
      raw: event,
    },
  };
}

function addRawEventToGroup(
  group: EventsStreamGroupedRawEventElement,
  event: EventsStreamRawEventElement,
): EventsStreamGroupedRawEventElement {
  const events = [...group.props.events, event];
  const count = group.props.count + 1;

  if (events.length > MAX_SAME_TYPE_RAW_GROUP) {
    return createRawEventGroup(events.slice(-MAX_SAME_TYPE_RAW_GROUP), {
      count,
      firstTimestamp: group.props.firstTimestamp,
    });
  }

  return createRawEventGroup(events, { count, firstTimestamp: group.props.firstTimestamp });
}

function createRawEventGroup(
  events: readonly EventsStreamRawEventElement[],
  state?: { count: number; firstTimestamp: number },
): EventsStreamGroupedRawEventElement {
  const firstEvent = events[0];
  const lastEvent = events[events.length - 1];

  return {
    type: "grouped-raw-event",
    id: `grouped-raw-event-${firstEvent.props.eventType}-${firstEvent.props.offset}-${lastEvent.props.offset}`,
    props: {
      eventType: firstEvent.props.eventType,
      count: state?.count ?? events.length,
      events: [...events],
      firstTimestamp: state?.firstTimestamp ?? firstEvent.props.timestamp,
      lastTimestamp: lastEvent.props.timestamp,
    },
  };
}

function readStringPayloadField(event: Event, key: string) {
  const value = readPayloadRecord(event)?.[key];
  return typeof value === "string" ? value : null;
}

function readAgentMessageRole(event: Event) {
  const role = readPayloadRecord(event)?.role;

  if (role == null) {
    return "user";
  }

  return role === "user" || role === "assistant" ? role : null;
}

function readRecordPayloadField(event: Event, key: string): Record<string, unknown> | null {
  const value = readPayloadRecord(event)?.[key];
  return isRecord(value) ? value : null;
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

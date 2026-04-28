import { StreamPath, type Event } from "@iterate-com/events-contract";

import type {
  EventsStreamFeedItem,
  EventsStreamGroupedRawEventFeedItem,
  EventsStreamRawEventFeedItem,
  EventsStreamViewProcessor,
  EventsStreamViewState,
} from "@iterate-com/ui/components/events/feed-items";

const MAX_SAME_TYPE_RAW_GROUP = 50_000;

const initialEventsStreamViewState: EventsStreamViewState = {
  feedItems: [],
  activity: {
    currentLlmRequestId: null,
  },
};

export function processEventsWithViewProcessor(args: {
  events: readonly Event[];
  processor: EventsStreamViewProcessor;
}) {
  let state = structuredClone(args.processor.initialState) as EventsStreamViewState;

  for (const event of args.events) {
    state = args.processor.reduce({ event, state }) ?? state;
  }

  return state;
}

/**
 * Raw + Pretty keeps grouped wire events in the feed and inserts semantic items
 * immediately after the raw event that produced them.
 */
export const rawPrettyEventsStreamViewProcessor = createEventsStreamViewProcessor({
  slug: "raw-pretty",
  reduceEventToFeedItems: reduceEventToRawPrettyFeedItems,
});

/** Raw mode is one feed item per wire event. */
export const rawEventsStreamViewProcessor = createEventsStreamViewProcessor({
  slug: "raw",
  reduceEventToFeedItems: (event) => [toRawEventFeedItem(event)],
});

/** Pretty mode emits only semantic items; unsupported event types disappear. */
export const prettyEventsStreamViewProcessor = createEventsStreamViewProcessor({
  slug: "pretty",
  reduceEventToFeedItems: reduceEventToSemanticFeedItems,
});

/** Raw Single JSON is finalized after reduction so it can see the full event list. */
export function reduceEventsToRawJsonDumpViewState(
  events: readonly Event[],
): EventsStreamViewState {
  return {
    ...initialEventsStreamViewState,
    feedItems:
      events.length === 0
        ? []
        : [{ type: "raw-json-dump", id: "raw-json-dump", events: [...events] }],
  };
}

function createEventsStreamViewProcessor(args: {
  slug: string;
  reduceEventToFeedItems: (event: Event) => EventsStreamFeedItem[];
}): EventsStreamViewProcessor {
  return {
    slug: args.slug,
    initialState: initialEventsStreamViewState,
    reduce: ({ event, state }) => {
      const feedItems = appendFeedItems({
        feedItems: state.feedItems,
        nextItems: args.reduceEventToFeedItems(event),
      });
      const activity = reduceActivityState({ event, state });

      if (feedItems === state.feedItems && activity === state.activity) {
        return undefined;
      }

      return { feedItems, activity };
    },
  };
}

function reduceEventToRawPrettyFeedItems(event: Event): EventsStreamFeedItem[] {
  return [toRawEventFeedItem(event), ...reduceEventToSemanticFeedItems(event)];
}

function appendFeedItems(args: {
  feedItems: EventsStreamFeedItem[];
  nextItems: readonly EventsStreamFeedItem[];
}): EventsStreamFeedItem[] {
  if (args.nextItems.length === 0) {
    return args.feedItems;
  }

  const feedItems = [...args.feedItems];

  for (const item of args.nextItems) {
    const previousItem = feedItems[feedItems.length - 1];
    if (previousItem?.type === "grouped-raw-event" && item.type === "raw-event") {
      if (previousItem.eventType === item.eventType) {
        feedItems[feedItems.length - 1] = addRawEventToGroup(previousItem, item);
        continue;
      }
    }

    if (previousItem?.type === "raw-event" && item.type === "raw-event") {
      if (previousItem.eventType === item.eventType) {
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
  const requestId = readStringPayloadField(args.event, "requestId");

  if (requestId == null) {
    return args.state.activity;
  }

  if (args.event.type === "llm-request-started") {
    return { ...args.state.activity, currentLlmRequestId: requestId };
  }

  if (
    args.state.activity.currentLlmRequestId === requestId &&
    (args.event.type === "llm-request-completed" ||
      args.event.type === "llm-request-cancelled" ||
      args.event.type === "llm-request-failed")
  ) {
    return { ...args.state.activity, currentLlmRequestId: null };
  }

  return args.state.activity;
}

function reduceEventToSemanticFeedItems(event: Event): EventsStreamFeedItem[] {
  const timestamp = getTimestamp(event.createdAt);

  if (event.type === "webchat-message-received") {
    const content = readStringPayloadField(event, "content");
    if (content == null) return [];
    return [
      {
        type: "message",
        id: `message-user-${event.offset}`,
        role: "user",
        text: content,
        timestamp,
        raw: event,
      },
    ];
  }

  if (event.type === "webchat-response-added") {
    const message = readStringPayloadField(event, "message");
    if (message == null) return [];
    return [
      {
        type: "message",
        id: `message-assistant-${event.offset}`,
        role: "assistant",
        text: message,
        timestamp,
        raw: event,
      },
    ];
  }

  if (event.type === "https://events.iterate.com/events/stream/initialized") {
    return [
      {
        type: "lifecycle",
        id: `lifecycle-initialized-${event.offset}`,
        label: "Stream initialized",
        timestamp,
        raw: event,
      },
    ];
  }

  if (event.type === "https://events.iterate.com/events/stream/durable-object-woke-up") {
    return [
      {
        type: "lifecycle",
        id: `lifecycle-woke-up-${event.offset}`,
        label: "Durable object woke up",
        timestamp,
        raw: event,
      },
    ];
  }

  if (event.type === "https://events.iterate.com/events/stream/child-stream-created") {
    const childPath = readStringPayloadField(event, "childPath");
    if (childPath == null) return [];
    const parsedChildPath = StreamPath.safeParse(childPath);
    if (!parsedChildPath.success) return [];
    return [
      {
        type: "child-stream-created",
        id: `child-stream-created-${event.offset}`,
        parentPath: event.streamPath,
        childPath: parsedChildPath.data,
        timestamp,
        raw: event,
      },
    ];
  }

  if (event.type === "https://events.iterate.com/events/stream/metadata-updated") {
    const metadata = readRecordPayloadField(event, "metadata");
    if (metadata == null) return [];
    return [
      {
        type: "metadata-updated",
        id: `metadata-updated-${event.offset}`,
        path: event.streamPath,
        metadata,
        timestamp,
        raw: event,
      },
    ];
  }

  if (event.type === "https://events.iterate.com/events/stream/error-occurred") {
    const message = readStringPayloadField(event, "message") ?? "Stream error";
    return [
      {
        type: "error",
        id: `error-${event.offset}`,
        message,
        timestamp,
        raw: event,
      },
    ];
  }

  return [];
}

function toRawEventFeedItem(event: Event): EventsStreamRawEventFeedItem {
  return {
    type: "raw-event",
    id: `raw-event-${event.offset}`,
    streamPath: event.streamPath,
    offset: event.offset,
    createdAt: event.createdAt,
    eventType: event.type,
    timestamp: getTimestamp(event.createdAt),
    raw: event,
  };
}

function addRawEventToGroup(
  group: EventsStreamGroupedRawEventFeedItem,
  event: EventsStreamRawEventFeedItem,
): EventsStreamGroupedRawEventFeedItem {
  const events = [...group.events, event];

  if (events.length > MAX_SAME_TYPE_RAW_GROUP) {
    return createRawEventGroup(events.slice(-MAX_SAME_TYPE_RAW_GROUP));
  }

  return createRawEventGroup(events);
}

function createRawEventGroup(
  events: readonly EventsStreamRawEventFeedItem[],
): EventsStreamGroupedRawEventFeedItem {
  const firstEvent = events[0];
  const lastEvent = events[events.length - 1];

  return {
    type: "grouped-raw-event",
    id: `grouped-raw-event-${firstEvent.eventType}-${firstEvent.offset}-${lastEvent.offset}`,
    eventType: firstEvent.eventType,
    count: events.length,
    events: [...events],
    firstTimestamp: firstEvent.timestamp,
    lastTimestamp: lastEvent.timestamp,
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

function readPayloadRecord(event: Event) {
  return isRecord(event.payload) ? event.payload : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function getTimestamp(createdAt: string) {
  return Number.isNaN(Date.parse(createdAt)) ? Date.now() : Date.parse(createdAt);
}

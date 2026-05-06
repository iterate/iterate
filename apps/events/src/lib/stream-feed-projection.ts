import {
  ChildStreamCreatedEvent,
  ErrorOccurredEvent,
  STREAM_CHILD_STREAM_CREATED_TYPE,
  STREAM_DURABLE_OBJECT_WOKE_UP_TYPE,
  STREAM_ERROR_OCCURRED_TYPE,
  STREAM_FIRST_INITIALIZED_TYPE,
  STREAM_METADATA_UPDATED_TYPE,
  STREAM_PAUSED_TYPE,
  STREAM_RESUMED_TYPE,
  STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
  StreamSubscriptionConfiguredEvent,
  StreamMetadataUpdatedEvent,
  StreamPausedEvent,
  StreamResumedEvent,
  type Event,
} from "@iterate-com/events-contract";
import type {
  EventFeedItem,
  GroupedEventFeedItem,
  StreamFeedItem,
  StreamRendererMode,
} from "~/lib/stream-feed-types.ts";
import { buildAgentSemanticInsertions } from "~/lib/agent-stream-reducer.ts";

/**
 * Raw + Pretty groups consecutive wire rows of the same `eventType`. Very large
 * cap so normal streams stay one group per run; only pathological runs flush early.
 */
const MAX_SAME_TYPE_RAW_GROUP = 50_000;

export function projectWireToFeed(
  events: readonly Event[],
  options: { customInsertionsByOffset?: ReadonlyMap<number, StreamFeedItem[]> } = {},
): StreamFeedItem[] {
  const insertionsByOffset = buildSemanticInsertions(events);
  if (options.customInsertionsByOffset) {
    mergeInsertions(insertionsByOffset, options.customInsertionsByOffset);
  }

  return events.flatMap((event) => {
    const eventFeedItem = toEventFeedItem(event);
    return [eventFeedItem, ...(insertionsByOffset.get(event.offset) ?? [])];
  });
}

export function toEventFeedItem(event: Event): EventFeedItem {
  return {
    kind: "event",
    streamPath: event.streamPath,
    offset: event.offset,
    createdAt: event.createdAt,
    eventType: event.type,
    timestamp: getTimestamp(event.createdAt),
    raw: event,
  };
}

export function projectEventToFeed(event: Event): StreamFeedItem[] {
  const eventFeedItem = toEventFeedItem(event);
  const semanticItem = toSemanticFeedItem(event);

  if (semanticItem == null) {
    return [eventFeedItem];
  }

  return [eventFeedItem, semanticItem];
}

export function getEventFeedItems(feed: readonly StreamFeedItem[]): EventFeedItem[] {
  return feed.filter((item): item is EventFeedItem => item.kind === "event");
}

export function buildDisplayFeed(
  feed: readonly StreamFeedItem[],
  mode: StreamRendererMode,
): StreamFeedItem[] | null {
  if (mode === "raw-single-json") {
    return null;
  }

  if (mode === "raw") {
    return getEventFeedItems(feed);
  }

  if (mode === "pretty") {
    return feed.filter((item) => item.kind !== "event");
  }

  const displayFeed: StreamFeedItem[] = [];
  let currentGroup: EventFeedItem[] = [];

  for (const item of feed) {
    if (item.kind === "event") {
      if (currentGroup[0]?.eventType === item.eventType) {
        currentGroup.push(item);
        if (currentGroup.length >= MAX_SAME_TYPE_RAW_GROUP) {
          flushCurrentGroup(displayFeed, currentGroup);
          currentGroup = [];
        }
        continue;
      }

      flushCurrentGroup(displayFeed, currentGroup);
      currentGroup = [item];
      continue;
    }

    flushCurrentGroup(displayFeed, currentGroup);
    currentGroup = [];
    displayFeed.push(item);
  }

  flushCurrentGroup(displayFeed, currentGroup);

  return displayFeed;
}

function flushCurrentGroup(displayFeed: StreamFeedItem[], currentGroup: readonly EventFeedItem[]) {
  if (currentGroup.length === 0) {
    return;
  }

  displayFeed.push(createGroupedOrSingleEvent(currentGroup));
}

export function toSemanticFeedItem(event: Event): StreamFeedItem | null {
  if (event.type === "events.iterate.com/agent/input-added") {
    const payload = event.payload as { content?: unknown };
    if (typeof payload.content !== "string") return null;
    return {
      kind: "message",
      role: "user",
      content: [{ type: "markdown", text: payload.content }],
      timestamp: getTimestamp(event.createdAt),
    };
  }

  if (event.type === "events.iterate.com/agent/output-added") {
    const payload = event.payload as { content?: unknown };
    if (typeof payload.content !== "string") return null;
    return {
      kind: "message",
      role: "assistant",
      content: [{ type: "markdown", text: payload.content }],
      timestamp: getTimestamp(event.createdAt),
    };
  }

  if (event.type === "events.iterate.com/agent-chat/user-message-added") {
    const payload = event.payload as { content?: unknown };
    const content = typeof payload.content === "string" ? payload.content : null;
    if (content == null) return null;
    return {
      kind: "message",
      role: "user",
      content: [{ type: "text", text: content }],
      timestamp: getTimestamp(event.createdAt),
    };
  }

  if (event.type === "events.iterate.com/agent-chat/assistant-response-added") {
    const payload = event.payload as { message?: unknown };
    const message = typeof payload.message === "string" ? payload.message : null;
    if (message == null) return null;
    return {
      kind: "message",
      role: "assistant",
      content: [{ type: "markdown", text: message }],
      timestamp: getTimestamp(event.createdAt),
    };
  }

  if (event.type === "events.iterate.com/agent/status-updated") {
    const payload = event.payload as {
      status?: unknown;
      reason?: unknown;
      requestId?: unknown;
    };
    if (payload.status !== "working" && payload.status !== "idle") return null;
    if (typeof payload.reason !== "string") return null;
    return {
      kind: "agent-status",
      status: payload.status,
      reason: payload.reason,
      ...(typeof payload.requestId === "string" ? { requestId: payload.requestId } : {}),
      timestamp: getTimestamp(event.createdAt),
      raw: event,
    };
  }

  if (event.type === "events.iterate.com/codemode/block-added") {
    const payload = event.payload as { script?: unknown };
    if (typeof payload.script !== "string") return null;
    return {
      kind: "codemode-block",
      blockId: "codemode",
      language: "js",
      code: payload.script,
      timestamp: getTimestamp(event.createdAt),
      raw: event,
    };
  }

  if (event.type === "events.iterate.com/codemode/result-added") {
    const payload = event.payload as {
      result?: unknown;
      error?: unknown;
      logs?: unknown;
      durationMs?: unknown;
    };
    const logs = Array.isArray(payload.logs)
      ? payload.logs.filter((log): log is string => typeof log === "string")
      : [];
    const error = typeof payload.error === "string" ? payload.error : "";
    return {
      kind: "codemode-result",
      blockId: "codemode",
      success: error.length === 0,
      stdout: [...logs, JSON.stringify(payload.result, null, 2)].filter(Boolean).join("\n"),
      stderr: error,
      ...(typeof payload.durationMs === "number" ? { durationMs: payload.durationMs } : {}),
      timestamp: getTimestamp(event.createdAt),
      raw: event,
    };
  }

  if (event.type === STREAM_CHILD_STREAM_CREATED_TYPE) {
    return {
      kind: "child-stream-created",
      parentPath: event.streamPath,
      createdPath: getChildStreamCreatedEventPath(event),
      timestamp: getTimestamp(event.createdAt),
      raw: event,
    };
  }

  if (event.type === STREAM_METADATA_UPDATED_TYPE) {
    return {
      kind: "stream-metadata-updated",
      path: event.streamPath,
      metadata: getStreamMetadataUpdatedEventMetadata(event),
      timestamp: getTimestamp(event.createdAt),
      raw: event,
    };
  }

  if (event.type === STREAM_SUBSCRIPTION_CONFIGURED_TYPE) {
    const subscriber = getStreamSubscriptionConfiguredSubscriber(event);
    if (subscriber == null) return null;
    return {
      kind: "external-subscriber-configured",
      subscriber,
      timestamp: getTimestamp(event.createdAt),
      raw: event,
    };
  }

  if (event.type === STREAM_FIRST_INITIALIZED_TYPE) {
    return {
      kind: "stream-lifecycle",
      label: "Durable object initialized",
      timestamp: getTimestamp(event.createdAt),
      raw: event,
    };
  }

  if (event.type === STREAM_DURABLE_OBJECT_WOKE_UP_TYPE) {
    return {
      kind: "stream-lifecycle",
      label: "Durable object woke up",
      timestamp: getTimestamp(event.createdAt),
      raw: event,
    };
  }

  if (event.type === STREAM_PAUSED_TYPE) {
    const paused = StreamPausedEvent.parse(event);
    return {
      kind: "stream-paused",
      reason: paused.payload.reason ?? "No reason provided",
      timestamp: getTimestamp(event.createdAt),
      raw: event,
    };
  }

  if (event.type === STREAM_RESUMED_TYPE) {
    const resumed = StreamResumedEvent.parse(event);
    return {
      kind: "stream-resumed",
      reason: resumed.payload.reason ?? "No reason provided",
      timestamp: getTimestamp(event.createdAt),
      raw: event,
    };
  }

  if (event.type === STREAM_ERROR_OCCURRED_TYPE) {
    return {
      kind: "stream-error-occurred",
      message: ErrorOccurredEvent.parse(event).payload.message,
      timestamp: getTimestamp(event.createdAt),
      raw: event,
    };
  }

  return null;
}

function mergeInsertions(
  target: Map<number, StreamFeedItem[]>,
  addition: ReadonlyMap<number, StreamFeedItem[]>,
) {
  for (const [offset, items] of addition) {
    const existing = target.get(offset);
    if (existing) {
      existing.push(...items);
    } else {
      target.set(offset, [...items]);
    }
  }
}

function buildSemanticInsertions(events: readonly Event[]) {
  const insertionsByOffset = new Map<number, StreamFeedItem[]>();

  for (const event of events) {
    const semanticItem = toSemanticFeedItem(event);
    if (semanticItem) {
      appendInsertion(insertionsByOffset, event.offset, semanticItem);
    }
  }

  mergeInsertions(insertionsByOffset, buildAgentSemanticInsertions(events));

  return insertionsByOffset;
}

function appendInsertion(
  insertionsByOffset: Map<number, StreamFeedItem[]>,
  offset: number,
  item: StreamFeedItem,
) {
  const existing = insertionsByOffset.get(offset);
  if (existing) {
    existing.push(item);
    return;
  }

  insertionsByOffset.set(offset, [item]);
}

function getChildStreamCreatedEventPath(event: Event) {
  return ChildStreamCreatedEvent.parse(event).payload.childPath;
}

function getStreamMetadataUpdatedEventMetadata(event: Event) {
  return StreamMetadataUpdatedEvent.parse(event).payload.metadata;
}

function getStreamSubscriptionConfiguredSubscriber(event: Event) {
  const parsed = StreamSubscriptionConfiguredEvent.safeParse(event);
  return parsed.success ? parsed.data.payload : null;
}

export function createGroupedOrSingleEvent(
  events: readonly EventFeedItem[],
): EventFeedItem | GroupedEventFeedItem {
  if (events.length === 0) {
    throw new Error("Cannot create a grouped event item from an empty list.");
  }

  if (events.length === 1) {
    return events[0];
  }

  return {
    kind: "grouped-event",
    eventType: events[0].eventType,
    count: events.length,
    events: [...events],
    firstTimestamp: events[0].timestamp,
    lastTimestamp: events[events.length - 1].timestamp,
  };
}

export function getAdjacentEventOffset(
  events: readonly EventFeedItem[],
  currentOffset: number | undefined,
  direction: "previous" | "next",
) {
  if (currentOffset == null) {
    return undefined;
  }

  const index = events.findIndex((event) => event.offset === currentOffset);

  if (index === -1) {
    return undefined;
  }

  const adjacentIndex = direction === "previous" ? index - 1 : index + 1;
  return events[adjacentIndex]?.offset;
}

function getTimestamp(createdAt: string) {
  return Number.isNaN(Date.parse(createdAt)) ? Date.now() : Date.parse(createdAt);
}

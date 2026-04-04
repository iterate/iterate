import {
  ChildStreamCreatedEvent,
  StreamMetadataUpdatedEvent,
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

export function projectWireToFeed(events: readonly Event[]): StreamFeedItem[] {
  const insertionsByOffset = buildSemanticInsertions(events);

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
  if (mode === "raw") {
    return null;
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
  if (event.type === "https://events.iterate.com/events/stream/child-stream-created") {
    return {
      kind: "child-stream-created",
      parentPath: event.streamPath,
      createdPath: getChildStreamCreatedEventPath(event),
      timestamp: getTimestamp(event.createdAt),
      raw: event,
    };
  }

  if (event.type === "https://events.iterate.com/events/stream/metadata-updated") {
    return {
      kind: "stream-metadata-updated",
      path: event.streamPath,
      metadata: getStreamMetadataUpdatedEventMetadata(event),
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

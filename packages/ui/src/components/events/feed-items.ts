import type { Event, StreamPath } from "@iterate-com/events-contract";

/**
 * Feed items are the cacheable UI projection of an event stream.
 *
 * Processors choose which item sequence a view should show. Renderers only look
 * at `item.type`, so a view can emit any subset of the available item types
 * without changing the renderer registry.
 */
export type EventsStreamFeedItem =
  | EventsStreamMessageFeedItem
  | EventsStreamRawEventFeedItem
  | EventsStreamGroupedRawEventFeedItem
  | EventsStreamRawJsonDumpFeedItem
  | EventsStreamLifecycleFeedItem
  | EventsStreamChildStreamCreatedFeedItem
  | EventsStreamMetadataUpdatedFeedItem
  | EventsStreamErrorFeedItem;

/**
 * Reduced view state for an event stream.
 *
 * This intentionally mirrors stream processors such as
 * `apps/agents/src/durable-objects/agent-processor.ts`: events are reduced
 * into small synchronous state first, and rendering consumes that state.
 */
export type EventsStreamViewState = {
  feedItems: EventsStreamFeedItem[];
  activity: EventsStreamActivityState;
};

export type EventsStreamActivityState = {
  currentLlmRequestId: string | null;
};

export type EventsStreamViewProcessor = {
  slug: string;
  initialState: EventsStreamViewState;
  reduce: (args: {
    event: Event;
    state: EventsStreamViewState;
  }) => EventsStreamViewState | undefined;
};

export type EventsStreamMessageFeedItem = {
  type: "message";
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  raw: Event;
};

export type EventsStreamRawEventFeedItem = {
  type: "raw-event";
  id: string;
  streamPath: StreamPath;
  offset: number;
  eventType: string;
  createdAt: string;
  timestamp: number;
  raw: Event;
};

export type EventsStreamGroupedRawEventFeedItem = {
  type: "grouped-raw-event";
  id: string;
  eventType: string;
  count: number;
  events: EventsStreamRawEventFeedItem[];
  firstTimestamp: number;
  lastTimestamp: number;
};

export type EventsStreamRawJsonDumpFeedItem = {
  type: "raw-json-dump";
  id: string;
  events: Event[];
};

export type EventsStreamLifecycleFeedItem = {
  type: "lifecycle";
  id: string;
  label: string;
  timestamp: number;
  raw: Event;
};

export type EventsStreamChildStreamCreatedFeedItem = {
  type: "child-stream-created";
  id: string;
  parentPath: StreamPath;
  childPath: StreamPath;
  timestamp: number;
  raw: Event;
};

export type EventsStreamMetadataUpdatedFeedItem = {
  type: "metadata-updated";
  id: string;
  path: StreamPath;
  metadata: Record<string, unknown>;
  timestamp: number;
  raw: Event;
};

export type EventsStreamErrorFeedItem = {
  type: "error";
  id: string;
  message: string;
  timestamp: number;
  raw: Event;
};

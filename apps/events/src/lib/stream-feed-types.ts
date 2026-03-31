import type { Event, StreamPath } from "@iterate-com/events-contract";

export const streamRendererModes = ["pretty", "raw-pretty", "raw"] as const;
export type StreamRendererMode = (typeof streamRendererModes)[number];
export const DEFAULT_STREAM_RENDERER_MODE: StreamRendererMode = "raw-pretty";
export const streamRendererModeOptions: ReadonlyArray<{
  value: StreamRendererMode;
  label: string;
  description: string;
}> = [
  {
    value: "raw-pretty",
    label: "Raw + Pretty",
    description: "Show semantic cards alongside grouped raw events.",
  },
  {
    value: "pretty",
    label: "Pretty",
    description: "Hide raw event rows and focus on semantic items only.",
  },
  {
    value: "raw",
    label: "Raw",
    description: "Show the full raw event stream as a serialized dump.",
  },
];

export interface ContentBlock {
  type: string;
  text: string;
}

export interface MessageFeedItem {
  kind: "message";
  role: "user" | "assistant";
  content: ContentBlock[];
  timestamp: number;
}

export type ToolState = "pending" | "running" | "completed" | "error";

export interface ToolFeedItem {
  kind: "tool";
  toolCallId: string;
  toolName: string;
  state: ToolState;
  input: unknown;
  output?: unknown;
  errorText?: string;
  startTimestamp: number;
  endTimestamp?: number;
}

export interface ErrorFeedItem {
  kind: "error";
  message: string;
  context?: string;
  stack?: string;
  timestamp: number;
  raw: unknown;
}

export interface EventFeedItem {
  kind: "event";
  path: StreamPath;
  offset: string;
  createdAt: string;
  eventType: string;
  timestamp: number;
  raw: Event;
}

export interface GroupedEventFeedItem {
  kind: "grouped-event";
  eventType: string;
  count: number;
  events: EventFeedItem[];
  firstTimestamp: number;
  lastTimestamp: number;
}

export interface StreamCreatedFeedItem {
  kind: "stream-created";
  parentPath: StreamPath;
  createdPath: StreamPath;
  timestamp: number;
  raw: Event;
}

export interface StreamMetadataUpdatedFeedItem {
  kind: "stream-metadata-updated";
  path: StreamPath;
  metadata: Record<string, unknown>;
  timestamp: number;
  raw: Event;
}

export type StreamFeedItem =
  | MessageFeedItem
  | ToolFeedItem
  | ErrorFeedItem
  | EventFeedItem
  | GroupedEventFeedItem
  | StreamCreatedFeedItem
  | StreamMetadataUpdatedFeedItem;

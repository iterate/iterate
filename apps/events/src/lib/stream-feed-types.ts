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
    description:
      "Keep grouped raw wire rows while interleaving semantic cards at the same cursor—best when you need both fidelity and readability.",
  },
  {
    value: "pretty",
    label: "Pretty",
    description:
      "Hide raw wire rows and show only semantic projections (messages, tools, lifecycle, errors). Use when chunk noise is distracting.",
  },
  {
    value: "raw",
    label: "Raw",
    description:
      "Serialized dump of every event object—copy/paste debugging and exact contract diffs.",
  },
];

export interface ContentBlock {
  type: string;
  text: string;
}

export type MessageStreamStatus = "streaming" | "complete";

export interface MessageFeedItem {
  kind: "message";
  role: "user" | "assistant";
  content: ContentBlock[];
  timestamp: number;
  /** Present for assistant messages reconstructed from agent output chunks. */
  streamStatus?: MessageStreamStatus;
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
  streamPath: StreamPath;
  offset: number;
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

export interface ChildStreamCreatedFeedItem {
  kind: "child-stream-created";
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
  | ChildStreamCreatedFeedItem
  | StreamMetadataUpdatedFeedItem;

import type {
  Event,
  ScheduleInternalExecutionFinishedPayload,
  StreamPath,
  StreamSchedule,
} from "@iterate-com/events-contract";

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

export interface StreamLifecycleFeedItem {
  kind: "stream-lifecycle";
  label: string;
  timestamp: number;
  raw: Event;
}

export interface DynamicWorkerConfiguredFeedItem {
  kind: "dynamic-worker-configured";
  slug: string;
  sourceCode: string;
  compatibilityDate?: string;
  compatibilityFlags: string[];
  outboundGateway?: {
    entrypoint: string;
    secretHeaderName?: string;
    secretHeaderValue?: string;
  };
  timestamp: number;
  raw: Event;
}

export interface StreamPausedFeedItem {
  kind: "stream-paused";
  reason: string;
  timestamp: number;
  raw: Event;
}

export interface StreamResumedFeedItem {
  kind: "stream-resumed";
  reason: string;
  timestamp: number;
  raw: Event;
}

export interface StreamErrorOccurredFeedItem {
  kind: "stream-error-occurred";
  message: string;
  timestamp: number;
  raw: Event;
}

export interface CodemodeBlockFeedItem {
  kind: "codemode-block";
  requestId: string;
  blockId: string;
  language: string;
  code: string;
  timestamp: number;
  raw: Event;
}

export interface CodemodeResultFeedItem {
  kind: "codemode-result";
  requestId: string;
  blockId: string;
  blockCount: number;
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  codePath: string;
  outputPath: string;
  timestamp: number;
  raw: Event;
}

export interface SchedulerControlFeedItem {
  kind: "scheduler-control";
  action: "append-scheduled" | "configured" | "cancelled";
  slug: string;
  schedule?: StreamSchedule;
  append?: unknown;
  callback?: string;
  payloadJson?: string | null;
  nextRunAt?: number;
  timestamp: number;
  raw: Event;
}

export interface SchedulerExecutionFeedItem {
  kind: "scheduler-execution";
  action: "started" | "finished";
  slug: string;
  outcome?: ScheduleInternalExecutionFinishedPayload["outcome"];
  nextRunAt?: number | null;
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
  | StreamMetadataUpdatedFeedItem
  | StreamLifecycleFeedItem
  | DynamicWorkerConfiguredFeedItem
  | StreamPausedFeedItem
  | StreamResumedFeedItem
  | StreamErrorOccurredFeedItem
  | CodemodeBlockFeedItem
  | CodemodeResultFeedItem
  | SchedulerControlFeedItem
  | SchedulerExecutionFeedItem;

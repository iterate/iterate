import { z } from "zod";
import {
  defineProcessorContract,
  getInitialProcessorState,
  runProcessorReduce,
  type StreamEvent,
} from "@iterate-com/shared/streams/stream-processors";
import type { Event, StreamPath } from "@iterate-com/shared/streams/types";
import type {
  EventsStreamActivityState,
  EventsStreamBuiltInElement,
  EventsStreamGroupedRawEventElement,
  EventsStreamRawEventSummary,
  EventsStreamRegisteredProcessor,
  EventsStreamViewState,
} from "../feed-items.ts";

const MAX_SAME_TYPE_RAW_GROUP = 50_000;

const STREAM_PROCESSOR_REGISTERED_TYPE = "events.iterate.com/core/stream-processor-registered";
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
const STREAM_CHILD_STREAM_CREATED_TYPE = "events.iterate.com/core/child-stream-created";
const STREAM_DURABLE_OBJECT_WOKE_UP_TYPE = "events.iterate.com/core/durable-object-woke-up";
const STREAM_ERROR_OCCURRED_TYPE = "events.iterate.com/core/error-occurred";
const STREAM_METADATA_UPDATED_TYPE = "events.iterate.com/core/metadata-updated";

const HIDDEN_FEED_EVENT_TYPES = new Set<string>([AGENT_OUTPUT_ADDED_TYPE]);

const StreamPathSchema = z.string().trim().min(1);

function createInitialStreamViewState(): EventsStreamViewState {
  return {
    slots: { header: [], feed: [], input: [] },
    activity: {
      eventCount: 0,
      currentLlmRequestId: null,
      latestStreamError: null,
      registeredProcessors: [],
    },
  };
}

/**
 * Zod schema for the stream view processor state.
 *
 * Uses `z.custom` because the state contains discriminated union element types
 * that are only meaningful to TypeScript. The processor state is produced
 * exclusively by the reducer — it is never deserialized from external storage.
 */
const StreamViewStateSchema = z
  .custom<EventsStreamViewState>((val) => val != null && typeof val === "object")
  .default(createInitialStreamViewState);

const StreamViewProcessorContractBase = defineProcessorContract({
  slug: "stream-view",
  version: "0.1.0",
  description:
    "Browser-side processor that projects raw stream events into a mode-agnostic renderable view state with feed elements, activity indicators, and slot derivation.",
  stateSchema: StreamViewStateSchema,
  events: {
    "events.iterate.com/stream-view/any-event": {
      description: "Synthetic catch-all to satisfy the consumes type constraint.",
      payloadSchema: z.unknown(),
    },
  },
  consumes: ["events.iterate.com/stream-view/any-event"],
  emits: [],
  reduce({ state, event: consumedEvent }) {
    // consumesAllEvents delivers every stream event here regardless of type.
    // The consumed event type is narrowed to the synthetic "any-event" literal,
    // so we cast to the base Event shape for runtime property access.
    const event = consumedEvent as unknown as Event;

    const activity = reduceActivityState({ event, state });

    if (HIDDEN_FEED_EVENT_TYPES.has(event.type)) {
      return deriveSlots({ feed: state.slots.feed, activity });
    }

    const feedItems = appendFeedItems({
      feedItems: state.slots.feed,
      nextItems: reduceEventToRawPrettyFeedItems(event),
    });

    return deriveSlots({ feed: feedItems, activity });
  },
});

/**
 * Stream view processor contract.
 *
 * This processor consumes ALL events on a stream (via `consumesAllEvents`)
 * and accumulates a mode-agnostic view state. It always produces both raw
 * summary elements and semantic elements for every event, so renderer modes
 * (raw-pretty, pretty, raw-single-json) become pure view-time filters.
 *
 * Define with `defineProcessorContract` + `consumesAllEvents` following the
 * same pattern as `JsonataReactorProcessorContract`.
 */
export const StreamViewProcessorContract = Object.assign(StreamViewProcessorContractBase, {
  consumesAllEvents: true as const,
});

export type StreamViewState = EventsStreamViewState;

/**
 * Batch-reduce a list of events into stream view state.
 *
 * This is the simple all-at-once entry point for consumers that already have a
 * full event list (e.g. from a query). For incremental SSE-driven processing,
 * use `runProcessorReduce` directly with a ref as `apps/os` does.
 */
export function reduceStreamViewEvents(events: readonly Event[]): EventsStreamViewState {
  const processor = { contract: StreamViewProcessorContract };
  let state = getInitialProcessorState(StreamViewProcessorContract);
  for (const event of events) {
    const reduction = runProcessorReduce({
      processor,
      event: event as unknown as StreamEvent,
      state,
    });
    state = reduction?.state ?? state;
  }
  return state;
}

// ---------------------------------------------------------------------------
// Slot derivation
// ---------------------------------------------------------------------------

function deriveSlots(args: {
  feed: EventsStreamBuiltInElement[];
  activity: EventsStreamActivityState;
}): EventsStreamViewState {
  return {
    slots: {
      header: createHeaderSlotElements(args.activity),
      feed: args.feed,
      input: createInputSlotElements(args.activity),
    },
    activity: args.activity,
  };
}

function createHeaderSlotElements(
  activity: EventsStreamActivityState,
): EventsStreamBuiltInElement[] {
  const elements: EventsStreamBuiltInElement[] = [];

  if (activity.eventCount > 0) {
    elements.push({
      type: "event-counter",
      id: "event-counter",
      props: { count: activity.eventCount },
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
  activity: EventsStreamActivityState,
): EventsStreamBuiltInElement[] {
  if (activity.latestStreamError == null) return [];

  const text = `Can you help debug this stream error?\n\n${activity.latestStreamError.message}`;
  return [
    {
      type: "composer-suggestion",
      id: `composer-suggestion-stream-error-${activity.latestStreamError.offset}`,
      props: {
        label: "Ask agent to debug this error",
        text,
        action: { type: "prefill-agent-message", text },
        sourceOffset: activity.latestStreamError.offset,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Activity state
// ---------------------------------------------------------------------------

function reduceActivityState(args: {
  event: Event;
  state: EventsStreamViewState;
}): EventsStreamActivityState {
  const activity: EventsStreamActivityState = {
    ...args.state.activity,
    eventCount: args.state.activity.eventCount + 1,
  };

  if (args.event.type === STREAM_PROCESSOR_REGISTERED_TYPE) {
    const payload = readPayloadRecord(args.event);
    if (payload != null) {
      const processor = readRegisteredProcessor(payload);
      if (processor != null) {
        const existing = activity.registeredProcessors.find((p) => p.slug === processor.slug);
        return {
          ...activity,
          registeredProcessors: existing
            ? activity.registeredProcessors.map((p) => (p.slug === processor.slug ? processor : p))
            : [...activity.registeredProcessors, processor],
        };
      }
    }
  }

  if (args.event.type === STREAM_ERROR_OCCURRED_TYPE) {
    return {
      ...activity,
      latestStreamError: {
        message: readStringPayloadField(args.event, "message") ?? "Stream error",
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

  if (requestId == null && llmRequestId == null) return activity;

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

// ---------------------------------------------------------------------------
// Feed item production
// ---------------------------------------------------------------------------

function reduceEventToRawPrettyFeedItems(event: Event): EventsStreamBuiltInElement[] {
  return [toRawEventFeedItem(event), ...reduceEventToSemanticFeedItems(event)];
}

function appendFeedItems(args: {
  feedItems: EventsStreamBuiltInElement[];
  nextItems: readonly EventsStreamBuiltInElement[];
}): EventsStreamBuiltInElement[] {
  if (args.nextItems.length === 0) return args.feedItems;

  const feedItems = [...args.feedItems];
  const canGroup = args.nextItems.length === 1 && args.nextItems[0]?.type === "grouped-raw-event";

  for (const item of args.nextItems) {
    if (!canGroup) {
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
          llmRequestPolicy: readLlmRequestPolicy(event),
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
        props: { text: systemPrompt, timestamp, raw: event },
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
        props: { text: content, timestamp, raw: event },
      },
    ];
  }

  if (event.type === AGENT_LLM_REQUEST_REQUESTED_TYPE) {
    return [
      {
        type: "llm-request-boundary",
        id: `llm-request-requested-${event.offset}`,
        props: { phase: "started", requestId: String(event.offset), timestamp, raw: event },
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
          outcome: event.type === AGENT_LLM_REQUEST_COMPLETED_TYPE ? "completed" : "cancelled",
          requestId,
          timestamp,
          raw: event,
        },
      },
    ];
  }

  if (event.type === "events.iterate.com/agents/user-message-received") {
    const content = readStringPayloadField(event, "content");
    if (content == null) return [];
    return [
      {
        type: "message",
        id: `message-user-${event.offset}`,
        props: { role: "user", text: content, timestamp, raw: event },
      },
    ];
  }

  if (
    event.type === "events.iterate.com/agents/web-message-sent" ||
    event.type === "events.iterate.com/agents/tui-message-sent"
  ) {
    const message = readStringPayloadField(event, "message");
    if (message == null) return [];
    return [
      {
        type: "message",
        id: `message-assistant-${event.offset}`,
        props: { role: "assistant", text: message, format: "markdown", timestamp, raw: event },
      },
    ];
  }

  if (event.type === STREAM_DURABLE_OBJECT_WOKE_UP_TYPE) {
    return [
      {
        type: "lifecycle",
        id: `lifecycle-woke-up-${event.offset}`,
        props: { label: "Durable object woke up", timestamp, raw: event },
      },
    ];
  }

  if (event.type === STREAM_CHILD_STREAM_CREATED_TYPE) {
    const childPath = readStringPayloadField(event, "childPath");
    if (childPath == null) return [];
    const parsedChildPath = StreamPathSchema.safeParse(childPath);
    if (!parsedChildPath.success) return [];
    return [
      {
        type: "child-stream-created",
        id: `child-stream-created-${event.offset}`,
        props: {
          parentPath: event.streamPath as StreamPath,
          childPath: parsedChildPath.data as StreamPath,
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
        props: { path: event.streamPath as StreamPath, metadata, timestamp, raw: event },
      },
    ];
  }

  if (event.type === STREAM_ERROR_OCCURRED_TYPE) {
    return [
      {
        type: "error",
        id: `error-${event.offset}`,
        props: {
          message: readStringPayloadField(event, "message") ?? "Stream error",
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
        props: { script, language: "javascript", timestamp, raw: event },
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
        props: { script: code, language: "javascript", timestamp, raw: event },
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

  return [];
}

// ---------------------------------------------------------------------------
// Raw event helpers
// ---------------------------------------------------------------------------

function toRawEventFeedItem(event: Event): EventsStreamGroupedRawEventElement {
  return createRawEventGroup([toRawEventSummary(event)]);
}

function toRawEventSummary(event: Event): EventsStreamRawEventSummary {
  return {
    streamPath: event.streamPath as StreamPath,
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
  const firstEvent = events[0]!;
  const lastEvent = events[events.length - 1]!;

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

// ---------------------------------------------------------------------------
// Payload readers
// ---------------------------------------------------------------------------

function readStringPayloadField(event: Event, key: string) {
  const value = readPayloadRecord(event)?.[key];
  return typeof value === "string" ? value : null;
}

function readNumberPayloadField(event: Event, key: string) {
  const value = readPayloadRecord(event)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readRecordPayloadField(event: Event, key: string): Record<string, unknown> | null {
  const value = readPayloadRecord(event)?.[key];
  return isRecord(value) ? value : null;
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

function readLlmRequestPolicy(event: Event) {
  const policy = readRecordPayloadField(event, "llmRequestPolicy");
  if (policy == null) return { behaviour: "after-current-request" as const };

  switch (policy.behaviour) {
    case "dont-trigger-request":
    case "interrupt-current-request":
    case "after-current-request":
      return { behaviour: policy.behaviour };
    default:
      return { behaviour: "after-current-request" as const };
  }
}

function readRegisteredProcessor(
  payload: Record<string, unknown>,
): EventsStreamRegisteredProcessor | null {
  const slug = typeof payload.slug === "string" ? payload.slug : null;
  const version = typeof payload.version === "string" ? payload.version : null;
  const description = typeof payload.description === "string" ? payload.description : "";
  const ownedEvents = Array.isArray(payload.ownedEvents) ? payload.ownedEvents : null;
  if (slug == null || version == null || ownedEvents == null) return null;

  return {
    slug,
    version,
    description,
    ownedEvents: ownedEvents
      .filter((e): e is Record<string, unknown> => isRecord(e) && typeof e.type === "string")
      .map((e) => ({
        type: e.type as string,
        ...(typeof e.description === "string" ? { description: e.description } : {}),
        ...(Array.isArray(e.examples) && e.examples.length > 0
          ? {
              examples: e.examples.filter(
                (ex): ex is { description: string; payload: unknown } =>
                  isRecord(ex) && typeof ex.description === "string",
              ),
            }
          : {}),
      })),
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function getTimestamp(createdAt: string) {
  return Date.parse(createdAt);
}

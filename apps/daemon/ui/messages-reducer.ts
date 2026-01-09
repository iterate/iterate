/**
 * Pure reducer for transforming Pi agent events into a unified feed.
 * This module has no side effects and can be easily unit tested.
 *
 * Events come in two forms:
 * 1. Action events: { type: "iterate:agent:harness:pi:action:...", payload: {...} }
 * 2. Pi SDK events wrapped: { type: "iterate:agent:harness:pi:event-received", payload: { piEventType: "...", piEvent: {...} } }
 *
 * The feed shows full event types for UI consistency, but the reducer extracts
 * the inner piEvent when processing messages.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

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

export interface EventFeedItem {
  kind: "event";
  eventType: string;
  timestamp: number;
  raw: unknown;
}

export type FeedItem = MessageFeedItem | EventFeedItem;

export interface MessagesState {
  feed: FeedItem[];
  isStreaming: boolean;
  streamingMessage?: MessageFeedItem;
  rawEvents: unknown[];
  processedEventCount: number;
}

const PI_EVENT_RECEIVED = "iterate:agent:harness:pi:event-received";

// ─────────────────────────────────────────────────────────────────────────────
// Initial State
// ─────────────────────────────────────────────────────────────────────────────

export function createInitialState(): MessagesState {
  return {
    feed: [],
    isStreaming: false,
    streamingMessage: undefined,
    rawEvents: [],
    processedEventCount: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getTimestamp(e: Record<string, unknown>): number {
  if (typeof e.createdAt === "string") {
    const parsed = Date.parse(e.createdAt);
    if (!isNaN(parsed)) return parsed;
  }
  if (typeof e.timestamp === "number") return e.timestamp;
  if (typeof e.timestamp === "string") {
    const parsed = Date.parse(e.timestamp);
    if (!isNaN(parsed)) return parsed;
  }
  return Date.now();
}

function createMessageItem(
  role: "user" | "assistant",
  content: ContentBlock[],
  timestamp: number,
): MessageFeedItem {
  return { kind: "message", role, content, timestamp };
}

function createEventItem(eventType: string, timestamp: number, raw: unknown): EventFeedItem {
  return { kind: "event", eventType, timestamp, raw };
}

/**
 * Extract the inner Pi event from a wrapped event envelope.
 * Returns the piEvent if this is a PI_EVENT_RECEIVED, otherwise null.
 */
function extractPiEvent(e: Record<string, unknown>): Record<string, unknown> | null {
  if (e.type !== PI_EVENT_RECEIVED) return null;
  const payload = e.payload as { piEvent?: unknown } | undefined;
  if (payload?.piEvent && typeof payload.piEvent === "object") {
    return payload.piEvent as Record<string, unknown>;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reducer
// ─────────────────────────────────────────────────────────────────────────────

export function messagesReducer(state: MessagesState, event: unknown): MessagesState {
  const e = event as Record<string, unknown>;
  const rawEvents = [...state.rawEvents, event];
  const timestamp = getTimestamp(e);
  const eventType = typeof e.type === "string" ? e.type : "unknown";

  // For Pi events, extract the inner event to process message content
  const piEvent = extractPiEvent(e);
  const piEventType = piEvent?.type as string | undefined;

  // Handle Pi SDK events (wrapped in event-received envelope)
  if (piEvent) {
    // agent_end signals the end of a turn - just stop streaming
    if (piEventType === "agent_end") {
      return {
        ...state,
        feed: [...state.feed, createEventItem(eventType, timestamp, event)],
        isStreaming: false,
        streamingMessage: undefined,
        rawEvents,
      };
    }

    if (piEventType === "message_start") {
      const msg = piEvent.message as
        | { role?: string; content?: ContentBlock[]; timestamp?: number }
        | undefined;
      if (msg?.role === "assistant") {
        return {
          ...state,
          feed: [...state.feed, createEventItem(eventType, timestamp, event)],
          isStreaming: true,
          streamingMessage: createMessageItem("assistant", [], msg.timestamp ?? timestamp),
          rawEvents,
        };
      }
      return {
        ...state,
        feed: [...state.feed, createEventItem(eventType, timestamp, event)],
        rawEvents,
      };
    }

    // message_update is a streaming chunk - don't add to feed, just update streaming state
    if (piEventType === "message_update") {
      const assistantEvent = piEvent.assistantMessageEvent as Record<string, unknown> | undefined;
      if (!assistantEvent) return { ...state, rawEvents };

      const partial = assistantEvent.partial as
        | { content?: unknown[]; timestamp?: number }
        | undefined;
      if (partial) {
        const content: ContentBlock[] = Array.isArray(partial.content)
          ? partial.content.map((c: unknown) => {
              const block = c as Record<string, unknown>;
              return {
                type: (block.type as string) || "text",
                text: (block.text as string) || "",
              };
            })
          : [];

        return {
          ...state,
          isStreaming: true,
          streamingMessage: createMessageItem("assistant", content, partial.timestamp ?? timestamp),
          rawEvents,
        };
      }
      return { ...state, rawEvents };
    }

    if (piEventType === "message_end") {
      const msg = piEvent.message as
        | { role?: string; content?: unknown[]; timestamp?: number }
        | undefined;
      if ((msg?.role === "assistant" || msg?.role === "user") && Array.isArray(msg.content)) {
        const content: ContentBlock[] = msg.content
          .filter((c: unknown) => (c as Record<string, unknown>).type === "text")
          .map((c: unknown) => {
            const block = c as Record<string, unknown>;
            return {
              type: "text",
              text: (block.text as string) || "",
            };
          });

        const newFeedItems: FeedItem[] = [createEventItem(eventType, timestamp, event)];
        if (content.some((c) => c.text.trim())) {
          newFeedItems.push(createMessageItem(msg.role, content, msg.timestamp ?? timestamp));
        }

        return {
          ...state,
          feed: [...state.feed, ...newFeedItems],
          isStreaming: msg.role === "assistant" ? false : state.isStreaming,
          streamingMessage: msg.role === "assistant" ? undefined : state.streamingMessage,
          rawEvents,
        };
      }
      return {
        ...state,
        feed: [...state.feed, createEventItem(eventType, timestamp, event)],
        isStreaming: false,
        streamingMessage: undefined,
        rawEvents,
      };
    }

    if (piEventType === "turn_end") {
      return {
        ...state,
        feed: [...state.feed, createEventItem(eventType, timestamp, event)],
        isStreaming: false,
        streamingMessage: undefined,
        rawEvents,
      };
    }

    // Other Pi events (turn_start, agent_start, tool events, etc.)
    return {
      ...state,
      feed: [...state.feed, createEventItem(eventType, timestamp, event)],
      rawEvents,
    };
  }

  // Non-Pi events (action events like prompt, session-create, etc.)
  // Just add them as event feed items
  return {
    ...state,
    feed: [...state.feed, createEventItem(eventType, timestamp, event)],
    rawEvents,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Reduce all events from a stream
// ─────────────────────────────────────────────────────────────────────────────

export function reduceEvents(events: unknown[]): MessagesState {
  return events.reduce(messagesReducer, createInitialState());
}

export function getMessages(state: MessagesState): MessageFeedItem[] {
  return state.feed.filter((item): item is MessageFeedItem => item.kind === "message");
}

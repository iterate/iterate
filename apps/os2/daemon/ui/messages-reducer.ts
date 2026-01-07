/**
 * Pure reducer for transforming Pi agent events into a unified feed.
 * This module has no side effects and can be easily unit tested.
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
  messages: MessageFeedItem[];
  isStreaming: boolean;
  streamingMessage?: MessageFeedItem;
  rawEvents: unknown[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Initial State
// ─────────────────────────────────────────────────────────────────────────────

export function createInitialState(): MessagesState {
  return {
    feed: [],
    messages: [],
    isStreaming: false,
    streamingMessage: undefined,
    rawEvents: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getTimestamp(e: Record<string, unknown>): number {
  return typeof e.timestamp === "number" ? e.timestamp : Date.now();
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

function hasDuplicateMessage(feed: FeedItem[], role: "user" | "assistant", text: string): boolean {
  return feed.some(
    (item) =>
      item.kind === "message" && item.role === role && item.content.some((c) => c.text === text),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Reducer
// ─────────────────────────────────────────────────────────────────────────────

export function messagesReducer(state: MessagesState, event: unknown): MessagesState {
  const e = event as Record<string, unknown>;
  const rawEvents = [...state.rawEvents, event];
  const timestamp = getTimestamp(e);

  // Historical/stored events (legacy format)
  if (e.type === "user_prompt") {
    const text = typeof e.text === "string" ? e.text : "";
    if (hasDuplicateMessage(state.feed, "user", text)) {
      return { ...state, rawEvents };
    }
    return {
      ...state,
      feed: [...state.feed, createMessageItem("user", [{ type: "text", text }], timestamp)],
      rawEvents,
    };
  }

  if (e.type === "assistant_text") {
    const text = typeof e.text === "string" ? e.text : "";
    if (hasDuplicateMessage(state.feed, "assistant", text)) {
      return { ...state, rawEvents };
    }
    return {
      ...state,
      feed: [...state.feed, createMessageItem("assistant", [{ type: "text", text }], timestamp)],
      rawEvents,
    };
  }

  // agent_end signals the end of a turn - just stop streaming
  // Note: agent_end.messages only contains the CURRENT turn, not full history
  // so we don't use it to replace messages
  if (e.type === "agent_end") {
    return { ...state, isStreaming: false, streamingMessage: undefined, rawEvents };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Pi streaming events (forwarded directly from AgentSession)
  // ─────────────────────────────────────────────────────────────────────────────

  if (e.type === "message_start") {
    const msg = e.message as
      | { role?: string; content?: ContentBlock[]; timestamp?: number }
      | undefined;
    if (msg?.role === "assistant") {
      // Start streaming an assistant message
      return {
        ...state,
        isStreaming: true,
        streamingMessage: createMessageItem("assistant", [], msg.timestamp ?? timestamp),
        rawEvents,
      };
    }
    if (msg?.role === "user" && Array.isArray(msg.content)) {
      // User message - add to feed immediately
      const userText = msg.content.find((c) => c.type === "text")?.text || "";
      if (hasDuplicateMessage(state.feed, "user", userText)) {
        return { ...state, rawEvents };
      }
      return {
        ...state,
        feed: [...state.feed, createMessageItem("user", msg.content, msg.timestamp ?? timestamp)],
        rawEvents,
      };
    }
    return { ...state, rawEvents };
  }

  if (e.type === "message_update") {
    const assistantEvent = e.assistantMessageEvent as Record<string, unknown> | undefined;
    if (!assistantEvent) return { ...state, rawEvents };

    // Extract the partial message from the event
    const partial = assistantEvent.partial as
      | { content?: unknown[]; timestamp?: number }
      | undefined;
    if (partial) {
      // Use the partial content which accumulates text as it streams
      const content: ContentBlock[] = Array.isArray(partial.content)
        ? partial.content.map((c: any) => ({
            type: c.type || "text",
            text: c.text || "",
          }))
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

  if (e.type === "message_end") {
    const msg = e.message as { role?: string; content?: unknown[]; timestamp?: number } | undefined;
    if (msg?.role === "assistant" && Array.isArray(msg.content)) {
      // Finalize the assistant message - move from streaming to feed
      const content: ContentBlock[] = msg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => ({
          type: "text",
          text: c.text || "",
        }));

      // Only add if there's actual text content
      if (content.some((c) => c.text.trim())) {
        return {
          ...state,
          feed: [
            ...state.feed,
            createMessageItem("assistant", content, msg.timestamp ?? timestamp),
          ],
          isStreaming: false,
          streamingMessage: undefined,
          rawEvents,
        };
      }
    }
    // For user message_end or empty messages, just stop streaming
    return { ...state, isStreaming: false, streamingMessage: undefined, rawEvents };
  }

  if (e.type === "turn_end") {
    return { ...state, isStreaming: false, streamingMessage: undefined, rawEvents };
  }

  // Pass through other events (turn_start, agent_start, tool events, etc.)
  // Add them as event feed items to display in the UI
  const eventType = typeof e.type === "string" ? e.type : "unknown";

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

/**
 * Pure reducer for transforming Pi agent events into chat messages.
 * This module has no side effects and can be easily unit tested.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ContentBlock {
  type: string
  text: string
}

export interface ChatMessage {
  role: "user" | "assistant"
  content: ContentBlock[]
  timestamp?: number
}

export interface MessagesState {
  messages: ChatMessage[]
  isStreaming: boolean
  streamingMessage?: ChatMessage
  rawEvents: unknown[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Initial State
// ─────────────────────────────────────────────────────────────────────────────

export function createInitialState(): MessagesState {
  return {
    messages: [],
    isStreaming: false,
    streamingMessage: undefined,
    rawEvents: [],
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reducer
// ─────────────────────────────────────────────────────────────────────────────

export function messagesReducer(state: MessagesState, event: unknown): MessagesState {
  const e = event as Record<string, unknown>
  const rawEvents = [...state.rawEvents, event]

  // Historical/stored events (legacy format)
  if (e.type === "user_prompt") {
    const text = typeof e.text === "string" ? e.text : ""
    if (state.messages.some((m) => m.role === "user" && m.content.some((c) => c.text === text))) {
      return { ...state, rawEvents }
    }
    return {
      ...state,
      messages: [...state.messages, { role: "user", content: [{ type: "text", text }] }],
      rawEvents,
    }
  }

  if (e.type === "assistant_text") {
    const text = typeof e.text === "string" ? e.text : ""
    if (state.messages.some((m) => m.role === "assistant" && m.content.some((c) => c.text === text))) {
      return { ...state, rawEvents }
    }
    return {
      ...state,
      messages: [...state.messages, { role: "assistant", content: [{ type: "text", text }] }],
      rawEvents,
    }
  }

  // agent_end signals the end of a turn - just stop streaming
  // Note: agent_end.messages only contains the CURRENT turn, not full history
  // so we don't use it to replace messages
  if (e.type === "agent_end") {
    return { ...state, isStreaming: false, streamingMessage: undefined, rawEvents }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Pi streaming events (forwarded directly from AgentSession)
  // ─────────────────────────────────────────────────────────────────────────────

  if (e.type === "message_start") {
    const msg = e.message as ChatMessage | undefined
    if (msg?.role === "assistant") {
      // Start streaming an assistant message
      return {
        ...state,
        isStreaming: true,
        streamingMessage: { role: "assistant", content: [], timestamp: msg.timestamp },
        rawEvents,
      }
    }
    if (msg?.role === "user" && Array.isArray(msg.content)) {
      // User message - add to messages immediately
      const userText = msg.content.find((c) => c.type === "text")?.text || ""
      if (state.messages.some((m) => m.role === "user" && m.content.some((c) => c.text === userText))) {
        return { ...state, rawEvents }
      }
      return {
        ...state,
        messages: [...state.messages, { role: "user", content: msg.content, timestamp: msg.timestamp }],
        rawEvents,
      }
    }
    return { ...state, rawEvents }
  }

  if (e.type === "message_update") {
    const assistantEvent = e.assistantMessageEvent as Record<string, unknown> | undefined
    if (!assistantEvent) return { ...state, rawEvents }

    // Extract the partial message from the event
    const partial = assistantEvent.partial as ChatMessage | undefined
    if (partial) {
      // Use the partial content which accumulates text as it streams
      const content: ContentBlock[] = Array.isArray(partial.content)
        ? partial.content.map((c: any) => ({
            type: c.type || "text",
            text: c.text || "",
          }))
        : []

      return {
        ...state,
        isStreaming: true,
        streamingMessage: {
          role: "assistant",
          content,
          timestamp: partial.timestamp,
        },
        rawEvents,
      }
    }
    return { ...state, rawEvents }
  }

  if (e.type === "message_end") {
    const msg = e.message as ChatMessage | undefined
    if (msg?.role === "assistant" && Array.isArray(msg.content)) {
      // Finalize the assistant message - move from streaming to messages
      const content: ContentBlock[] = msg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => ({
          type: "text",
          text: c.text || "",
        }))

      // Only add if there's actual text content
      if (content.some((c) => c.text.trim())) {
        return {
          ...state,
          messages: [...state.messages, { role: "assistant", content, timestamp: msg.timestamp }],
          isStreaming: false,
          streamingMessage: undefined,
          rawEvents,
        }
      }
    }
    // For user message_end or empty messages, just stop streaming
    return { ...state, isStreaming: false, streamingMessage: undefined, rawEvents }
  }

  if (e.type === "turn_end") {
    return { ...state, isStreaming: false, streamingMessage: undefined, rawEvents }
  }

  // Pass through other events (turn_start, agent_start, tool events, etc.)
  return { ...state, rawEvents }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Reduce all events from a stream
// ─────────────────────────────────────────────────────────────────────────────

export function reduceEvents(events: unknown[]): MessagesState {
  return events.reduce(messagesReducer, createInitialState())
}

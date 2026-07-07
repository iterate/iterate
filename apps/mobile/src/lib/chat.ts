// Pure chat logic: reduce an agent stream's events into what the thread
// screen renders. Deliberately tiny — the mobile v1 shows only the two
// visible-message event types plus a derived "working…" flag, not the web's
// full activity feed (packages/ui/src/components/events/agent-ui-reducer.ts).

import type { StreamEvent } from "../../../os/src/types.ts";

export const USER_MESSAGE_TYPE = "events.iterate.com/agents/user-message-received";
export const ASSISTANT_MESSAGE_TYPE = "events.iterate.com/agents/web-message-sent";

export type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  offset: number;
  createdAt: string;
};

export type ChatThread = {
  messages: ChatMessage[];
  /**
   * True while the agent owes a visible reply: a user message is newer than
   * every assistant message. Long code-running turns stay in this state, which
   * is exactly when a silent screen would read as broken.
   */
  working: boolean;
  /** Highest offset seen, including non-message events. 0 for an empty thread. */
  maxOffset: number;
};

export function reduceChatEvents(events: StreamEvent[]): ChatThread {
  const messages: ChatMessage[] = [];
  let lastUserOffset = 0;
  let lastAssistantOffset = 0;
  let maxOffset = 0;
  for (const event of events) {
    maxOffset = Math.max(maxOffset, event.offset);
    if (event.type === USER_MESSAGE_TYPE) {
      lastUserOffset = event.offset;
      messages.push({
        role: "user",
        text: String(event.payload?.content ?? ""),
        offset: event.offset,
        createdAt: event.createdAt,
      });
    } else if (event.type === ASSISTANT_MESSAGE_TYPE) {
      lastAssistantOffset = event.offset;
      messages.push({
        role: "assistant",
        text: String(event.payload?.message ?? ""),
        offset: event.offset,
        createdAt: event.createdAt,
      });
    }
  }
  return { messages, working: lastUserOffset > lastAssistantOffset, maxOffset };
}

/**
 * Merge a live batch into the events already held, deduping by offset (a
 * replayAfterOffset subscription can overlap the initial page read) and
 * keeping offset order.
 */
export function mergeEventsByOffset(
  existing: StreamEvent[],
  incoming: StreamEvent[],
): StreamEvent[] {
  if (incoming.length === 0) return existing;
  const byOffset = new Map<number, StreamEvent>();
  for (const event of existing) byOffset.set(event.offset, event);
  for (const event of incoming) byOffset.set(event.offset, event);
  return [...byOffset.values()].sort((a, b) => a.offset - b.offset);
}

/** Same convention as the dashboard's new-chat page: timestamp → path slug. */
export function slugifyCreationTime(date: Date): string {
  return date
    .toISOString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Phone-started chats get their own channel segment, like the web's
 * `/agents/web/...` and Slack's `/agents/slack/...` — provenance at creation
 * time only; any channel's agent can be opened and continued from anywhere.
 */
export function newMobileAgentPath(date: Date): string {
  return `/agents/mobile/${slugifyCreationTime(date)}`;
}

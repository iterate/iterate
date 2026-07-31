// Pure chat logic: reduce an agent stream's events into what the thread
// screen renders. Deliberately tiny — the mobile v1 shows only the two
// visible-message event types plus a derived "working…" flag, not the web's
// full activity feed (packages/ui/src/components/events/agent-ui-reducer.ts).

import type { StreamEvent } from "iterate/sdk/itx/react";

// User messages travel as a context-added event with role "user" (the single
// inbound door every caller — web, Slack, mobile — now shares); there is no
// dedicated "user message" event type anymore.
export const USER_MESSAGE_TYPE = "events.iterate.com/agents/context-added";
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
    if (event.type === USER_MESSAGE_TYPE && event.payload?.role === "user") {
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

// The agent-maintained status vocabulary (AGENT_SUMMARY_INSTRUCTION in
// apps/os/src/domains/agents/agent-defaults.ts): partial updates where an
// omitted field is preserved and an explicit null clears — the same
// semantics the dashboard's summary projections fold.
export const SUMMARY_UPDATED_TYPE = "events.iterate.com/agent/summary-updated";
export const SCRIPT_RUN_SETTLED_TYPE = "events.iterate.com/capability-host/script-run-settled";

/**
 * The thread's agent-maintained status as of one script run: summary-updated
 * events folded through the run's own settlement. A status the script sets
 * just before its held fetch counts (it lands AFTER the run-requested
 * offset); a later turn's status (after this run settled) does not; an
 * unsettled run has no upper bound — whatever status it is writing is still
 * its own. Null when no status field was ever set: statusless threads get no
 * context line at all, deliberately.
 */
export function threadContextForScriptRun(
  events: StreamEvent[],
  run: { executionId: string },
): { title: string | null; activity: string | null } | null {
  const ordered = [...events].sort((a, b) => a.offset - b.offset);
  const settle = ordered.find(
    (event) =>
      event.type === SCRIPT_RUN_SETTLED_TYPE &&
      (event.payload as { executionId?: string } | undefined)?.executionId === run.executionId,
  );
  const statusBound = settle === undefined ? Infinity : settle.offset;
  let title: string | null = null;
  let activity: string | null = null;
  for (const event of ordered) {
    if (event.type !== SUMMARY_UPDATED_TYPE || event.offset > statusBound) continue;
    const payload = (event.payload || {}) as { title?: string | null; activity?: string | null };
    if (payload.title !== undefined) title = payload.title || null;
    if (payload.activity !== undefined) activity = payload.activity || null;
  }
  return title !== null || activity !== null ? { title, activity } : null;
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

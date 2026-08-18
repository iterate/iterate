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

/**
 * The send RPC can acknowledge its context append before the live feed sees
 * the agent's next durable activity fact. Keep the local working indicator
 * across that handoff so the UI never presents an idle gap for accepted work.
 */
export function awaitingAgentActivity(events: StreamEvent[], sentMessageOffset: number): boolean {
  return !events.some(
    (event) =>
      event.offset > sentMessageOffset &&
      (event.type === "events.iterate.com/capability-host/script-run-requested" ||
        event.type === "events.iterate.com/agent/llm-request-requested" ||
        event.type === ASSISTANT_MESSAGE_TYPE ||
        event.type === "events.iterate.com/stream/error-occurred" ||
        event.type === "events.iterate.com/agent/paused"),
  );
}

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
 * its own. A null status means no field was ever set: statusless runs get no
 * context line at all, deliberately.
 *
 * `settled` is the caller's caching contract: once the run's own settle
 * event is in view the fold window is closed and the result — status OR
 * null — is immutable. Until then the result is provisional: agents
 * Promise.all the status append with the work itself, so a held approval
 * can be observed (and this fold computed) before the status lands.
 */
export function threadContextForScriptRun(
  events: StreamEvent[],
  run: { executionId: string },
): {
  settled: boolean;
  status: { title: string | null; activity: string | null } | null;
} {
  // StreamEvent.payload is over-the-wire JSON (`any`): the event-type
  // discriminator selects the vocabulary, but TypeScript cannot narrow
  // payload from `type`, so both reads below cast to the field subset they
  // touch and runtime-guard each field — the same pattern as
  // approvals.ts's indexApprovalEvents at this boundary.
  const ordered = [...events].sort((a, b) => a.offset - b.offset);
  const settle = ordered.find(
    (event) =>
      event.type === SCRIPT_RUN_SETTLED_TYPE &&
      // Equality against the known executionId makes a malformed payload
      // harmless: it simply never matches, leaving the fold unbounded.
      (event.payload as { executionId?: string } | undefined)?.executionId === run.executionId,
  );
  const statusBound = settle === undefined ? Infinity : settle.offset;
  let title: string | null = null;
  let activity: string | null = null;
  for (const event of ordered) {
    if (event.type !== SUMMARY_UPDATED_TYPE || event.offset > statusBound) continue;
    const payload = (event.payload || {}) as { title?: unknown; activity?: unknown };
    // Per field: a string sets ("" clears via ||), an explicit null clears,
    // anything else — absent or malformed — preserves the standing value.
    if (typeof payload.title === "string" || payload.title === null) title = payload.title || null;
    if (typeof payload.activity === "string" || payload.activity === null) {
      activity = payload.activity || null;
    }
  }
  return {
    settled: settle !== undefined,
    status: title !== null || activity !== null ? { title, activity } : null,
  };
}

/**
 * The chat's current agent-set title: the standing `title` after folding
 * every summary-updated event in offset order (string sets, "" or explicit
 * null clears, absent preserves — the same per-field semantics as
 * threadContextForScriptRun, but over the whole stream). Null until the
 * agent's first-turn summary lands; callers fall back to the path.
 */
export function latestAgentTitle(events: StreamEvent[]): string | null {
  let title: string | null = null;
  for (const event of [...events].sort((a, b) => a.offset - b.offset)) {
    if (event.type !== SUMMARY_UPDATED_TYPE) continue;
    const payload = (event.payload || {}) as { title?: unknown };
    if (typeof payload.title === "string" || payload.title === null) title = payload.title || null;
  }
  return title;
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

// Full agent feed for the thread screen: the same reduction the web dashboard
// uses (packages/ui agent-ui-reducer — settled chat items, activity roll-ups
// with streaming thinking/code text, presence) run client-side over the whole
// event window. The web splits settled items into a server-side SQLite table
// and only reduces the in-flight tail; on the phone the event counts per chat
// are small enough to just reduce everything from offset 0 on each update.

import {
  deriveAgentUiLiveStatus,
  formatAgentUiActivitySummary,
  formatAgentUiDuration,
  summarizeAgentUiActivity,
  initialAgentUiState,
  isAgentUiActivityWorking,
  reduceAgentUi,
  type AgentUiActivity,
  type AgentUiItem,
  type AgentUiLiveStatus,
  type AgentUiState,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import type { StreamEvent } from "iterate/sdk/itx/react";

export type {
  AgentUiActivity,
  AgentUiCodeStep,
  AgentUiFileAttachment,
  AgentUiItem,
  AgentUiLivePhase,
  AgentUiLiveStatus,
  AgentUiLlmStep,
  AgentUiMessageItem,
  AgentUiStep,
  AgentUiStreamWakeItem,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
// Round grouping lives with the reducer so the os web feed groups the same
// way (apps/os/src/components/agent-feed.tsx renders the same rounds).
export { groupActivityRounds } from "@iterate-com/ui/components/events/agent-ui-reducer";

export type AgentFeed = {
  /** Settled items in order, then queued user messages, then the live activity. */
  items: AgentUiItem[];
  /** The in-flight activity (streaming thinking/code), also last in `items`. */
  live: AgentUiActivity | null;
  /** The live activity's phase + this turn's agent-set status text. */
  liveStatus: AgentUiLiveStatus | null;
  /** True while the agent owes visible progress — drives the working row. */
  working: boolean;
  state: AgentUiState;
};

export type MobileFeedItem =
  | Exclude<AgentUiItem, { kind: "stream-woken" }>
  | (Extract<AgentUiItem, { kind: "stream-woken" }> & { wakeCount: number });

// packages/ui doesn't export its local `Event` type (StreamEvent + streamPath)
// from the package boundary, so we borrow it the same way the browser-feed
// projector does — the parameter type of the exported reducer function.
type AgentUiEvent = Parameters<typeof reduceAgentUi>[1];

export function reduceFeed(agentPath: string, events: StreamEvent[]): AgentFeed {
  let state = initialAgentUiState();
  const settled: AgentUiItem[] = [];
  for (const event of events) {
    const folded = reduceAgentUi(state, { ...event, streamPath: agentPath } as AgentUiEvent);
    state = folded.endState;
    for (const item of folded.items) {
      const correctionIndex = settled.findIndex((candidate) => candidate.id === item.id);
      if (correctionIndex === -1) settled.push(item);
      else settled[correctionIndex] = item;
    }
  }
  const liveStatus = deriveAgentUiLiveStatus(state);
  // "processing" counts as working: the script settled with a returned value,
  // so another LLM round is owed but not yet journaled. Without it the card
  // would flicker to "done" for the request debounce window mid-turn. A pause
  // fact (the autonomous breaker, an operator) settles the live activity in
  // the reducer, so this cannot wedge a spinner past the turn's real end.
  // turnPending covers the other owed-but-not-journaled window: a triggering
  // user message whose debounced llm request hasn't opened yet.
  const working =
    isAgentUiActivityWorking(state.live) ||
    liveStatus?.phase === "processing" ||
    turnPending(events);
  if (state.live !== null && !working) {
    const completed: AgentUiActivity = { ...state.live, status: "done" };
    const correctionIndex = settled.findIndex((item) => item.id === completed.id);
    if (correctionIndex === -1) settled.push(completed);
    else settled[correctionIndex] = completed;
    return {
      items: [...settled, ...state.deferredAssistantMessages, ...state.queuedUserMessages],
      live: null,
      liveStatus: null,
      working: false,
      state: {
        ...state,
        deferredAssistantMessages: [],
        live: null,
        queuedUserMessages: [],
      },
    };
  }
  const items = [...settled, ...state.queuedUserMessages, ...(state.live ? [state.live] : [])];
  return {
    items,
    live: state.live,
    liveStatus,
    working,
    state,
  };
}

/**
 * True when the journal's newest turn-relevant fact is a triggering user
 * message: the agent owes an llm request that hasn't been journaled yet (the
 * request debounce window). The working row reads this so it stays visible
 * through that window instead of flashing idle between the send and the
 * request opening. Pause facts suppress it — a paused agent owes nothing
 * until resumed. Web-chat messages only (`agents/context-added`, role user):
 * that is the one ingress this screen sends through.
 */
function turnPending(events: StreamEvent[]): boolean {
  let pending = false;
  let paused = false;
  for (const event of events) {
    const payload = event.payload || {};
    switch (event.type) {
      case "events.iterate.com/agents/context-added": {
        if (payload.role !== "user") break;
        // Journal payloads are producer-validated at append time; this fold
        // only sniffs one optional discriminator, so the cast narrows no
        // further than the single field read (a schema boundary here would
        // re-parse every event on every reduction for that one read, and a
        // malformed value still lands harmlessly on `undefined`).
        const policy = payload.llmRequestPolicy as { behaviour?: string } | undefined;
        if (policy?.behaviour === "dont-trigger-request") break;
        pending = true;
        break;
      }
      // A reply or a stream error after the message, with no request in
      // between, also ends the wait (the last two cases): the message was
      // answered without an llm round (a directly-handled command), or the
      // turn machinery crashed — either way no request is owed and the row
      // must not spin forever.
      case "events.iterate.com/agent/llm-request-requested":
      case "events.iterate.com/capability-host/script-run-requested":
      case "events.iterate.com/agents/web-message-sent":
      case "events.iterate.com/stream/error-occurred":
        pending = false;
        break;
      case "events.iterate.com/agent/paused":
      case "events.iterate.com/stream/paused":
        paused = true;
        break;
      case "events.iterate.com/agent/resumed":
      case "events.iterate.com/stream/resumed":
        paused = false;
        break;
      default:
        break;
    }
  }
  return pending && !paused;
}

/** Replace each adjacent run of stream wakes with its final event and the run length. */
export function collapseConsecutiveStreamWakes(items: AgentUiItem[]): MobileFeedItem[] {
  const collapsed: MobileFeedItem[] = [];
  for (const item of items) {
    const previous = collapsed.at(-1);
    if (item.kind === "stream-woken") {
      if (previous?.kind === "stream-woken") {
        collapsed[collapsed.length - 1] = { ...item, wakeCount: previous.wakeCount + 1 };
      } else {
        collapsed.push({ ...item, wakeCount: 1 });
      }
    } else {
      collapsed.push(item);
    }
  }
  return collapsed;
}

/** One-line summary for a collapsed activity row: "Ran code 2× · 3 requests · 7.4s". */
export function summarizeActivity(activity: AgentUiActivity): string {
  // When the agent authored an activity label ("Factoring the number"), that
  // plus the duration is the headline; the counts are one expand away —
  // parity with the os feed's AgentActivityRow. Failures and interruptions
  // keep the full stats line.
  const summary = summarizeAgentUiActivity(activity);
  const label = [...activity.steps]
    .reverse()
    .flatMap((step) => (step.kind === "code" && step.activitySummary ? [step.activitySummary] : []))
    .at(0);
  if (label == null || summary.outcome !== "clean") {
    return `${label == null ? "" : `${label} · `}${formatAgentUiActivitySummary(activity)}`;
  }
  return [
    label,
    ...(activity.endedAtMs == null
      ? []
      : [formatAgentUiDuration(Math.max(0, activity.endedAtMs - activity.startedAtMs))]),
  ].join(" · ");
}

// Full agent feed for the thread screen: the same reduction the web dashboard
// uses (packages/ui agent-ui-reducer — settled chat items, activity roll-ups
// with streaming thinking/code text, presence) run client-side over the whole
// event window. The web splits settled items into a server-side SQLite table
// and only reduces the in-flight tail; on the phone the event counts per chat
// are small enough to just reduce everything from offset 0 on each update.

import {
  formatAgentUiActivitySummary,
  initialAgentUiState,
  isAgentUiActivityWorking,
  reduceAgentUi,
  type AgentUiActivity,
  type AgentUiItem,
  type AgentUiState,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import type { StreamEvent } from "iterate/sdk/itx/react";

export type {
  AgentUiActivity,
  AgentUiCodeStep,
  AgentUiFileAttachment,
  AgentUiItem,
  AgentUiLlmStep,
  AgentUiMessageItem,
  AgentUiStep,
  AgentUiStreamWakeItem,
} from "@iterate-com/ui/components/events/agent-ui-reducer";

export type AgentFeed = {
  /** Settled items in order, then queued user messages, then the live activity. */
  items: AgentUiItem[];
  /** The in-flight activity (streaming thinking/code), also last in `items`. */
  live: AgentUiActivity | null;
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
  const working = isAgentUiActivityWorking(state.live);
  if (state.live !== null && !working) {
    const completed: AgentUiActivity = { ...state.live, status: "done" };
    const correctionIndex = settled.findIndex((item) => item.id === completed.id);
    if (correctionIndex === -1) settled.push(completed);
    else settled[correctionIndex] = completed;
    return {
      items: [...settled, ...state.deferredAssistantMessages, ...state.queuedUserMessages],
      live: null,
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
    working,
    state,
  };
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
  return formatAgentUiActivitySummary(activity);
}

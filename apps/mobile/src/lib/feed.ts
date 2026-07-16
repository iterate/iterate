// Full agent feed for the thread screen: the same reduction the web dashboard
// uses (packages/ui agent-ui-reducer — settled chat items, activity roll-ups
// with streaming thinking/code text, presence) run client-side over the whole
// event window. The web splits settled items into a server-side SQLite table
// and only reduces the in-flight tail; on the phone the event counts per chat
// are small enough to just reduce everything from offset 0 on each update.

import {
  initialAgentUiState,
  reduceAgentUi,
  type AgentUiActivity,
  type AgentUiItem,
  type AgentUiState,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import type { StreamEvent } from "../../../os/src/itx-api.generated.ts";

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
    settled.push(...folded.items);
  }
  const items = [...settled, ...state.queuedUserMessages, ...(state.live ? [state.live] : [])];
  return {
    items,
    live: state.live,
    working: state.live != null && state.live.status === "running",
    state,
  };
}

/** One-line summary for a collapsed activity row: "Ran code 2× · 3 requests · 7.4s". */
export function summarizeActivity(activity: AgentUiActivity): string {
  const codeRuns = activity.steps.filter((step) => step.kind === "code").length;
  const llmRequests = activity.steps.filter((step) => step.kind === "llm").length;
  const failed = activity.steps.some(
    (step) =>
      (step.kind === "code" && step.status === "done" && step.success === false) ||
      (step.kind === "llm" && step.outcome === "failed"),
  );
  const parts = [
    ...(codeRuns > 0 ? [`Ran code ${codeRuns}×`] : []),
    ...(llmRequests > 0 ? [`${llmRequests} request${llmRequests === 1 ? "" : "s"}`] : []),
  ];
  if (parts.length === 0) parts.push("Activity");
  const endedAtMs = activity.endedAtMs;
  if (endedAtMs != null) {
    const seconds = (endedAtMs - activity.startedAtMs) / 1000;
    if (seconds > 0.05) parts.push(`${seconds.toFixed(1)}s`);
  }
  return parts.join(" · ") + (failed ? " · failed" : "");
}

// Full agent feed for the thread screen: the same reduction the web dashboard
// uses (packages/ui agent-ui-reducer — settled chat items, activity roll-ups
// with streaming thinking/code text, presence) run client-side over the whole
// event window. The web splits settled items into a server-side SQLite table
// and only reduces the in-flight tail; on the phone the event counts per chat
// are small enough to just reduce everything from offset 0 on each update.

import {
  initialAgentUiState,
  planAgentUiOps,
  type AgentUiActivity,
  type AgentUiItem,
  type AgentUiState,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import type { StreamEvent } from "../../../os/src/types.ts";

export type {
  AgentUiActivity,
  AgentUiCodeStep,
  AgentUiItem,
  AgentUiLlmStep,
  AgentUiMessageItem,
  AgentUiStep,
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

export function reduceFeed(agentPath: string, events: StreamEvent[]): AgentFeed {
  const { endState, ops } = planAgentUiOps(
    initialAgentUiState(),
    events.map((event) => ({ ...event, streamPath: agentPath })),
  );
  // Ops are upserts at dense positions (same application as the TUI's
  // agent-feed-model and the browser's SQLite processor).
  const settled: AgentUiItem[] = [];
  for (const op of ops) settled[op.localIndex] = op.item;
  const items = [
    ...settled,
    ...endState.queuedUserMessages,
    ...(endState.live ? [endState.live] : []),
  ];
  return {
    items,
    live: endState.live,
    working: endState.live != null && endState.live.status === "running",
    state: endState,
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

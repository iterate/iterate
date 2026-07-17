import { agentNodeDisplayState, agentTitle, type AgentTreeNode } from "./agent-tree.ts";
import type { AgentDisplayState } from "~/domains/agents/agent-presence.ts";

/**
 * The dot encodes attention priority, not the full state taxonomy: green =
 * the agent is working, amber = it needs a human, gray = parked or idle.
 * The label text carries the precise state.
 */
export const AGENT_DISPLAY_STATE_PRESENTATION: Record<
  AgentDisplayState,
  { label: string; active: boolean; dot: string }
> = {
  running_code: { label: "Running code", active: true, dot: "bg-emerald-500" },
  waiting_for_model: { label: "Waiting for model", active: true, dot: "bg-emerald-500" },
  queued: { label: "Queued", active: true, dot: "bg-emerald-500" },
  waiting_for_user_input: { label: "Needs input", active: false, dot: "bg-amber-500" },
  waiting_for_external_event: {
    label: "Waiting externally",
    active: false,
    dot: "bg-muted-foreground/40",
  },
  waiting_for_timer: { label: "Waiting for timer", active: false, dot: "bg-muted-foreground/40" },
  idle: { label: "Idle", active: false, dot: "bg-muted-foreground/25" },
};

export function agentCommandAccessibleLabel(
  node: AgentTreeNode,
  expanded: boolean,
  expandable = true,
): string {
  const state = AGENT_DISPLAY_STATE_PRESENTATION[agentNodeDisplayState(node)];
  const childInstruction =
    !expandable || node.children.length === 0
      ? ""
      : expanded
        ? " Child agents expanded; press Left Arrow to collapse."
        : " Child agents collapsed; press Right Arrow to expand.";
  const pinInstruction = node.agent.metadata.pinned
    ? " Pinned; press Shift+P to unpin."
    : " Press Shift+P to pin.";
  return `${agentTitle(node.agent)}. ${state.label}. ${node.agent.metadata.activity ?? node.agent.path}.${childInstruction}${pinInstruction}`;
}

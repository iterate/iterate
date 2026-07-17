import { Braces, CirclePause, Clock3, Sparkles, Terminal, UserRound } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { agentNodeDisplayState, agentTitle, type AgentTreeNode } from "./agent-tree.ts";
import type { AgentDisplayState } from "~/domains/agents/agent-presence.ts";

export const AGENT_DISPLAY_STATE_PRESENTATION: Record<
  AgentDisplayState,
  { label: string; icon: LucideIcon; active: boolean; rail: string }
> = {
  running_code: {
    label: "Running code",
    icon: Terminal,
    active: true,
    rail: "bg-emerald-500",
  },
  waiting_for_model: {
    label: "Waiting for model",
    icon: Sparkles,
    active: true,
    rail: "bg-sky-500",
  },
  queued: { label: "Queued", icon: Braces, active: true, rail: "bg-violet-500" },
  waiting_for_user_input: {
    label: "Waiting for user input",
    icon: UserRound,
    active: false,
    rail: "bg-amber-500",
  },
  waiting_for_external_event: {
    label: "Waiting for external event",
    icon: CirclePause,
    active: false,
    rail: "bg-orange-400",
  },
  waiting_for_timer: {
    label: "Waiting for timer",
    icon: Clock3,
    active: false,
    rail: "bg-fuchsia-400",
  },
  idle: { label: "Idle", icon: CirclePause, active: false, rail: "bg-muted-foreground/25" },
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

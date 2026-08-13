import { Bot, Github, Mail, Send, Slack, type LucideIcon } from "lucide-react";
import type { AgentRuntime } from "@iterate-com/shared/agent-events";
import { agentNodeDisplayState, agentTitle, type AgentTreeNode } from "./agent-tree.ts";
import type { AgentBinding, AgentDisplayState } from "~/domains/agents/agent-presence.ts";

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

/** Self-only or aggregate in-flight work, phrased as compact count fragments. */
export function runtimeCountFragments(runtime: AgentRuntime | undefined): string[] {
  if (!runtime) return [];
  const unreadyTriggers = Math.max(0, runtime.triggers.pending - runtime.triggers.runnable);
  const modelRequests = runtime.llmRequests.started + runtime.llmRequests.requested;
  const queued = runtime.llmRequests.scheduled + runtime.triggers.runnable;
  return [
    runtime.runningScripts > 0 ? pluralCount(runtime.runningScripts, "script") : null,
    modelRequests > 0 ? pluralCount(modelRequests, "model request") : null,
    queued > 0 ? `${queued} queued` : null,
    unreadyTriggers > 0 ? pluralCount(unreadyTriggers, "pending trigger") : null,
  ].filter((value): value is string => !!value);
}

function pluralCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function bindingIcon(binding: AgentBinding | undefined): LucideIcon {
  if (binding?.type === "slack_thread") return Slack;
  if (binding?.type === "telegram_thread") return Send;
  if (binding?.type === "email_thread") return Mail;
  if (binding?.type === "github_pull_request" || binding?.type === "github_check_run")
    return Github;
  return Bot;
}

export function bindingLabel(binding: AgentBinding): string {
  switch (binding.type) {
    case "slack_thread":
      return `Slack · ${binding.channelName ?? binding.channelId}`;
    case "telegram_thread":
      return `Telegram · ${binding.chatId}`;
    case "email_thread":
      return `Email · ${binding.subject ?? binding.counterpart ?? binding.threadId}`;
    case "github_pull_request":
      return `GitHub · ${binding.owner}/${binding.repo} #${binding.number}`;
    case "github_check_run":
      return `GitHub check · ${binding.owner}/${binding.repo} #${binding.number}`;
  }
}

export function bindingUrl(binding: AgentBinding): string | undefined {
  switch (binding.type) {
    case "slack_thread":
    case "github_pull_request":
    case "github_check_run":
      return binding.url;
    case "telegram_thread":
    case "email_thread":
      return undefined;
  }
}

export function agentCommandAccessibleLabel(node: AgentTreeNode, expanded: boolean): string {
  const state = AGENT_DISPLAY_STATE_PRESENTATION[agentNodeDisplayState(node)];
  const childInstruction =
    node.children.length === 0
      ? ""
      : expanded
        ? " Child agents expanded; press Left Arrow to collapse."
        : " Child agents collapsed; press Right Arrow to expand.";
  const pinInstruction = node.agent.summary.pinned
    ? " Pinned; press Shift+P to unpin."
    : " Press Shift+P to pin.";
  return `${agentTitle(node.agent)}. ${state.label}. ${node.agent.summary.activity ?? node.agent.path}.${childInstruction}${pinInstruction}`;
}

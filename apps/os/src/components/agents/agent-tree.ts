import { buildAgentPathForest, type AgentPathTreeNode } from "./agent-path-tree.ts";
import { deriveAgentDisplayState, type AgentRecord } from "~/domains/agents/agent-presence.ts";
import { flattenTreeRows, type TreeRow } from "~/lib/tree-rows.ts";

export type AgentTreeNode = Omit<AgentPathTreeNode, "agent" | "children"> & {
  agent: AgentRecord;
  children: AgentTreeNode[];
};

/** One forest build per live-state push: every mounted consumer (sidebar,
 * catalog, detail header, palette) receives the same records object identity,
 * so they share a single build instead of each memoizing their own. */
const forestCache = new WeakMap<Record<string, AgentRecord>, AgentTreeNode[]>();

export function buildAgentForest(records: Record<string, AgentRecord>): AgentTreeNode[] {
  const cached = forestCache.get(records);
  if (cached) return cached;

  const roots = contractPathNodes(buildAgentPathForest(records));
  roots.sort(compareStructuralNodes);
  forestCache.set(records, roots);
  return roots;
}

/** Remove inferred path containers while preserving their materialized agent
 * descendants and the aggregates computed by the canonical path-tree fold. */
function contractPathNodes(nodes: readonly AgentPathTreeNode[]): AgentTreeNode[] {
  const contracted: AgentTreeNode[] = [];
  for (const node of nodes) {
    const children = contractPathNodes(node.children);
    if (!node.agent) {
      contracted.push(...children);
      continue;
    }
    children.sort(compareStructuralNodes);
    contracted.push({
      ...node,
      agent: node.agent,
      children,
    });
  }
  return contracted;
}

export function pinnedAgentShortcuts(forest: readonly AgentTreeNode[]): AgentTreeNode[] {
  const nodes: AgentTreeNode[] = [];
  walkAgentForest(forest, (node) => {
    if (node.agent.summary.pinned) nodes.push(node);
  });
  return nodes.toSorted(compareRecentNodes);
}

/** Sidebar selection still honors pin/root caps, but presentation is one
 * recency-ordered list: pinning or attention state never jumps stale work over
 * a more recently active agent. */
export function sidebarAgentShortcuts(
  forest: readonly AgentTreeNode[],
  pinnedLimit: number,
  rootLimit: number,
): AgentTreeNode[] {
  const pinned = pinnedAgentShortcuts(forest).slice(0, pinnedLimit);
  const roots = forest
    .filter((node) => !node.agent.summary.pinned)
    .toSorted(compareRecentNodes)
    .slice(0, rootLimit);
  return [...pinned, ...roots].toSorted(compareRecentNodes);
}

const AGENT_TREE_SHAPE = {
  children: (node: AgentTreeNode) => node.children,
  key: (node: AgentTreeNode) => node.agent.path,
  matches: (node: AgentTreeNode, query: string) => agentMatchesSearch(node.agent, query),
};

/** Normalized text projected into TanStack Table's hidden search column. */
export function agentSearchText(agent: AgentRecord): string {
  const binding = agent.binding ? Object.values(agent.binding) : [];
  return [
    agentTitle(agent),
    agent.summary.activity,
    agent.summary.description,
    agent.path,
    ...binding,
  ]
    .filter(
      (value): value is string | number => typeof value === "string" || typeof value === "number",
    )
    .join(" ")
    .toLowerCase();
}

export function agentMatchesSearch(agent: AgentRecord, normalizedQuery: string): boolean {
  return agentSearchText(agent).includes(normalizedQuery);
}

export function flattenVisibleAgentRows(
  forest: readonly AgentTreeNode[],
  expandedPaths: ReadonlySet<string>,
  filter = "",
): TreeRow<AgentTreeNode>[] {
  return flattenTreeRows(forest, AGENT_TREE_SHAPE, expandedPaths, filter);
}

export function walkAgentForest(
  forest: readonly AgentTreeNode[],
  visit: (node: AgentTreeNode) => void,
): void {
  for (const node of forest) {
    visit(node);
    walkAgentForest(node.children, visit);
  }
}

export function agentTitle(agent: AgentRecord): string {
  if (agent.summary.title) return agent.summary.title;
  const bindingTitle = agentBindingTitle(agent.binding);
  if (bindingTitle) return bindingTitle;
  return agent.path.split("/").filter(Boolean).at(-1) ?? agent.path;
}

function agentBindingTitle(binding: AgentRecord["binding"]): string | undefined {
  if (!binding) return undefined;
  switch (binding.type) {
    case "slack_thread":
      return binding.channelName ? `#${binding.channelName}` : `Slack ${binding.channelId}`;
    case "telegram_thread":
      return `Telegram chat ${binding.chatId}`;
    case "email_thread":
      return (
        binding.subject ??
        (binding.counterpart ? `Email with ${binding.counterpart}` : "Email thread")
      );
    case "github_pull_request":
      return `${binding.owner}/${binding.repo} #${binding.number}`;
    case "github_check_run":
      return `${binding.owner}/${binding.repo} check #${binding.number}`;
  }
}

export function agentNodeDisplayState(
  node: Pick<AgentTreeNode, "aggregateRuntime" | "aggregateWaiting">,
) {
  const aggregateState = deriveAgentDisplayState(node.aggregateRuntime);
  if (aggregateState !== "idle") return aggregateState;
  const waitingFor = agentNodeWaitingFor(node);
  if (waitingFor === "user_input") return "waiting_for_user_input";
  if (waitingFor === "external_event") return "waiting_for_external_event";
  if (waitingFor === "timer") return "waiting_for_timer";
  return "idle";
}

/** Highest-priority waiting requirement in a node's collapsed subtree. */
export function agentNodeWaitingFor(
  node: Pick<AgentTreeNode, "aggregateWaiting">,
): AgentRecord["summary"]["waitingFor"] {
  if (node.aggregateWaiting.userInput > 0) return "user_input";
  if (node.aggregateWaiting.externalEvent > 0) return "external_event";
  if (node.aggregateWaiting.timer > 0) return "timer";
  return undefined;
}

function compareStructuralNodes(left: AgentTreeNode, right: AgentTreeNode): number {
  return (
    displayPriority(left) - displayPriority(right) ||
    right.aggregateLastWorkAt.localeCompare(left.aggregateLastWorkAt) ||
    left.agent.path.localeCompare(right.agent.path)
  );
}

function compareRecentNodes(left: AgentTreeNode, right: AgentTreeNode): number {
  return (
    right.aggregateLastWorkAt.localeCompare(left.aggregateLastWorkAt) ||
    left.agent.path.localeCompare(right.agent.path)
  );
}

function displayPriority(node: AgentTreeNode): number {
  switch (agentNodeDisplayState(node)) {
    case "running_code":
    case "waiting_for_model":
    case "queued":
      return 0;
    case "waiting_for_user_input":
      return 1;
    case "waiting_for_external_event":
    case "waiting_for_timer":
      return 2;
    case "idle":
      return 3;
  }
}

import { ZERO_AGENT_RUNTIME, type AgentRuntime } from "@iterate-com/shared/agent-events";
import { deriveAgentDisplayState, type AgentRecord } from "~/domains/agents/agent-presence.ts";
import { closestAncestorByPath, flattenTreeRows, type TreeRow } from "~/lib/tree-rows.ts";

type AgentWaitingAggregate = {
  userInput: number;
  externalEvent: number;
  timer: number;
};

export type AgentTreeNode = {
  agent: AgentRecord;
  children: AgentTreeNode[];
  aggregateRuntime: AgentRuntime;
  aggregateWaiting: AgentWaitingAggregate;
  aggregateLastWorkAt: string;
  aggregateAgentCount: number;
  aggregateActiveCount: number;
};

/** One forest build per live-state push: every mounted consumer (sidebar,
 * catalog, detail header, palette) receives the same records object identity,
 * so they share a single build instead of each memoizing their own. */
const forestCache = new WeakMap<Record<string, AgentRecord>, AgentTreeNode[]>();

export function buildAgentForest(records: Record<string, AgentRecord>): AgentTreeNode[] {
  const cached = forestCache.get(records);
  if (cached !== undefined) return cached;

  const nodes = new Map<string, AgentTreeNode>();
  for (const agent of Object.values(records)) {
    nodes.set(agent.path, {
      agent,
      children: [],
      aggregateRuntime: ZERO_AGENT_RUNTIME,
      aggregateWaiting: emptyWaitingAggregate(),
      aggregateLastWorkAt: agent.timestamps.lastWorkAt,
      aggregateAgentCount: 1,
      aggregateActiveCount: 0,
    });
  }

  const roots: AgentTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = closestAncestorByPath(node.agent.path, nodes);
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
  }

  for (const root of roots) finalizeNode(root);
  roots.sort(compareStructuralNodes);
  forestCache.set(records, roots);
  return roots;
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
  matches: (node: AgentTreeNode, query: string) => agentSearchText(node.agent).includes(query),
};

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
  if (agent.summary.title !== undefined) return agent.summary.title;
  const bindingTitle = agentBindingTitle(agent.binding);
  if (bindingTitle !== undefined) return bindingTitle;
  return agent.path.split("/").filter(Boolean).at(-1) ?? agent.path;
}

function agentBindingTitle(binding: AgentRecord["binding"]): string | undefined {
  if (binding === undefined) return undefined;
  switch (binding.type) {
    case "slack_thread":
      return binding.channelName === undefined
        ? `Slack ${binding.channelId}`
        : `#${binding.channelName}`;
    case "telegram_thread":
      return `Telegram chat ${binding.chatId}`;
    case "email_thread":
      return (
        binding.subject ??
        (binding.counterpart === undefined ? "Email thread" : `Email with ${binding.counterpart}`)
      );
    case "github_pull_request":
      return `${binding.owner}/${binding.repo} #${binding.number}`;
    case "github_check_run":
      return `${binding.owner}/${binding.repo} check #${binding.number}`;
  }
}

function agentSearchText(agent: AgentRecord): string {
  const binding = agent.binding === undefined ? [] : Object.values(agent.binding);
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

export function agentNodeDisplayState(
  node: Pick<AgentTreeNode, "aggregateRuntime" | "aggregateWaiting">,
) {
  const aggregateState = deriveAgentDisplayState(node.aggregateRuntime);
  if (aggregateState !== "idle") return aggregateState;
  if (node.aggregateWaiting.userInput > 0) return "waiting_for_user_input";
  if (node.aggregateWaiting.externalEvent > 0) return "waiting_for_external_event";
  if (node.aggregateWaiting.timer > 0) return "waiting_for_timer";
  return "idle";
}

function finalizeNode(node: AgentTreeNode): void {
  let runtime = node.agent.runtime ?? ZERO_AGENT_RUNTIME;
  const waiting = emptyWaitingAggregate();
  addWaiting(waiting, node.agent.summary.waitingFor);
  let lastWorkAt = node.agent.timestamps.lastWorkAt;
  let agentCount = 1;
  let activeCount = deriveAgentDisplayState(node.agent.runtime) === "idle" ? 0 : 1;

  for (const child of node.children) {
    finalizeNode(child);
    runtime = addRuntime(runtime, child.aggregateRuntime);
    waiting.userInput += child.aggregateWaiting.userInput;
    waiting.externalEvent += child.aggregateWaiting.externalEvent;
    waiting.timer += child.aggregateWaiting.timer;
    if (child.aggregateLastWorkAt > lastWorkAt) lastWorkAt = child.aggregateLastWorkAt;
    agentCount += child.aggregateAgentCount;
    activeCount += child.aggregateActiveCount;
  }

  node.aggregateRuntime = runtime;
  node.aggregateWaiting = waiting;
  node.aggregateLastWorkAt = lastWorkAt;
  node.aggregateAgentCount = agentCount;
  node.aggregateActiveCount = activeCount;
  node.children.sort(compareStructuralNodes);
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

function addRuntime(left: AgentRuntime, right: AgentRuntime): AgentRuntime {
  return {
    triggers: {
      pending: left.triggers.pending + right.triggers.pending,
      runnable: left.triggers.runnable + right.triggers.runnable,
    },
    llmRequests: {
      scheduled: left.llmRequests.scheduled + right.llmRequests.scheduled,
      requested: left.llmRequests.requested + right.llmRequests.requested,
      started: left.llmRequests.started + right.llmRequests.started,
    },
    runningScripts: left.runningScripts + right.runningScripts,
  };
}

function emptyWaitingAggregate(): AgentWaitingAggregate {
  return { userInput: 0, externalEvent: 0, timer: 0 };
}

function addWaiting(
  aggregate: AgentWaitingAggregate,
  waitingFor: AgentRecord["summary"]["waitingFor"],
): void {
  if (waitingFor === "user_input") aggregate.userInput += 1;
  if (waitingFor === "external_event") aggregate.externalEvent += 1;
  if (waitingFor === "timer") aggregate.timer += 1;
}

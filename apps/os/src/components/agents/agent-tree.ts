import { ZERO_AGENT_RUNTIME, type AgentRuntime } from "@iterate-com/shared/agent-events";
import { deriveAgentDisplayState, type AgentRecord } from "~/domains/agents/agent-presence.ts";

export type AgentWaitingAggregate = {
  userInput: number;
  externalEvent: number;
  timer: number;
};

export type AgentTreeNode = {
  agent: AgentRecord;
  parentPath?: string;
  depth: number;
  children: AgentTreeNode[];
  aggregateRuntime: AgentRuntime;
  aggregateWaiting: AgentWaitingAggregate;
  aggregateLastWorkAt: string;
  aggregateAgentCount: number;
  aggregateActiveCount: number;
};

export type VisibleAgentRow = {
  node: AgentTreeNode;
  depth: number;
  matching: boolean;
};

export function buildAgentForest(records: Record<string, AgentRecord>): AgentTreeNode[] {
  const nodes = new Map<string, AgentTreeNode>();
  for (const agent of Object.values(records)) {
    nodes.set(agent.path, {
      agent,
      depth: 0,
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
    const parent = closestAgentAncestor(node.agent.path, nodes);
    if (parent === undefined) {
      roots.push(node);
      continue;
    }
    node.parentPath = parent.agent.path;
    parent.children.push(node);
  }

  for (const root of roots) finalizeNode(root, 0);
  roots.sort(compareStructuralNodes);
  return roots;
}

export function pinnedAgentShortcuts(forest: readonly AgentTreeNode[]): AgentTreeNode[] {
  const nodes: AgentTreeNode[] = [];
  walkAgentForest(forest, (node) => {
    if (node.agent.metadata.pinned) nodes.push(node);
  });
  return nodes.toSorted(
    (left, right) =>
      right.aggregateLastWorkAt.localeCompare(left.aggregateLastWorkAt) ||
      left.agent.path.localeCompare(right.agent.path),
  );
}

export function sidebarStructuralRoots(
  forest: readonly AgentTreeNode[],
  limit: number,
): { roots: AgentTreeNode[]; hiddenRootCount: number } {
  const unpinnedRoots = forest.filter((node) => !node.agent.metadata.pinned);
  return {
    roots: unpinnedRoots.slice(0, limit),
    hiddenRootCount: Math.max(0, unpinnedRoots.length - limit),
  };
}

export function flattenVisibleAgentRows(
  forest: readonly AgentTreeNode[],
  expandedPaths: ReadonlySet<string>,
  filter = "",
): VisibleAgentRow[] {
  const query = filter.trim().toLowerCase();
  const rows: VisibleAgentRow[] = [];

  const append = (node: AgentTreeNode, depth: number): boolean => {
    const matching = query === "" || agentSearchText(node.agent).includes(query);
    const childRows: VisibleAgentRow[] = [];
    const previousLength = rows.length;
    for (const child of node.children) {
      const beforeChild = rows.length;
      const childMatches = append(child, depth + 1);
      if (childMatches) childRows.push(...rows.splice(beforeChild));
    }
    const subtreeMatches = matching || childRows.length > 0;
    rows.length = previousLength;
    if (!subtreeMatches) return false;

    rows.push({ node, depth, matching });
    if (query !== "" || expandedPaths.has(node.agent.path)) rows.push(...childRows);
    return true;
  };

  for (const root of forest) append(root, 0);
  return rows;
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
  if (agent.metadata.title !== undefined) return agent.metadata.title;
  const bindingTitle = agentBindingTitle(agent.binding);
  if (bindingTitle !== undefined) return bindingTitle;
  return agent.path.split("/").filter(Boolean).at(-1) ?? agent.path;
}

export function agentBindingTitle(binding: AgentRecord["binding"]): string | undefined {
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

export function agentSearchText(agent: AgentRecord): string {
  const binding = agent.binding === undefined ? [] : Object.values(agent.binding);
  return [
    agentTitle(agent),
    agent.metadata.activity,
    agent.metadata.summary,
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

function closestAgentAncestor(
  path: string,
  nodes: ReadonlyMap<string, AgentTreeNode>,
): AgentTreeNode | undefined {
  let boundary = path.lastIndexOf("/");
  while (boundary > 0) {
    const candidate = nodes.get(path.slice(0, boundary));
    if (candidate !== undefined) return candidate;
    boundary = path.lastIndexOf("/", boundary - 1);
  }
  return undefined;
}

function finalizeNode(node: AgentTreeNode, depth: number): void {
  node.depth = depth;
  let runtime = node.agent.runtime;
  const waiting = emptyWaitingAggregate();
  addWaiting(waiting, node.agent.metadata.waitingFor);
  let lastWorkAt = node.agent.timestamps.lastWorkAt;
  let agentCount = 1;
  let activeCount = deriveAgentDisplayState(node.agent.runtime) === "idle" ? 0 : 1;

  for (const child of node.children) {
    finalizeNode(child, depth + 1);
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
  waitingFor: AgentRecord["metadata"]["waitingFor"],
): void {
  if (waitingFor === "user_input") aggregate.userInput += 1;
  if (waitingFor === "external_event") aggregate.externalEvent += 1;
  if (waitingFor === "timer") aggregate.timer += 1;
}

import { ZERO_AGENT_RUNTIME, type AgentRuntime } from "@iterate-com/shared/agent-events";
import { agentSearchText } from "./agent-tree.ts";
import { deriveAgentDisplayState, type AgentRecord } from "~/domains/agents/agent-presence.ts";

type AgentWaitingAggregate = {
  userInput: number;
  externalEvent: number;
  timer: number;
};

/** A filesystem-style path node. Prefix nodes exist even when no agent is
 * materialized at that exact path. */
export type AgentPathTreeNode = {
  path: string;
  agent?: AgentRecord;
  children: AgentPathTreeNode[];
  aggregateRuntime: AgentRuntime;
  aggregateWaiting: AgentWaitingAggregate;
  aggregateLastWorkAt?: string;
  aggregateAgentCount: number;
  aggregateActiveCount: number;
};

const pathForestCache = new WeakMap<Record<string, AgentRecord>, AgentPathTreeNode[]>();

/** Build a forest from every absolute path prefix. Top-level segments remain
 * peers, so the model does not assume that all agents live below `/agents`. */
export function buildAgentPathForest(records: Record<string, AgentRecord>): AgentPathTreeNode[] {
  const cached = pathForestCache.get(records);
  if (cached !== undefined) return cached;

  const nodes = new Map<string, AgentPathTreeNode>();
  for (const agent of Object.values(records)) {
    for (const path of absolutePathPrefixes(agent.path)) {
      let node = nodes.get(path);
      if (node === undefined) {
        node = emptyPathNode(path);
        nodes.set(path, node);
      }
      if (path === agent.path) node.agent = agent;
    }
  }

  const roots: AgentPathTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(parentPath(node.path));
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
  }

  for (const root of roots) finalizePathNode(root);
  roots.sort(comparePathNodes);
  pathForestCache.set(records, roots);
  return roots;
}

export function agentPathSearchText(node: AgentPathTreeNode): string {
  return node.agent === undefined ? node.path.toLowerCase() : agentSearchText(node.agent);
}

export function agentPathNodeWaitingFor(
  node: Pick<AgentPathTreeNode, "aggregateWaiting">,
): AgentRecord["summary"]["waitingFor"] {
  if (node.aggregateWaiting.userInput > 0) return "user_input";
  if (node.aggregateWaiting.externalEvent > 0) return "external_event";
  if (node.aggregateWaiting.timer > 0) return "timer";
  return undefined;
}

export function agentPathNodeDisplayState(
  node: Pick<AgentPathTreeNode, "aggregateRuntime" | "aggregateWaiting">,
) {
  const aggregateState = deriveAgentDisplayState(node.aggregateRuntime);
  if (aggregateState !== "idle") return aggregateState;
  const waitingFor = agentPathNodeWaitingFor(node);
  if (waitingFor === "user_input") return "waiting_for_user_input";
  if (waitingFor === "external_event") return "waiting_for_external_event";
  if (waitingFor === "timer") return "waiting_for_timer";
  return "idle";
}

/** Replace a materialized agent's catalog runtime with its live runtime while
 * preserving the aggregate runtime of every descendant. */
export function agentPathNodeRuntime(
  node: Pick<AgentPathTreeNode, "agent" | "aggregateRuntime">,
  liveRuntime?: AgentRuntime,
): AgentRuntime {
  if (node.agent === undefined || liveRuntime === undefined) return node.aggregateRuntime;
  return addRuntime(
    subtractRuntime(node.aggregateRuntime, node.agent.runtime ?? ZERO_AGENT_RUNTIME),
    liveRuntime,
  );
}

function absolutePathPrefixes(path: string): string[] {
  const segments = path.split("/").filter(Boolean);
  return segments.map((_, index) => `/${segments.slice(0, index + 1).join("/")}`);
}

function parentPath(path: string): string {
  const boundary = path.lastIndexOf("/");
  return boundary <= 0 ? "" : path.slice(0, boundary);
}

function emptyPathNode(path: string): AgentPathTreeNode {
  return {
    path,
    children: [],
    aggregateRuntime: ZERO_AGENT_RUNTIME,
    aggregateWaiting: emptyWaitingAggregate(),
    aggregateAgentCount: 0,
    aggregateActiveCount: 0,
  };
}

function finalizePathNode(node: AgentPathTreeNode): void {
  let runtime = node.agent?.runtime ?? ZERO_AGENT_RUNTIME;
  const waiting = emptyWaitingAggregate();
  addWaiting(waiting, node.agent?.summary.waitingFor);
  let lastWorkAt = node.agent?.timestamps.lastWorkAt;
  let agentCount = node.agent === undefined ? 0 : 1;
  let activeCount =
    node.agent === undefined || deriveAgentDisplayState(node.agent.runtime) === "idle" ? 0 : 1;

  for (const child of node.children) {
    finalizePathNode(child);
    runtime = addRuntime(runtime, child.aggregateRuntime);
    waiting.userInput += child.aggregateWaiting.userInput;
    waiting.externalEvent += child.aggregateWaiting.externalEvent;
    waiting.timer += child.aggregateWaiting.timer;
    if (
      child.aggregateLastWorkAt !== undefined &&
      (lastWorkAt === undefined || child.aggregateLastWorkAt > lastWorkAt)
    ) {
      lastWorkAt = child.aggregateLastWorkAt;
    }
    agentCount += child.aggregateAgentCount;
    activeCount += child.aggregateActiveCount;
  }

  node.aggregateRuntime = runtime;
  node.aggregateWaiting = waiting;
  node.aggregateLastWorkAt = lastWorkAt;
  node.aggregateAgentCount = agentCount;
  node.aggregateActiveCount = activeCount;
  node.children.sort(comparePathNodes);
}

function comparePathNodes(left: AgentPathTreeNode, right: AgentPathTreeNode): number {
  return left.path.localeCompare(right.path);
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

function subtractRuntime(left: AgentRuntime, right: AgentRuntime): AgentRuntime {
  return {
    triggers: {
      pending: Math.max(0, left.triggers.pending - right.triggers.pending),
      runnable: Math.max(0, left.triggers.runnable - right.triggers.runnable),
    },
    llmRequests: {
      scheduled: Math.max(0, left.llmRequests.scheduled - right.llmRequests.scheduled),
      requested: Math.max(0, left.llmRequests.requested - right.llmRequests.requested),
      started: Math.max(0, left.llmRequests.started - right.llmRequests.started),
    },
    runningScripts: Math.max(0, left.runningScripts - right.runningScripts),
  };
}

import type { AgentRecord } from "~/domains/agents/agent-presence.ts";

/** Cap for the project-dashboard "Recently Active Agents" excerpt. */
const RECENTLY_ACTIVE_AGENTS_LIMIT = 8;

/**
 * Pick the most recently active agents from the live catalog map, newest
 * first (ties break by path so the order is stable).
 */
export function selectRecentlyActiveAgents(agents: Record<string, AgentRecord>): AgentRecord[] {
  return Object.values(agents)
    .toSorted(
      (left, right) =>
        right.timestamps.lastWorkAt.localeCompare(left.timestamps.lastWorkAt) ||
        left.path.localeCompare(right.path),
    )
    .slice(0, RECENTLY_ACTIVE_AGENTS_LIMIT);
}

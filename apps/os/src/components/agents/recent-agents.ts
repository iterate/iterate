import type { AgentRecord } from "~/domains/agents/agent-presence.ts";

/** Cap for the project-dashboard "Recently Active Agents" excerpt. */
export const RECENTLY_ACTIVE_AGENTS_LIMIT = 8;

/**
 * Pick the most recently active agents from the live catalog map, newest
 * first. Pure helper so the dashboard and tests share one ordering rule.
 */
export function selectRecentlyActiveAgents(
  agents: Record<string, AgentRecord>,
  limit: number = RECENTLY_ACTIVE_AGENTS_LIMIT,
): AgentRecord[] {
  const max = Math.max(0, Math.floor(limit));
  if (max === 0) return [];
  return Object.values(agents)
    .toSorted(
      (left, right) =>
        right.timestamps.lastWorkAt.localeCompare(left.timestamps.lastWorkAt) ||
        left.path.localeCompare(right.path),
    )
    .slice(0, max);
}

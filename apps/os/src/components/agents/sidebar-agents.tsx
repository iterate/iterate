import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
} from "@iterate-com/ui/components/sidebar";
import { AgentSidebarRow } from "./agent.tsx";
import { buildAgentForest, pinnedAgentShortcuts } from "./agent-tree.ts";
import type { AgentRecord } from "~/domains/agents/agent-presence.ts";
import { linkOptionsForStreamPath } from "~/lib/stream-routes.ts";

const PINNED_LIMIT = 5;
const ROOT_LIMIT = 8;

/**
 * The sidebar is navigation, not a dashboard: a short list of two-line
 * shortcuts, pinned first, then the busiest roots. The full catalog is the
 * /agents nav item above; pinning, trees, and counts live there and in the
 * agent details sheet.
 */
export function SidebarAgents({
  agents,
  projectSlug,
}: {
  agents: Record<string, AgentRecord>;
  projectSlug: string;
}) {
  const navigate = useNavigate();
  const forest = useMemo(() => buildAgentForest(agents), [agents]);
  const rows = useMemo(() => {
    // Pinned shortcuts first, then the top unpinned roots. Pinned agents
    // beyond PINNED_LIMIT drop out of the sidebar entirely (their roots are
    // filtered too); the /agents catalog keeps them one click away.
    const pinned = pinnedAgentShortcuts(forest).slice(0, PINNED_LIMIT);
    const roots = forest.filter((node) => !node.agent.summary.pinned).slice(0, ROOT_LIMIT);
    return [...pinned, ...roots];
  }, [forest]);

  if (rows.length === 0) return null;
  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel>Agents</SidebarGroupLabel>
      <SidebarGroupContent className="flex flex-col">
        {rows.map((node) => (
          <AgentSidebarRow
            key={node.agent.path}
            node={node}
            onOpen={() => void navigate(linkOptionsForStreamPath(projectSlug, node.agent.path))}
          />
        ))}
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

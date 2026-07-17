import { useMemo } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarSeparator,
} from "@iterate-com/ui/components/sidebar";
import { toast } from "@iterate-com/ui/components/sonner";
import { connectItx } from "iterate/react";
import { AgentSidebarRow } from "./agent.tsx";
import { buildAgentForest, pinnedAgentShortcuts, sidebarStructuralRoots } from "./agent-tree.ts";
import type { AgentRecord } from "~/domains/agents/agent-presence.ts";
import { linkOptionsForStreamPath } from "~/lib/stream-routes.ts";

const PINNED_LIMIT = 5;
const ROOT_LIMIT = 8;

/**
 * The sidebar is navigation, not a dashboard: a short list of one-line
 * shortcuts (pinned first, then the busiest roots) and a link to the full
 * catalog. Trees, counts, and timestamps live on the agents page.
 */
export function SidebarAgents({
  agents,
  projectId,
  projectSlug,
}: {
  agents: Record<string, AgentRecord>;
  projectId: string;
  projectSlug: string;
}) {
  const navigate = useNavigate();
  const forest = useMemo(() => buildAgentForest(agents), [agents]);
  const rows = useMemo(() => {
    const pinned = pinnedAgentShortcuts(forest).slice(0, PINNED_LIMIT);
    const { roots } = sidebarStructuralRoots(forest, ROOT_LIMIT);
    return [...pinned, ...roots];
  }, [forest]);

  async function togglePinned(agent: AgentRecord): Promise<void> {
    try {
      const itx = await connectItx(projectId);
      await itx.agents.get(agent.path).setMetadata({ pinned: !agent.metadata.pinned });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update pin.");
    }
  }

  if (rows.length === 0) return null;
  return (
    <>
      <SidebarSeparator className="group-data-[collapsible=icon]:hidden" />
      <SidebarGroup className="group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel>Agents</SidebarGroupLabel>
        <SidebarGroupContent className="flex flex-col">
          {rows.map((node) => (
            <AgentSidebarRow
              key={node.agent.path}
              node={node}
              onOpen={() => void navigate(linkOptionsForStreamPath(projectSlug, node.agent.path))}
              onTogglePinned={() => togglePinned(node.agent)}
            />
          ))}
          <Link
            to="/projects/$projectSlug/agents"
            params={{ projectSlug }}
            search={{}}
            className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
          >
            All agents
          </Link>
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  );
}

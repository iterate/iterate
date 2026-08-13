import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
} from "@iterate-com/ui/components/sidebar";
import { AgentSidebarRow } from "./agent.tsx";
import { buildAgentForest, sidebarAgentShortcuts } from "./agent-tree.ts";
import type { AgentRecord } from "~/domains/agents/agent-presence.ts";
import { linkOptionsForStreamPath } from "~/lib/stream-routes.ts";

const PINNED_LIMIT = 5;
const ROOT_LIMIT = 8;

/**
 * The sidebar is navigation, not a dashboard: a short list of two-line
 * shortcuts, always ordered by their latest activity. The full catalog is the
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
  // Pins govern which shortcuts survive the cap, never their display order.
  const rows = useMemo(() => sidebarAgentShortcuts(forest, PINNED_LIMIT, ROOT_LIMIT), [forest]);

  if (!rows.length) return null;
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

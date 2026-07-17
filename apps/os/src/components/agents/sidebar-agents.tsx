import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarSeparator,
} from "@iterate-com/ui/components/sidebar";
import { toast } from "@iterate-com/ui/components/sonner";
import { Agent } from "./agent.tsx";
import {
  buildAgentForest,
  flattenVisibleAgentRows,
  pinnedAgentShortcuts,
  sidebarStructuralRoots,
} from "./agent-tree.ts";
import type { AgentRecord } from "~/domains/agents/agent-presence.ts";
import { connectItx } from "~/itx/itx-react.tsx";
import { linkOptionsForStreamPath } from "~/lib/stream-routes.ts";
import { useTickingNowMs } from "~/lib/use-ticking-now-ms.ts";

const CLOCK_TICK_MS = 15_000;
const PINNED_LIMIT = 5;
const ROOT_LIMIT = 8;
const VISIBLE_ROW_LIMIT = 40;

export function SidebarAgents({
  agents,
  projectId,
  projectSlug,
}: {
  agents: Record<string, AgentRecord>;
  projectId: string;
  projectSlug: string;
}) {
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const navigate = useNavigate();
  const nowMs = useTickingNowMs(CLOCK_TICK_MS);
  const forest = useMemo(() => buildAgentForest(agents), [agents]);
  const pinned = useMemo(() => pinnedAgentShortcuts(forest), [forest]);
  const { roots, hiddenRootCount } = useMemo(
    () => sidebarStructuralRoots(forest, ROOT_LIMIT),
    [forest],
  );
  const allVisibleRows = useMemo(
    () => flattenVisibleAgentRows(roots, expandedPaths),
    [expandedPaths, roots],
  );
  const visibleRows = allVisibleRows.slice(0, VISIBLE_ROW_LIMIT);

  const toggleExpanded = useCallback((path: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  function openAgent(path: string) {
    void navigate(linkOptionsForStreamPath(projectSlug, path));
  }

  async function togglePinned(agent: AgentRecord): Promise<void> {
    try {
      const itx = await connectItx(projectId);
      await itx.agents.get(agent.path).setMetadata({ pinned: !agent.metadata.pinned });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update pin.");
    }
  }

  if (forest.length === 0) return null;
  const hiddenPinned = Math.max(0, pinned.length - PINNED_LIMIT);
  const hiddenExpandedRows = Math.max(0, allVisibleRows.length - visibleRows.length);

  return (
    <>
      <SidebarSeparator className="group-data-[collapsible=icon]:hidden" />
      {pinned.length > 0 ? (
        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel>Pinned agents</SidebarGroupLabel>
          <SidebarGroupContent className="space-y-0.5">
            {pinned.slice(0, PINNED_LIMIT).map((node) => (
              <Agent
                key={`pinned:${node.agent.path}`}
                agent={node.agent}
                variant="sidebar"
                nowMs={nowMs}
                shortcut
                tree={{ ...node, expanded: false }}
                actions={{
                  onOpen: () => openAgent(node.agent.path),
                  onTogglePinned: () => togglePinned(node.agent),
                }}
              />
            ))}
            {hiddenPinned > 0 ? (
              <Link
                to="/projects/$projectSlug/agents"
                params={{ projectSlug }}
                search={{}}
                className="block px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
              >
                +{hiddenPinned} pinned
              </Link>
            ) : null}
          </SidebarGroupContent>
        </SidebarGroup>
      ) : null}
      <SidebarGroup className="group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel>Agents</SidebarGroupLabel>
        <SidebarGroupContent className="space-y-0.5">
          {visibleRows.map(({ node, depth }) => {
            const expanded = expandedPaths.has(node.agent.path);
            return (
              <div key={node.agent.path} style={{ paddingLeft: `${Math.min(depth, 3) * 10}px` }}>
                <Agent
                  agent={node.agent}
                  variant="sidebar"
                  nowMs={nowMs}
                  tree={{ ...node, expanded }}
                  actions={{
                    onOpen: () => openAgent(node.agent.path),
                    onTogglePinned: () => togglePinned(node.agent),
                    onToggleChildren: () => toggleExpanded(node.agent.path),
                  }}
                />
              </div>
            );
          })}
          {hiddenExpandedRows > 0 ? (
            <Link
              to="/projects/$projectSlug/agents"
              params={{ projectSlug }}
              search={{}}
              className="block px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              +{hiddenExpandedRows} expanded agents
            </Link>
          ) : null}
          <Link
            to="/projects/$projectSlug/agents"
            params={{ projectSlug }}
            search={{}}
            className="block px-2 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Show all agents{hiddenRootCount > 0 ? ` · ${hiddenRootCount} more` : ""}
          </Link>
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  );
}

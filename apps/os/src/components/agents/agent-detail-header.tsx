import { useId, useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { toast } from "@iterate-com/ui/components/sonner";
import { connectItx } from "iterate/react";
import { AgentDetailCard, AgentListRow } from "./agent.tsx";
import {
  buildAgentForest,
  flattenVisibleAgentRows,
  walkAgentForest,
  type AgentTreeNode,
} from "./agent-tree.ts";
import { deriveAgentDisplayState, type AgentRecord } from "~/domains/agents/agent-presence.ts";
import { linkOptionsForStreamPath } from "~/lib/stream-routes.ts";
import { useTickingNowMs } from "~/lib/use-ticking-now-ms.ts";

const CLOCK_TICK_MS = 15_000;
const VISIBLE_CHILD_LIMIT = 20;

export function AgentDetailHeader({
  agents,
  path,
  projectId,
  projectSlug,
}: {
  agents: Record<string, AgentRecord>;
  path: string;
  projectId: string;
  projectSlug: string;
}) {
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [childrenOpen, setChildrenOpen] = useState(false);
  const childrenRegionId = useId();
  const nowMs = useTickingNowMs(CLOCK_TICK_MS);
  const navigate = useNavigate();
  const forest = useMemo(() => buildAgentForest(agents), [agents]);
  const node = useMemo(() => findAgentNode(forest, path), [forest, path]);
  const childRows = useMemo(
    () => (node === undefined ? [] : flattenVisibleAgentRows(node.children, expandedPaths)),
    [expandedPaths, node],
  );
  const visibleChildRows = childRows.slice(0, VISIBLE_CHILD_LIMIT);
  if (node === undefined) return null;
  const descendantCount = node.aggregateAgentCount - 1;
  const selfActive = deriveAgentDisplayState(node.agent.runtime) !== "idle";
  const activeDescendants = Math.max(0, node.aggregateActiveCount - (selfActive ? 1 : 0));

  async function updateMetadata(patch: { title?: string; pinned?: boolean }): Promise<boolean> {
    try {
      const itx = await connectItx(projectId);
      await itx.agents.get(path).setMetadata(patch);
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update agent.");
      return false;
    }
  }

  async function togglePinned(agent: AgentRecord): Promise<void> {
    try {
      const itx = await connectItx(projectId);
      await itx.agents.get(agent.path).setMetadata({ pinned: !agent.metadata.pinned });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update pin.");
    }
  }

  function toggleExpanded(childPath: string) {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(childPath)) next.delete(childPath);
      else next.add(childPath);
      return next;
    });
  }

  return (
    <section className="shrink-0 border-b px-4 py-3 sm:px-6" aria-label="Agent details">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-2">
        <AgentDetailCard
          agent={node.agent}
          nowMs={nowMs}
          onTogglePinned={async () => {
            await updateMetadata({ pinned: !node.agent.metadata.pinned });
          }}
          onRename={(title) => updateMetadata({ title })}
        />
        {descendantCount > 0 ? (
          <div className="flex flex-col gap-1" aria-label="Child agents">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 justify-start px-1 text-xs text-muted-foreground"
              aria-controls={childrenRegionId}
              aria-expanded={childrenOpen}
              onClick={() => setChildrenOpen((open) => !open)}
            >
              <ChevronRight
                className={childrenOpen ? "rotate-90 transition-transform" : "transition-transform"}
              />
              {descendantCount} subagent{descendantCount === 1 ? "" : "s"}
              {activeDescendants > 0 ? ` · ${activeDescendants} active` : ""}
            </Button>
            {childrenOpen ? (
              <div
                id={childrenRegionId}
                className="max-h-40 overflow-y-auto overscroll-contain pr-1 sm:max-h-56"
              >
                <div className="flex flex-col">
                  {visibleChildRows.map(({ node: child, depth }) => (
                    <div
                      key={child.agent.path}
                      style={{ paddingLeft: `${Math.min(depth, 3) * 16}px` }}
                    >
                      <AgentListRow
                        node={child}
                        nowMs={nowMs}
                        expanded={expandedPaths.has(child.agent.path)}
                        onOpen={() =>
                          void navigate(linkOptionsForStreamPath(projectSlug, child.agent.path))
                        }
                        onTogglePinned={() => togglePinned(child.agent)}
                        onToggleChildren={() => toggleExpanded(child.agent.path)}
                      />
                    </div>
                  ))}
                </div>
                {descendantCount > visibleChildRows.length ? (
                  <Link
                    to="/projects/$projectSlug/agents"
                    params={{ projectSlug }}
                    search={{}}
                    className="inline-flex pt-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    View all {descendantCount} subagents in the catalog
                  </Link>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function findAgentNode(forest: readonly AgentTreeNode[], path: string): AgentTreeNode | undefined {
  let match: AgentTreeNode | undefined;
  walkAgentForest(forest, (node) => {
    if (node.agent.path === path) match = node;
  });
  return match;
}

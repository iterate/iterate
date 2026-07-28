import { useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@iterate-com/ui/components/sheet";
import { AgentDetailCard, AgentListRow } from "./agent.tsx";
import { updateAgentSummary } from "./agent-summary.ts";
import {
  agentTitle,
  buildAgentForest,
  flattenVisibleAgentRows,
  walkAgentForest,
  type AgentTreeNode,
} from "./agent-tree.ts";
import type { AgentRuntimeTransition } from "~/domains/agents/agent-processor-contract.ts";
import type { AgentRecord } from "~/domains/agents/agent-presence.ts";
import { linkOptionsForStreamPath } from "~/lib/stream-routes.ts";
import { toggledSet } from "~/lib/tree-rows.ts";
import { useStreamViewPanels } from "~/lib/stream-view-search.ts";
import { useTickingNowMs } from "~/lib/use-ticking-now-ms.ts";

const CLOCK_TICK_MS = 15_000;
const VISIBLE_CHILD_LIMIT = 20;

/**
 * The agent details sheet — path, timestamps, counts, rename, pin, and
 * subagents. The stream page itself carries no agent chrome; the sheet opens
 * from "Agent details" in the header's ⋯ menu (URL-backed like the other
 * right-edge sheets).
 */
export function AgentDetailsSheet({
  agents,
  path,
  projectId,
  projectSlug,
  runtimeTransition,
}: {
  agents: Record<string, AgentRecord>;
  path: string;
  projectId: string;
  projectSlug: string;
  runtimeTransition?: AgentRuntimeTransition;
}) {
  const { agentDetailsOpen, closeAgentDetails } = useStreamViewPanels();
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const nowMs = useTickingNowMs(CLOCK_TICK_MS, agentDetailsOpen);
  const navigate = useNavigate();
  const presentedAgents = useMemo(() => {
    const selected = agents[path];
    if (selected === undefined || runtimeTransition === undefined) return agents;
    return {
      ...agents,
      [path]: {
        ...selected,
        runtime: runtimeTransition.runtime,
        timestamps: {
          ...selected.timestamps,
          runtimeUpdatedAt: runtimeTransition.since,
        },
      },
    };
  }, [agents, path, runtimeTransition]);
  const forest = useMemo(() => buildAgentForest(presentedAgents), [presentedAgents]);
  const node = useMemo(() => findAgentNode(forest, path), [forest, path]);
  const childRows = useMemo(
    () => (node === undefined ? [] : flattenVisibleAgentRows(node.children, expandedPaths)),
    [expandedPaths, node],
  );
  const visibleChildRows = childRows.slice(0, VISIBLE_CHILD_LIMIT);
  const descendantCount = node === undefined ? 0 : node.aggregateAgentCount - 1;

  return (
    <Sheet open={agentDetailsOpen} onOpenChange={(open) => (open ? null : closeAgentDetails())}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-md">
        <SheetHeader className="sr-only">
          <SheetTitle>{node === undefined ? "Agent details" : agentTitle(node.agent)}</SheetTitle>
          <SheetDescription>Agent state, runtime facts, and subagents.</SheetDescription>
        </SheetHeader>
        {node === undefined ? (
          <p className="p-4 text-sm text-muted-foreground">Waiting for this agent's record…</p>
        ) : (
          // pr-10 keeps the card's pencil/star clear of the sheet's close X.
          <div className="flex flex-col gap-4 p-4 pr-10">
            <AgentDetailCard
              agent={node.agent}
              nowMs={nowMs}
              onTogglePinned={() =>
                updateAgentSummary(projectId, path, { pinned: !node.agent.summary.pinned })
              }
              onRename={(title) => updateAgentSummary(projectId, path, { title })}
            />
            {descendantCount > 0 ? (
              <div className="flex flex-col gap-1" aria-label="Subagents">
                <p className="text-xs font-medium text-muted-foreground">
                  {descendantCount} subagent{descendantCount === 1 ? "" : "s"}
                </p>
                <div className="flex flex-col">
                  {visibleChildRows.map(({ node: child, depth, expanded }) => (
                    <div
                      key={child.agent.path}
                      style={{ paddingLeft: `${Math.min(depth, 3) * 16}px` }}
                    >
                      <AgentListRow
                        node={child}
                        nowMs={nowMs}
                        expanded={expanded}
                        onOpen={() => {
                          closeAgentDetails();
                          void navigate(linkOptionsForStreamPath(projectSlug, child.agent.path));
                        }}
                        onTogglePinned={() =>
                          updateAgentSummary(projectId, child.agent.path, {
                            pinned: !child.agent.summary.pinned,
                          })
                        }
                        onToggleChildren={() =>
                          setExpandedPaths((current) => toggledSet(current, child.agent.path))
                        }
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
        )}
      </SheetContent>
    </Sheet>
  );
}

function findAgentNode(forest: readonly AgentTreeNode[], path: string): AgentTreeNode | undefined {
  let match: AgentTreeNode | undefined;
  walkAgentForest(forest, (node) => {
    if (node.agent.path === path) match = node;
  });
  return match;
}

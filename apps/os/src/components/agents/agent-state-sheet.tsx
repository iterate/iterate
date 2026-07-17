import { useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@iterate-com/ui/components/sheet";
import { cn } from "@iterate-com/ui/lib/utils";
import { AgentDetailCard, AgentListRow, StateDot } from "./agent.tsx";
import { patchAgentMetadata } from "./agent-metadata.ts";
import {
  agentNodeDisplayState,
  agentTitle,
  buildAgentForest,
  flattenVisibleAgentRows,
  walkAgentForest,
  type AgentTreeNode,
} from "./agent-tree.ts";
import { AGENT_DISPLAY_STATE_PRESENTATION, bindingIcon } from "./agent-presentation.ts";
import { deriveAgentDisplayState, type AgentRecord } from "~/domains/agents/agent-presence.ts";
import { linkOptionsForStreamPath } from "~/lib/stream-routes.ts";
import { toggledSet } from "~/lib/tree-rows.ts";
import { useTickingNowMs } from "~/lib/use-ticking-now-ms.ts";

const CLOCK_TICK_MS = 15_000;
const VISIBLE_CHILD_LIMIT = 20;

/**
 * The agent stream page shows one quiet strip — channel icon, title, live
 * activity, attention dot. Everything else (path, timestamps, counts, rename,
 * pin, subagents) hides in the sheet the strip opens.
 */
export function AgentStateSheet({
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
  const [open, setOpen] = useState(false);
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const nowMs = useTickingNowMs(CLOCK_TICK_MS, open);
  const navigate = useNavigate();
  const forest = useMemo(() => buildAgentForest(agents), [agents]);
  const node = useMemo(() => findAgentNode(forest, path), [forest, path]);
  const childRows = useMemo(
    () => (node === undefined ? [] : flattenVisibleAgentRows(node.children, expandedPaths)),
    [expandedPaths, node],
  );
  if (node === undefined) return null;
  const agent = node.agent;
  const state = AGENT_DISPLAY_STATE_PRESENTATION[agentNodeDisplayState(node)];
  const BindingIcon = bindingIcon(agent.binding);
  const visibleChildRows = childRows.slice(0, VISIBLE_CHILD_LIMIT);
  const descendantCount = node.aggregateAgentCount - 1;
  const selfActive = deriveAgentDisplayState(agent.runtime) !== "idle";
  const activeDescendants = Math.max(0, node.aggregateActiveCount - (selfActive ? 1 : 0));

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={`Agent state: ${agentTitle(agent)}`}
        className="flex w-full shrink-0 items-center gap-2 border-b px-4 py-2 text-left text-sm hover:bg-accent/40 sm:px-6"
        data-agent-state-trigger
      >
        <BindingIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 shrink-0 truncate font-medium">{agentTitle(agent)}</span>
        {agent.metadata.activity === undefined ? null : (
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-xs text-muted-foreground",
              state.active && "motion-safe:animate-pulse",
            )}
          >
            {agent.metadata.activity}
          </span>
        )}
        <StateDot state={state} className="ml-auto" />
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-md">
          <SheetHeader className="sr-only">
            <SheetTitle>{agentTitle(agent)}</SheetTitle>
            <SheetDescription>Agent state, runtime facts, and subagents.</SheetDescription>
          </SheetHeader>
          {/* pr-10 keeps the card's pencil/star clear of the sheet's close X. */}
          <div className="flex flex-col gap-4 p-4 pr-10">
            <AgentDetailCard
              agent={agent}
              nowMs={nowMs}
              onTogglePinned={() =>
                patchAgentMetadata(projectId, path, { pinned: !agent.metadata.pinned })
              }
              onRename={(title) => patchAgentMetadata(projectId, path, { title })}
            />
            {descendantCount > 0 ? (
              <div className="flex flex-col gap-1" aria-label="Subagents">
                <p className="text-xs font-medium text-muted-foreground">
                  {descendantCount} subagent{descendantCount === 1 ? "" : "s"}
                  {activeDescendants > 0 ? ` · ${activeDescendants} active` : ""}
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
                          setOpen(false);
                          void navigate(linkOptionsForStreamPath(projectSlug, child.agent.path));
                        }}
                        onTogglePinned={() =>
                          patchAgentMetadata(projectId, child.agent.path, {
                            pinned: !child.agent.metadata.pinned,
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
        </SheetContent>
      </Sheet>
    </>
  );
}

function findAgentNode(forest: readonly AgentTreeNode[], path: string): AgentTreeNode | undefined {
  let match: AgentTreeNode | undefined;
  walkAgentForest(forest, (node) => {
    if (node.agent.path === path) match = node;
  });
  return match;
}

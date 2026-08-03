import { useCallback, useMemo, useRef, useState, type ComponentProps } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Link } from "@tanstack/react-router";
import { useLiveState } from "iterate/sdk/itx/react";
import { List, Search, Table2 } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@iterate-com/ui/components/empty";
import { Input } from "@iterate-com/ui/components/input";
import { Tabs, TabsList, TabsTrigger } from "@iterate-com/ui/components/tabs";
import { cn } from "@iterate-com/ui/lib/utils";
import { AgentListRow } from "./agent.tsx";
import { AgentTable } from "./agent-table.tsx";
import { useAgentTreeTable } from "./agent-tree-table.ts";
import { agentMatchesSearch } from "./agent-tree.ts";
import type { AgentRecord } from "~/domains/agents/agent-presence.ts";
import type { AgentCatalogView } from "~/lib/agent-catalog-search.ts";
import { toggledSet } from "~/lib/tree-rows.ts";
import { useTickingNowMs } from "~/lib/use-ticking-now-ms.ts";

const CLOCK_TICK_MS = 15_000;
const NO_AGENTS: Record<string, AgentRecord> = {};

export function AgentCatalog({
  agents,
  onOpen,
  onTogglePinned,
  projectId,
  projectSlug,
  view = "list",
  onViewChange,
}: {
  /** Undefined for the one round trip before live state arrives. */
  agents: Record<string, AgentRecord> | undefined;
  onOpen: (path: string) => void;
  onTogglePinned: (agent: AgentRecord) => void | Promise<unknown>;
  projectId: string;
  projectSlug: string;
  view?: AgentCatalogView;
  onViewChange?: (view: AgentCatalogView) => void;
}) {
  const [query, setQuery] = useState("");
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [collapsedTablePaths, setCollapsedTablePaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const searching = query.trim() !== "";
  const normalizedQuery = query.trim().toLowerCase();
  const nowMs = useTickingNowMs(CLOCK_TICK_MS);
  const catalogAgents = agents ?? NO_AGENTS;
  const agentCount = Object.keys(catalogAgents).length;
  const matchCount = useMemo(
    () =>
      searching
        ? Object.values(catalogAgents).filter((agent) => agentMatchesSearch(agent, normalizedQuery))
            .length
        : agentCount,
    [agentCount, catalogAgents, normalizedQuery, searching],
  );

  const toggleExpanded = useCallback((path: string) => {
    setExpandedPaths((current) => toggledSet(current, path));
  }, []);
  const toggleTableCollapsed = useCallback((path: string) => {
    setCollapsedTablePaths((current) => toggledSet(current, path));
  }, []);

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Agents catalog">
      <div className="shrink-0 border-b px-4 py-3 sm:px-6">
        <div
          className={cn(
            "mx-auto flex w-full items-center gap-3",
            view === "list" ? "max-w-3xl" : "max-w-none",
          )}
        >
          <div className="relative min-w-0 flex-1">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search agents"
              className="pl-8"
              aria-label="Search agents"
            />
          </div>
          {agents === undefined ? null : (
            <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:block">
              {searching
                ? `${matchCount} ${matchCount === 1 ? "match" : "matches"}`
                : `${agentCount} ${agentCount === 1 ? "agent" : "agents"}`}
            </span>
          )}
          <Tabs
            value={view}
            onValueChange={(value) => {
              if (value === "list" || value === "table") onViewChange?.(value);
            }}
          >
            <TabsList aria-label="Agents view">
              <TabsTrigger value="list" aria-label="List view">
                <List />
                <span className="hidden sm:inline">List</span>
              </TabsTrigger>
              <TabsTrigger value="table" aria-label="Table view">
                <Table2 />
                <span className="hidden sm:inline">Table</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Button
            nativeButton={false}
            size="sm"
            render={<Link to="/projects/$projectSlug" params={{ projectSlug }} search={{}} />}
          >
            New agent
          </Button>
        </div>
      </div>

      {agents === undefined ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Loading agents…</p>
      ) : matchCount === 0 ? (
        <AgentCatalogEmpty agentCount={agentCount} />
      ) : view === "table" ? (
        <div className="min-h-0 flex-1">
          <AgentTable
            agents={catalogAgents}
            collapsedPaths={collapsedTablePaths}
            nowMs={nowMs}
            projectId={projectId}
            query={query}
            onOpen={onOpen}
            onToggleExpanded={toggleTableCollapsed}
            onTogglePinned={onTogglePinned}
          />
        </div>
      ) : (
        <AgentCatalogList
          agents={catalogAgents}
          expandedPaths={expandedPaths}
          nowMs={nowMs}
          projectId={projectId}
          query={query}
          searching={searching}
          onOpen={onOpen}
          onToggleExpanded={toggleExpanded}
          onTogglePinned={onTogglePinned}
        />
      )}
    </section>
  );
}

function AgentCatalogEmpty({ agentCount }: { agentCount: number }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 sm:px-6">
      <div className="mx-auto w-full max-w-3xl py-2">
        <Empty className="my-4 min-h-52 rounded-lg border">
          <EmptyHeader>
            <EmptyTitle>{agentCount === 0 ? "No agents yet" : "No matches"}</EmptyTitle>
            <EmptyDescription>
              {agentCount === 0
                ? "Create an agent to start a durable conversation."
                : "Try a title, activity, path, or integration name."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    </div>
  );
}

function AgentCatalogList({
  agents,
  expandedPaths,
  nowMs,
  projectId,
  query,
  searching,
  onOpen,
  onToggleExpanded,
  onTogglePinned,
}: {
  agents: Record<string, AgentRecord>;
  expandedPaths: ReadonlySet<string>;
  nowMs: number;
  projectId: string;
  query: string;
  searching: boolean;
  onOpen: (path: string) => void;
  onToggleExpanded: (path: string) => void;
  onTogglePinned: (agent: AgentRecord) => void | Promise<unknown>;
}) {
  const table = useAgentTreeTable({ agents, expandedPaths, query });
  const rows = table.getRowModel().rows;
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 61,
    overscan: 6,
  });
  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 sm:px-6">
      <div className="mx-auto w-full max-w-3xl py-2">
        <ul className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (row === undefined) return null;
            const node = row.original;
            return (
              <li
                key={node.agent.path}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                className="absolute left-0 top-0 w-full"
                style={{
                  transform: `translateY(${virtualRow.start}px)`,
                  paddingLeft: `${Math.min(row.depth, 6) * 16}px`,
                }}
              >
                <LiveAgentListRow
                  node={node}
                  nowMs={nowMs}
                  projectId={projectId}
                  expanded={row.getIsExpanded()}
                  onOpen={() => onOpen(node.agent.path)}
                  onTogglePinned={() => onTogglePinned(node.agent)}
                  onToggleChildren={searching ? undefined : () => onToggleExpanded(node.agent.path)}
                />
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/** Runtime is transient agent live state, so only the bounded virtualized rows
 * subscribe to it. The 5,000-agent collection projection remains summary-only. */
function LiveAgentListRow({
  node,
  projectId,
  ...props
}: Omit<ComponentProps<typeof AgentListRow>, "runtimeTransition"> & {
  projectId: string;
}) {
  const runtimeTransition = useLiveState(
    (itx) => itx.agents.get(node.agent.path).liveState,
    (state) => state.runtimeChange,
    [node.agent.path],
    { slug: projectId },
  ).value;
  return <AgentListRow {...props} node={node} runtimeTransition={runtimeTransition} />;
}

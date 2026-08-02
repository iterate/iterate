import { useMemo } from "react";
import {
  getCoreRowModel,
  getExpandedRowModel,
  getFilteredRowModel,
  useReactTable,
  type ColumnDef,
  type ExpandedState,
} from "@tanstack/react-table";
import { agentSearchText, buildAgentForest, type AgentTreeNode } from "./agent-tree.ts";
import type { AgentRecord } from "~/domains/agents/agent-presence.ts";

const SEARCH_COLUMN: ColumnDef<AgentTreeNode>[] = [
  {
    id: "search",
    accessorFn: (node) => agentSearchText(node.agent),
  },
];

/** Shared hierarchical row model for the catalog table and cmdk listbox. */
export function useAgentTreeTable({
  agents,
  expandedPaths,
  query,
}: {
  agents: Record<string, AgentRecord>;
  expandedPaths: ReadonlySet<string>;
  query: string;
}) {
  const forest = useMemo(() => buildAgentForest(agents), [agents]);
  const searching = query.trim() !== "";
  const expanded = useMemo<ExpandedState>(() => {
    if (searching) return true;
    return Object.fromEntries([...expandedPaths].map((path) => [path, true]));
  }, [expandedPaths, searching]);

  return useReactTable({
    data: forest,
    columns: SEARCH_COLUMN,
    state: { expanded, globalFilter: query },
    getRowId: (node) => node.agent.path,
    getSubRows: (node) => node.children,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    filterFromLeafRows: true,
  });
}

import { useMemo } from "react";
import {
  getCoreRowModel,
  getExpandedRowModel,
  getFilteredRowModel,
  useReactTable,
  type ColumnDef,
  type ExpandedState,
} from "@tanstack/react-table";
import {
  agentPathSearchText,
  buildAgentPathForest,
  type AgentPathTreeNode,
} from "./agent-path-tree.ts";
import type { AgentRecord } from "~/domains/agents/agent-presence.ts";

const SEARCH_COLUMN: ColumnDef<AgentPathTreeNode>[] = [
  {
    id: "search",
    accessorFn: agentPathSearchText,
  },
];

/** TanStack Table row model for the filesystem-style agent path forest. Every
 * branch is open by default; `collapsedPaths` records only user exceptions. */
export function useAgentPathTable({
  agents,
  collapsedPaths,
  query,
}: {
  agents: Record<string, AgentRecord>;
  collapsedPaths: ReadonlySet<string>;
  query: string;
}) {
  const forest = useMemo(() => buildAgentPathForest(agents), [agents]);
  const normalizedQuery = query.trim();
  const searching = normalizedQuery !== "";
  const expanded = useMemo<ExpandedState>(() => {
    if (searching) return true;
    const entries: [string, boolean][] = [];
    const visit = (node: AgentPathTreeNode) => {
      if (node.children.length > 0 && !collapsedPaths.has(node.path)) {
        entries.push([node.path, true]);
      }
      for (const child of node.children) visit(child);
    };
    for (const root of forest) visit(root);
    return Object.fromEntries(entries);
  }, [collapsedPaths, forest, searching]);

  return useReactTable({
    data: forest,
    columns: SEARCH_COLUMN,
    state: { expanded, globalFilter: normalizedQuery },
    getRowId: (node) => node.path,
    getSubRows: (node) => node.children,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    filterFromLeafRows: true,
  });
}

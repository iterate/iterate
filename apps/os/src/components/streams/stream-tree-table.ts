import { useMemo } from "react";
import {
  getCoreRowModel,
  getExpandedRowModel,
  getFilteredRowModel,
  useReactTable,
  type ColumnDef,
  type ExpandedState,
} from "@tanstack/react-table";
import type { StreamIndexRow } from "~/domains/projects/stream-database.ts";

/** A real indexed stream or a synthesized file-system-like path container. */
export type StreamTreeNode = {
  path: string;
  indexRow?: StreamIndexRow;
  children: StreamTreeNode[];
};

const SEARCH_COLUMN: ColumnDef<StreamTreeNode>[] = [
  {
    id: "search",
    accessorFn: (node) => node.path.toLowerCase(),
  },
];

/** Build a file-system-like hierarchy from the materialized project stream index. */
export function buildIndexedStreamForest(
  streams: Record<string, StreamIndexRow>,
): StreamTreeNode[] {
  const nodes = new Map<string, StreamTreeNode>();
  const ensureNode = (path: string): StreamTreeNode => {
    const existing = nodes.get(path);
    if (existing) return existing;

    const node: StreamTreeNode = { path, children: [] };
    nodes.set(path, node);
    if (path !== "/") {
      const boundary = path.lastIndexOf("/");
      const parentPath = boundary > 0 ? path.slice(0, boundary) : "/";
      ensureNode(parentPath).children.push(node);
    }
    return node;
  };

  for (const stream of Object.values(streams)) ensureNode(stream.path).indexRow = stream;

  const root = nodes.get("/");
  if (!root) return [];
  sortStreamNodes(root.children);
  return [root];
}

/** Shared hierarchical row model for every stream-index tree. */
export function useIndexedStreamTreeTable({
  streams,
  collapsedPaths,
  query,
}: {
  streams: Record<string, StreamIndexRow>;
  collapsedPaths: ReadonlySet<string>;
  query: string;
}) {
  const forest = useMemo(() => buildIndexedStreamForest(streams), [streams]);
  const normalizedQuery = query.trim();
  const searching = normalizedQuery !== "";
  const expanded = useMemo<ExpandedState>(() => {
    if (searching) return true;
    const expandedPaths: [string, boolean][] = [];
    const visit = (node: StreamTreeNode) => {
      if (node.children.length && !collapsedPaths.has(node.path)) {
        expandedPaths.push([node.path, true]);
      }
      for (const child of node.children) visit(child);
    };
    for (const root of forest) visit(root);
    return Object.fromEntries(expandedPaths);
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

export function streamTreeLabel(path: string): string {
  if (path === "/") return "/";
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

export function formatEventCount(count: number): string {
  return count === 1 ? "1 event" : `${count.toLocaleString()} events`;
}

function sortStreamNodes(nodes: StreamTreeNode[]): void {
  nodes.sort((left, right) => left.path.localeCompare(right.path));
  for (const node of nodes) sortStreamNodes(node.children);
}

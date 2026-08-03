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
import { closestAncestorByPath } from "~/lib/tree-rows.ts";

/** A real indexed stream or a synthesized file-system-like path container. */
export type StreamTreeNode = {
  path: string;
  eventCount?: number;
  indexed: boolean;
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
  for (const stream of Object.values(streams)) {
    for (const path of streamTreePathPrefixes(stream.path)) {
      if (!nodes.has(path)) {
        nodes.set(path, { path, indexed: false, children: [] });
      }
    }
    let node = nodes.get(stream.path);
    if (node === undefined) {
      node = { path: stream.path, indexed: false, children: [] };
      nodes.set(stream.path, node);
    }
    node.eventCount = stream.eventCount;
    node.indexed = true;
  }
  const roots: StreamTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent =
      closestAncestorByPath(node.path, nodes) ?? (node.path === "/" ? undefined : nodes.get("/"));
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
  }
  sortStreamNodes(roots);
  return roots;
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
      if (node.children.length > 0 && !collapsedPaths.has(node.path)) {
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

/** Every file-system-like container needed to place one indexed path. */
function streamTreePathPrefixes(path: string): string[] {
  const prefixes = ["/"];
  let boundary = path.indexOf("/", 1);
  while (boundary >= 0) {
    prefixes.push(path.slice(0, boundary));
    boundary = path.indexOf("/", boundary + 1);
  }
  if (!prefixes.includes(path)) prefixes.push(path);
  return prefixes;
}

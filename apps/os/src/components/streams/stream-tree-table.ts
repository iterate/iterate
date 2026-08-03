import { useMemo } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import {
  getCoreRowModel,
  getExpandedRowModel,
  getFilteredRowModel,
  useReactTable,
  type ColumnDef,
  type ExpandedState,
} from "@tanstack/react-table";
import type { StreamIndexRow } from "~/domains/projects/stream-database.ts";
import { normalizePath } from "~/domains/durable-object-names.ts";
import { closestAncestorByPath } from "~/lib/tree-rows.ts";
import { readStreamStateOnce, type StreamTreeSource } from "~/lib/stream-navigation.ts";

export type StreamTreeNode = {
  path: string;
  eventCount?: number;
  loadState: "loaded" | "loading" | "error";
  children: StreamTreeNode[];
};

type RemoteStreamNodeData = {
  eventCount: number;
  childPaths: string[];
};

export type RemoteStreamNodeSnapshot = {
  path: string;
  loadState: StreamTreeNode["loadState"];
  data?: RemoteStreamNodeData;
};

const SEARCH_COLUMN: ColumnDef<StreamTreeNode>[] = [
  {
    id: "search",
    accessorFn: (node) => node.path.toLowerCase(),
  },
];

/** Build the hierarchy exposed by the materialized project stream index. */
export function buildIndexedStreamForest(
  streams: Record<string, StreamIndexRow>,
): StreamTreeNode[] {
  const nodes = new Map<string, StreamTreeNode>(
    Object.values(streams).map((stream) => [
      stream.path,
      {
        path: stream.path,
        eventCount: stream.eventCount,
        loadState: "loaded",
        children: [],
      },
    ]),
  );
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

/** Build the same hierarchy from lazy remote snapshots and their explicit child links. */
export function buildRemoteStreamForest(
  snapshots: readonly RemoteStreamNodeSnapshot[],
): StreamTreeNode[] {
  const nodes = new Map<string, StreamTreeNode>();

  for (const snapshot of snapshots) {
    nodes.set(snapshot.path, {
      path: snapshot.path,
      eventCount: snapshot.data?.eventCount,
      loadState: snapshot.loadState,
      children: [],
    });
  }
  for (const snapshot of snapshots) {
    for (const childPath of snapshot.data?.childPaths ?? []) {
      if (!nodes.has(childPath)) {
        nodes.set(childPath, {
          path: childPath,
          loadState: "loading",
          children: [],
        });
      }
    }
  }

  const roots: StreamTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent =
      closestAncestorByPath(node.path, nodes) ?? (node.path === "/" ? undefined : nodes.get("/"));
    if (parent === undefined || parent === node) roots.push(node);
    else parent.children.push(node);
  }
  sortStreamNodes(roots);
  return roots;
}

/** Shared hierarchical row model for indexed Cmd+K and lazy admin streams. */
export function useStreamTreeTable({
  forest,
  expansionMode,
  expansionPaths,
  query,
}: {
  forest: StreamTreeNode[];
  expansionMode: "expanded" | "collapsed";
  expansionPaths: ReadonlySet<string>;
  query: string;
}) {
  const normalizedQuery = query.trim();
  const searching = normalizedQuery !== "";
  const expanded = useMemo<ExpandedState>(() => {
    if (searching) return true;
    if (expansionMode === "expanded") {
      return Object.fromEntries([...expansionPaths].map((path) => [path, true]));
    }

    const expandedPaths: [string, boolean][] = [];
    const visit = (node: StreamTreeNode) => {
      if (node.children.length > 0 && !expansionPaths.has(node.path)) {
        expandedPaths.push([node.path, true]);
      }
      for (const child of node.children) visit(child);
    };
    for (const root of forest) visit(root);
    return Object.fromEntries(expandedPaths);
  }, [expansionMode, expansionPaths, forest, searching]);

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
  return useStreamTreeTable({
    forest,
    expansionMode: "collapsed",
    expansionPaths: collapsedPaths,
    query,
  });
}

/**
 * Lazy admin adapter. It observes one query per visible node and lets cached
 * child lists grow the query set on the next render. Collapsed subtrees stay
 * cached but inactive, so remote work remains bounded by what the user opens.
 */
export function useRemoteStreamTreeTable({
  currentPath,
  expandedPaths,
  scope,
  source,
}: {
  currentPath: string;
  expandedPaths: ReadonlySet<string>;
  scope: string;
  source: StreamTreeSource;
}) {
  const queryClient = useQueryClient();
  const queryPrefix = ["remote-stream-tree", scope] as const;
  const cachedNodes = queryClient.getQueriesData<RemoteStreamNodeData>({ queryKey: queryPrefix });
  const cachedByPath = new Map<string, RemoteStreamNodeData>();
  for (const [queryKey, data] of cachedNodes) {
    const path = queryKey.at(-1);
    if (typeof path === "string" && data !== undefined) cachedByPath.set(path, data);
  }

  const pathsToLoad = new Set(["/", ...streamPathPrefixes(currentPath)]);
  let discoveredVisiblePath = true;
  while (discoveredVisiblePath) {
    discoveredVisiblePath = false;
    for (const path of pathsToLoad) {
      if (!expandedPaths.has(path)) continue;
      for (const childPath of cachedByPath.get(path)?.childPaths ?? []) {
        if (pathsToLoad.has(childPath)) continue;
        pathsToLoad.add(childPath);
        discoveredVisiblePath = true;
      }
    }
  }
  const orderedPathSignature = [...pathsToLoad].toSorted().join("\0");
  const orderedPaths = useMemo(() => orderedPathSignature.split("\0"), [orderedPathSignature]);
  const snapshots = useQueries({
    queries: orderedPaths.map((path) => ({
      queryKey: [...queryPrefix, path],
      queryFn: async (): Promise<RemoteStreamNodeData> => {
        const streamState = await readStreamStateOnce(source, normalizePath(path));
        return {
          eventCount: streamState.eventCount,
          childPaths: streamState.childPaths.toSorted(),
        };
      },
    })),
    combine: (results) =>
      orderedPaths.map<RemoteStreamNodeSnapshot>((path, index) => {
        const result = results[index];
        if (result?.data !== undefined) {
          return {
            path,
            loadState: result.isError ? "error" : "loaded",
            data: result.data,
          };
        }
        if (result?.isError) return { path, loadState: "error" };
        return { path, loadState: "loading" };
      }),
  });
  const forest = useMemo(() => buildRemoteStreamForest(snapshots), [snapshots]);
  const table = useStreamTreeTable({
    forest,
    expansionMode: "expanded",
    expansionPaths: expandedPaths,
    query: "",
  });

  return {
    table,
    retryPath(path: string) {
      void queryClient.refetchQueries({ queryKey: [...queryPrefix, path], exact: true });
    },
  };
}

export function streamTreeLabel(path: string): string {
  if (path === "/") return "/";
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

export function formatEventCount(count: number): string {
  return count === 1 ? "1 event" : `${count.toLocaleString()} events`;
}

function streamPathPrefixes(path: string): string[] {
  const segments = path.split("/").filter(Boolean);
  return segments.map((_, index) => `/${segments.slice(0, index + 1).join("/")}`);
}

function sortStreamNodes(nodes: StreamTreeNode[]): void {
  nodes.sort((left, right) => left.path.localeCompare(right.path));
  for (const node of nodes) sortStreamNodes(node.children);
}

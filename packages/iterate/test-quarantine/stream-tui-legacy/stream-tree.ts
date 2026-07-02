// QUARANTINED (itx-v4 cutover, Phase 10): origin packages/iterate/src/stream-tui/stream-tree.ts.
// Part of the legacy stream-browser TUI built on the old engine's /api/itx/run
// client; superseded by the agent chat TUI in src/stream-tui/. See ../README.md.

import { StreamPath, type StreamPath as StreamPathType } from "@iterate-com/shared/streams/types";
import {
  fuzzyMatchRanges,
  splitMatchedSegments,
  type FuzzyMatchRange,
  type SlashCommandLabelSegment,
} from "./command-discovery.ts";
import type { StreamSummary } from "./command-router.ts";

export type StreamTreeNode = {
  path: StreamPathType;
  createdAt: string | undefined;
  children: StreamTreeNode[];
};

export type StreamTreeRow = {
  path: StreamPathType;
  createdAt: string | undefined;
  depth: number;
  expanded: boolean;
  hasChildren: boolean;
  current: boolean;
  selected: boolean;
  labelSegments: SlashCommandLabelSegment[];
};

const segmentCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

export function getDefaultExpandedStreamPaths(currentStreamPath: StreamPathType) {
  return new Set<StreamPathType>([
    "/",
    ...getAncestorStreamPaths(currentStreamPath),
    currentStreamPath,
  ]);
}

export function getStreamTreeRows(args: {
  streams: readonly StreamSummary[];
  currentStreamPath: StreamPathType;
  expandedPaths: ReadonlySet<StreamPathType>;
  searchQuery: string;
  selectedPath?: StreamPathType;
}) {
  const search = rankStreamPaths({
    paths: materializeStreamPaths([
      args.currentStreamPath,
      ...args.streams.map((stream) => stream.path),
    ]),
    query: args.searchQuery,
  });
  const visiblePaths =
    args.searchQuery.trim().length === 0
      ? undefined
      : new Set<StreamPathType>([
          "/",
          ...search.map((result) => result.path),
          ...search.flatMap((result) => getAncestorStreamPaths(result.path)),
        ]);
  const forcedExpandedPaths =
    visiblePaths == null
      ? getDefaultExpandedStreamPaths(args.currentStreamPath)
      : new Set<StreamPathType>(
          [...visiblePaths].flatMap((path) => [path, ...getAncestorStreamPaths(path)]),
        );
  const rows: StreamTreeRow[] = [];
  const scoreByPath = new Map(search.map((result) => [result.path, result.score]));
  const matchRangesByPath = new Map(search.map((result) => [result.path, result.ranges]));
  const root = buildStreamTree({
    streams: args.streams,
    currentStreamPath: args.currentStreamPath,
    scoreByPath,
  });

  appendRows({
    rows,
    node: root,
    depth: 0,
    currentStreamPath: args.currentStreamPath,
    expandedPaths: new Set([...args.expandedPaths, ...forcedExpandedPaths]),
    visiblePaths,
    selectedPath: args.selectedPath,
    matchRangesByPath,
  });

  return rows;
}

export function rankStreamPaths(args: { paths: readonly StreamPathType[]; query: string }) {
  const query = args.query.trim().toLowerCase();
  if (query.length === 0) {
    return args.paths.map((path) => ({ path, score: 1, ranges: [] as FuzzyMatchRange[] }));
  }

  return args.paths
    .map((path) => ({
      path,
      score: scoreStreamPath({ path, query }),
      ranges: fuzzyMatchRanges(path, query),
    }))
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
}

function buildStreamTree(args: {
  streams: readonly StreamSummary[];
  currentStreamPath: StreamPathType;
  scoreByPath: ReadonlyMap<StreamPathType, number>;
}) {
  const createdAtByPath = new Map(args.streams.map((stream) => [stream.path, stream.createdAt]));
  const allPaths = materializeStreamPaths([args.currentStreamPath, ...createdAtByPath.keys()]);
  const nodes = new Map<StreamPathType, StreamTreeNode>(
    allPaths.map((path) => [path, { path, createdAt: createdAtByPath.get(path), children: [] }]),
  );

  for (const path of allPaths) {
    if (path === "/") continue;
    nodes.get(getParentStreamPath(path))?.children.push(nodes.get(path)!);
  }

  for (const node of nodes.values()) {
    node.children.sort((left, right) => {
      const scoreDifference =
        (args.scoreByPath.get(right.path) ?? 0) - (args.scoreByPath.get(left.path) ?? 0);
      if (scoreDifference !== 0) return scoreDifference;

      return segmentCollator.compare(getPathSegment(left.path), getPathSegment(right.path));
    });
  }

  return nodes.get("/")!;
}

function appendRows(args: {
  rows: StreamTreeRow[];
  node: StreamTreeNode;
  depth: number;
  currentStreamPath: StreamPathType;
  expandedPaths: ReadonlySet<StreamPathType>;
  visiblePaths?: ReadonlySet<StreamPathType>;
  selectedPath?: StreamPathType;
  matchRangesByPath: ReadonlyMap<StreamPathType, readonly FuzzyMatchRange[]>;
}) {
  if (args.visiblePaths != null && !args.visiblePaths.has(args.node.path)) {
    return;
  }

  const expanded = args.expandedPaths.has(args.node.path);
  args.rows.push({
    path: args.node.path,
    createdAt: args.node.createdAt,
    depth: args.depth,
    expanded,
    hasChildren: args.node.children.length > 0,
    current: args.node.path === args.currentStreamPath,
    selected: args.node.path === args.selectedPath,
    labelSegments: splitMatchedSegments({
      text: args.node.path,
      ranges: args.matchRangesByPath.get(args.node.path) ?? [],
    }),
  });

  if (!expanded) return;

  for (const child of args.node.children) {
    appendRows({
      ...args,
      node: child,
      depth: args.depth + 1,
    });
  }
}

function scoreStreamPath(args: { path: StreamPathType; query: string }) {
  const path = args.path.toLowerCase();
  const segment = getPathSegment(args.path).toLowerCase();

  if (path === args.query) return 100;
  if (segment === args.query) return 95;
  if (path.startsWith(args.query)) return 80;
  if (segment.startsWith(args.query)) return 75;
  if (path.includes(args.query)) return 45;
  if (segment.includes(args.query)) return 40;
  return fuzzyMatchRanges(path, args.query).length > 0 ? 20 : 0;
}

function materializeStreamPaths(streamPaths: readonly StreamPathType[]) {
  const allPaths = new Set<StreamPathType>(["/"]);

  for (const path of streamPaths) {
    allPaths.add(path);

    for (const ancestorPath of getAncestorStreamPaths(path)) {
      allPaths.add(ancestorPath);
    }
  }

  return Array.from(allPaths).sort(compareStreamPaths);
}

function getAncestorStreamPaths(path: StreamPathType) {
  if (path === "/") return [];

  const segments = path.split("/").filter(Boolean);
  return segments
    .slice(0, -1)
    .map((_, index) => StreamPath.parse(`/${segments.slice(0, index + 1).join("/")}`));
}

function getParentStreamPath(path: StreamPathType) {
  if (path === "/") return "/";

  const parentPath = path.slice(0, path.lastIndexOf("/"));
  return parentPath.length === 0 ? "/" : StreamPath.parse(parentPath);
}

function getPathDepth(path: StreamPathType) {
  return path === "/" ? 0 : path.split("/").length - 1;
}

function getPathSegment(path: StreamPathType) {
  return path === "/" ? "/" : (path.split("/").at(-1) ?? "/");
}

function compareStreamPaths(left: StreamPathType, right: StreamPathType) {
  const depthDifference = getPathDepth(left) - getPathDepth(right);
  if (depthDifference !== 0) return depthDifference;

  return segmentCollator.compare(left, right);
}

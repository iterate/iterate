import type { Event, StreamPath as StreamPathType } from "@iterate-com/events-contract";
import { StreamPath } from "@iterate-com/events-contract";
import { getAncestorStreamPaths } from "~/lib/stream-path-ancestors.ts";

export type StreamsSidebarTreeNode = {
  path: StreamPathType;
  children: StreamsSidebarTreeNode[];
};

const segmentCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

export function getStreamsSidebarState({
  streamPaths,
  currentStreamPath,
}: {
  streamPaths: readonly StreamPathType[];
  currentStreamPath?: StreamPathType | null;
}) {
  const allPaths = materializeStreamPaths(streamPaths);
  const nodes = new Map<StreamPathType, StreamsSidebarTreeNode>(
    allPaths.map((path) => [path, { path, children: [] }]),
  );

  for (const path of allPaths) {
    if (path === "/") {
      continue;
    }

    nodes.get(getParentStreamPath(path))?.children.push(nodes.get(path)!);
  }

  for (const node of nodes.values()) {
    node.children.sort((left, right) =>
      segmentCollator.compare(getPathSegment(left.path), getPathSegment(right.path)),
    );
  }

  return {
    root: nodes.get("/")!,
    defaultExpandedPaths: getDefaultExpandedPaths(currentStreamPath),
  };
}

export function discoverStreamPaths(events: readonly Event[]) {
  const streamPaths = new Set<StreamPathType>(["/"]);

  for (const event of events) {
    if (event.type === "https://events.iterate.com/events/stream/child-stream-created") {
      streamPaths.add(
        (event as Event & { payload: { childPath: StreamPathType } }).payload.childPath,
      );
    }
  }

  return Array.from(streamPaths);
}

export function filterStreamPaths(streamPaths: readonly StreamPathType[], query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return streamPaths;
  }

  return streamPaths.filter((path) => path.toLowerCase().includes(normalizedQuery));
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

function getDefaultExpandedPaths(currentStreamPath: StreamPathType | null | undefined) {
  if (!currentStreamPath) {
    return ["/"];
  }

  return [
    ...new Set<StreamPathType>([
      "/",
      ...getAncestorStreamPaths(currentStreamPath),
      currentStreamPath,
    ]),
  ];
}

function compareStreamPaths(left: StreamPathType, right: StreamPathType) {
  const depthDifference = getPathDepth(left) - getPathDepth(right);
  if (depthDifference !== 0) {
    return depthDifference;
  }

  return segmentCollator.compare(left, right);
}

function getParentStreamPath(path: StreamPathType) {
  if (path === "/") {
    return "/";
  }

  const parentPath = path.slice(0, path.lastIndexOf("/"));
  return parentPath.length === 0 ? "/" : StreamPath.parse(parentPath);
}

function getPathDepth(path: StreamPathType) {
  return path === "/" ? 0 : path.split("/").length - 1;
}

function getPathSegment(path: StreamPathType) {
  return path === "/" ? "/" : (path.split("/").at(-1) ?? "/");
}

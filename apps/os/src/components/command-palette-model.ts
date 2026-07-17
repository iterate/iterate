import type { StreamIndexRow } from "~/domains/projects/stream-database.ts";
import { StreamPath } from "~/lib/stream-links.ts";
import {
  closestAncestorByPath,
  flattenTreeRows,
  toggledSet,
  type TreeRow,
} from "~/lib/tree-rows.ts";

export type PaletteTab = "agents" | "tree" | "recent";

type PaletteKeyboardTarget =
  | { kind: "agent"; path: string; shortcut: boolean }
  | { kind: "stream"; path: string };

export type PaletteKeyboardAction = "toggle_pin" | "expand" | "collapse";

/** cmdk identifies rows by value, so a pinned shortcut and its structural row
 * need distinct identities even though both open the same agent path. */
export function agentCommandValue(path: string, shortcut: boolean): string {
  return `${shortcut ? "pinned" : "agent"}:${path}`;
}

export function paletteKeyboardTarget(
  tab: PaletteTab,
  selectedValue: string,
): PaletteKeyboardTarget | undefined {
  if (tab === "agents") {
    if (selectedValue.startsWith("pinned:")) {
      return { kind: "agent", path: selectedValue.slice("pinned:".length), shortcut: true };
    }
    if (selectedValue.startsWith("agent:")) {
      return { kind: "agent", path: selectedValue.slice("agent:".length), shortcut: false };
    }
    return undefined;
  }
  if (tab === "tree" && selectedValue.startsWith("/")) {
    return { kind: "stream", path: selectedValue };
  }
  return undefined;
}

export function paletteKeyboardAction(input: {
  target: PaletteKeyboardTarget;
  key: string;
  shiftKey: boolean;
  query: string;
  hasChildren: boolean;
  expanded: boolean;
}): PaletteKeyboardAction | undefined {
  if (input.target.kind === "agent" && input.shiftKey && input.key.toLowerCase() === "p") {
    return "toggle_pin";
  }
  if (input.query.trim() !== "" || (input.target.kind === "agent" && input.target.shortcut)) {
    return undefined;
  }
  if (!input.hasChildren) return undefined;
  if (input.key === "ArrowRight" && !input.expanded) return "expand";
  if (input.key === "ArrowLeft" && input.expanded) return "collapse";
  return undefined;
}

export function hasPathDescendant(paths: Iterable<string>, path: string): boolean {
  const prefix = path === "/" ? "/" : `${path}/`;
  for (const candidate of paths) {
    if (candidate !== path && candidate.startsWith(prefix)) return true;
  }
  return false;
}

export function isPaletteResultKeyboardTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    (target.matches('[data-slot="command-input"]') ||
      target.closest('[data-slot="command-item"]') !== null)
  );
}

type PaletteStreamTreeNode = {
  row: StreamIndexRow;
  children: PaletteStreamTreeNode[];
};

export function buildStreamForest(
  streams: Record<string, StreamIndexRow>,
): PaletteStreamTreeNode[] {
  const nodes = new Map<string, PaletteStreamTreeNode>(
    Object.values(streams).map((row) => [row.path, { row, children: [] }]),
  );
  const roots: PaletteStreamTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent =
      closestAncestorByPath(node.row.path, nodes) ??
      (node.row.path === "/" ? undefined : nodes.get("/"));
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
  }
  const sort = (nodesToSort: PaletteStreamTreeNode[]) => {
    nodesToSort.sort((left, right) => left.row.path.localeCompare(right.row.path));
    for (const node of nodesToSort) sort(node.children);
  };
  sort(roots);
  return roots;
}

const STREAM_TREE_SHAPE = {
  children: (node: PaletteStreamTreeNode) => node.children,
  key: (node: PaletteStreamTreeNode) => node.row.path,
  matches: (node: PaletteStreamTreeNode, query: string) =>
    node.row.path.toLowerCase().includes(query),
};

export function flattenStreamRows(
  forest: readonly PaletteStreamTreeNode[],
  expandedPaths: ReadonlySet<string>,
  query: string,
): TreeRow<PaletteStreamTreeNode>[] {
  return flattenTreeRows(forest, STREAM_TREE_SHAPE, expandedPaths, query);
}

type PaletteDialogState = {
  tab: PaletteTab;
  query: string;
  selectedValue: string;
  expandedAgentPaths: ReadonlySet<string>;
  expandedStreamPaths: ReadonlySet<string>;
};

export function initialPaletteDialogState(): PaletteDialogState {
  return {
    tab: "agents",
    query: "",
    selectedValue: "",
    expandedAgentPaths: new Set(),
    expandedStreamPaths: new Set(),
  };
}

type PaletteDialogAction =
  | { type: "closed" }
  | { type: "opened"; tab: PaletteTab; expandedStreamPaths: ReadonlySet<string> }
  | { type: "query_changed"; query: string }
  | { type: "selection_changed"; selectedValue: string }
  | { type: "tab_changed"; tab: PaletteTab }
  | { type: "agent_toggled"; path: string }
  | { type: "stream_toggled"; path: string };

export function reducePaletteDialogState(
  state: PaletteDialogState,
  action: PaletteDialogAction,
): PaletteDialogState {
  switch (action.type) {
    case "closed":
      return { ...state, query: "", selectedValue: "" };
    case "opened":
      return {
        tab: action.tab,
        query: "",
        selectedValue: "",
        expandedAgentPaths: new Set(),
        expandedStreamPaths: action.expandedStreamPaths,
      };
    case "query_changed":
      return { ...state, query: action.query, selectedValue: "" };
    case "selection_changed":
      return { ...state, selectedValue: action.selectedValue };
    case "tab_changed":
      return { ...state, tab: action.tab, selectedValue: "" };
    case "agent_toggled":
      return {
        ...state,
        expandedAgentPaths: toggledSet(state.expandedAgentPaths, action.path),
      };
    case "stream_toggled":
      return {
        ...state,
        expandedStreamPaths: toggledSet(state.expandedStreamPaths, action.path),
      };
  }
}

export function normalizeDestination(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.endsWith("/")) return null;
  const candidate = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const parsed = StreamPath.safeParse(candidate);
  return parsed.success && parsed.data !== "/" ? parsed.data : null;
}

export function defaultPaletteTab(currentPath: string, liveIndex: boolean): PaletteTab {
  if (!liveIndex) return "tree";
  return currentPath === "/agents" || currentPath.startsWith("/agents/") ? "agents" : "recent";
}

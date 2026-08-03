import { StreamPath } from "~/lib/stream-links.ts";
import { toggledSet } from "~/lib/tree-rows.ts";

export type PaletteTab = "agents" | "tree" | "recent";

type PaletteKeyboardTarget = { kind: "agent"; path: string } | { kind: "stream"; path: string };

export type PaletteKeyboardAction = "toggle_pin" | "expand" | "collapse";

/** cmdk values must not collide with stream paths, so agent rows are prefixed. */
export function agentCommandValue(path: string): string {
  return `agent:${path}`;
}

export function paletteKeyboardTarget(
  tab: PaletteTab,
  selectedValue: string,
): PaletteKeyboardTarget | undefined {
  if (tab === "agents") {
    if (selectedValue.startsWith("agent:")) {
      return { kind: "agent", path: selectedValue.slice("agent:".length) };
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
  if (input.query.trim() !== "") {
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

type PaletteDialogState = {
  tab: PaletteTab;
  query: string;
  selectedValue: string;
  /** Agents render collapsed to roots by default; these are expanded. */
  expandedAgentPaths: ReadonlySet<string>;
  /** Streams render fully expanded by default; these are collapsed. */
  collapsedStreamPaths: ReadonlySet<string>;
};

export function initialPaletteDialogState(): PaletteDialogState {
  return {
    tab: "agents",
    query: "",
    selectedValue: "",
    expandedAgentPaths: new Set(),
    collapsedStreamPaths: new Set(),
  };
}

type PaletteDialogAction =
  | { type: "closed" }
  | { type: "opened"; tab: PaletteTab }
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
        collapsedStreamPaths: new Set(),
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
        collapsedStreamPaths: toggledSet(state.collapsedStreamPaths, action.path),
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

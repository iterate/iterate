import { useEffect, useMemo, useReducer, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Bot, ChevronRight, Clock3, GitBranch, Plus } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@iterate-com/ui/components/command";
import { Tabs, TabsList, TabsTrigger } from "@iterate-com/ui/components/tabs";
import { cn } from "@iterate-com/ui/lib/utils";
import { useLiveState } from "iterate/sdk/itx/react";
import {
  agentCommandValue,
  buildStreamForest,
  defaultPaletteTab,
  flattenStreamRows,
  hasPathDescendant,
  initialPaletteDialogState,
  isPaletteResultKeyboardTarget,
  normalizeDestination,
  paletteKeyboardAction,
  paletteKeyboardTarget,
  reducePaletteDialogState,
  type PaletteTab,
} from "./command-palette-model.ts";
import type { AgentRecord } from "~/domains/agents/agent-presence.ts";
import { normalizePath } from "~/domains/durable-object-names.ts";
import type { StreamIndexRow } from "~/domains/projects/stream-database.ts";
import { formatTimeAgo } from "~/lib/format-relative-time.ts";
import type { StreamNavigator } from "~/lib/stream-navigation.ts";
import { streamPathAncestors } from "~/lib/stream-links.ts";
import { useTickingNowMs } from "~/lib/use-ticking-now-ms.ts";
import { updateAgentSummary } from "~/components/agents/agent-summary.ts";
import {
  buildAgentForest,
  flattenVisibleAgentRows,
  type AgentTreeNode,
} from "~/components/agents/agent-tree.ts";
import { agentCommandAccessibleLabel } from "~/components/agents/agent-presentation.ts";
import { AgentCommandPresentation } from "~/components/agents/agent.tsx";
import { AdminRemoteStreamTree } from "~/components/admin-remote-stream-tree.tsx";

const CLOCK_TICK_MS = 5_000;
const MAX_AGENT_RESULTS = 100;
const MAX_STREAM_TREE_RESULTS = 200;
const MAX_RECENT_RESULTS = 50;

export function CommandPaletteDialog({
  open,
  onOpenChange,
  currentPath,
  navigator,
  scope,
  liveIndex = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentPath: string;
  navigator: StreamNavigator;
  scope: string;
  /** Admin has remote operator authority but no project live-state projection. */
  liveIndex?: boolean;
}) {
  const [palette, dispatchPalette] = useReducer(
    reducePaletteDialogState,
    undefined,
    initialPaletteDialogState,
  );
  const { tab, query, selectedValue, expandedAgentPaths, expandedStreamPaths } = palette;
  const enabled = open && liveIndex;
  const nowMs = useTickingNowMs(CLOCK_TICK_MS, open);
  const streamsState = useLiveState(
    (itx) => itx.liveState,
    (state) => state.streamsIndex,
    [scope],
    { slug: scope, enabled },
  );
  const agentsState = useLiveState(
    (itx) => itx.agents.liveState,
    (state) => state.agents,
    [scope],
    { slug: scope, enabled },
  );

  useEffect(() => {
    if (!open) {
      dispatchPalette({ type: "closed" });
      return;
    }
    dispatchPalette({
      type: "opened",
      tab: defaultPaletteTab(currentPath, liveIndex),
      expandedStreamPaths: new Set(["/", ...streamPathAncestors(currentPath)]),
    });
  }, [currentPath, liveIndex, open]);

  function openStream(path: string) {
    onOpenChange(false);
    navigator.onOpenPath(normalizePath(path));
  }

  async function togglePinned(agent: AgentRecord): Promise<void> {
    await updateAgentSummary(scope, agent.path, { pinned: !agent.summary.pinned });
  }

  if (!liveIndex) {
    if (navigator.remoteTreeSource === undefined) {
      throw new Error("Admin project navigation requires a remote stream source");
    }
    return (
      <CommandDialog
        open={open}
        onOpenChange={onOpenChange}
        title="Stream tree"
        description="Browse remote admin streams"
        className="flex h-[calc(100svh-2rem)] w-[calc(100vw-1rem)] max-w-none flex-col p-3 sm:h-[66svh] sm:w-[66vw] sm:max-w-[66vw]"
      >
        <div className="mb-2">
          <h2 className="text-sm font-semibold">Stream tree</h2>
          <p className="truncate font-mono text-xs text-muted-foreground">{currentPath}</p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <AdminRemoteStreamTree
            key={`${scope}:${currentPath}:${open ? "open" : "closed"}`}
            currentPath={currentPath}
            onOpenPath={openStream}
            scope={scope}
            source={navigator.remoteTreeSource}
          />
        </div>
      </CommandDialog>
    );
  }

  // A live-state value is undefined for exactly one round trip after opening;
  // render that window as loading, not as an empty project.
  const streams = streamsState.value ?? {};
  const agents = agentsState.value ?? {};
  const streamsLoading = streamsState.value === undefined;
  const agentsLoading = agentsState.value === undefined;
  const normalizedCreatePath = normalizeDestination(query);

  function handleCommandKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!isPaletteResultKeyboardTarget(event.target)) return;
    const target = paletteKeyboardTarget(tab, selectedValue);
    if (target === undefined) return;
    const paths = target.kind === "agent" ? Object.keys(agents) : Object.keys(streams);
    const expanded =
      target.kind === "agent"
        ? expandedAgentPaths.has(target.path)
        : expandedStreamPaths.has(target.path);
    const action = paletteKeyboardAction({
      target,
      key: event.key,
      shiftKey: event.shiftKey,
      query,
      hasChildren: hasPathDescendant(paths, target.path),
      expanded,
    });
    if (action === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    if (action === "toggle_pin") {
      const agent = agents[target.path];
      if (agent !== undefined) void togglePinned(agent);
      return;
    }
    if (target.kind === "agent") {
      dispatchPalette({ type: "agent_toggled", path: target.path });
    } else {
      dispatchPalette({ type: "stream_toggled", path: target.path });
    }
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Project navigation"
      description="Open an agent, stream tree node, or recently active stream"
      className="flex h-[calc(100svh-2rem)] w-[calc(100vw-1rem)] max-w-none flex-col overflow-hidden sm:h-[66svh] sm:w-[66vw] sm:max-w-[66vw]"
    >
      <Command
        shouldFilter={false}
        loop
        value={selectedValue}
        onValueChange={(value) =>
          dispatchPalette({ type: "selection_changed", selectedValue: value })
        }
        onKeyDown={handleCommandKeyDown}
        className="min-h-0 flex-1"
      >
        <CommandInput
          value={query}
          onValueChange={(value) => {
            dispatchPalette({ type: "query_changed", query: value });
          }}
          placeholder={tab === "agents" ? "Search agents" : "Search streams by path"}
        />
        <Tabs
          value={tab}
          onValueChange={(value) => {
            dispatchPalette({ type: "tab_changed", tab: value as PaletteTab });
          }}
          className="min-h-0 flex-1 overflow-hidden"
        >
          <TabsList className="mx-2 mt-1 grid w-auto grid-cols-3" aria-label="Navigation mode">
            <TabsTrigger value="tree">
              <GitBranch /> Tree
            </TabsTrigger>
            <TabsTrigger value="agents">
              <Bot /> Agents
            </TabsTrigger>
            <TabsTrigger value="recent">
              <Clock3 /> Recent
            </TabsTrigger>
          </TabsList>
          <CommandList key={tab} className="max-h-none min-h-0 flex-1">
            {tab === "agents" ? (
              <AgentResults
                agents={agents}
                expandedPaths={expandedAgentPaths}
                loading={agentsLoading}
                nowMs={nowMs}
                query={query}
                onOpen={openStream}
                onToggleExpanded={(path) => dispatchPalette({ type: "agent_toggled", path })}
                onTogglePinned={togglePinned}
              />
            ) : tab === "tree" ? (
              <StreamTreeResults
                currentPath={currentPath}
                expandedPaths={expandedStreamPaths}
                loading={streamsLoading}
                query={query}
                streams={streams}
                onOpen={openStream}
                onToggleExpanded={(path) => dispatchPalette({ type: "stream_toggled", path })}
              />
            ) : (
              <RecentStreamResults
                loading={streamsLoading}
                nowMs={nowMs}
                query={query}
                streams={streams}
                onOpen={openStream}
              />
            )}
          </CommandList>
        </Tabs>
        {tab === "tree" && normalizedCreatePath !== null ? (
          <div className="border-t p-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full justify-start font-mono text-xs"
              onClick={() => openStream(normalizedCreatePath)}
            >
              <Plus /> Open or create {normalizedCreatePath}
            </Button>
          </div>
        ) : null}
      </Command>
    </CommandDialog>
  );
}

function AgentResults({
  agents,
  expandedPaths,
  loading,
  nowMs,
  query,
  onOpen,
  onToggleExpanded,
  onTogglePinned,
}: {
  agents: Record<string, AgentRecord>;
  expandedPaths: ReadonlySet<string>;
  loading: boolean;
  nowMs: number;
  query: string;
  onOpen: (path: string) => void;
  onToggleExpanded: (path: string) => void;
  onTogglePinned: (agent: AgentRecord) => void | Promise<void>;
}) {
  const forest = useMemo(() => buildAgentForest(agents), [agents]);
  const rows = useMemo(
    () => flattenVisibleAgentRows(forest, expandedPaths, query),
    [expandedPaths, forest, query],
  );
  const visibleRows = rows.slice(0, MAX_AGENT_RESULTS);

  if (visibleRows.length === 0) {
    return (
      <CommandEmpty>
        {loading
          ? "Loading agents…"
          : Object.keys(agents).length === 0
            ? "No agents yet."
            : "No matching agents."}
      </CommandEmpty>
    );
  }
  return (
    <CommandGroup heading={query.trim() === "" ? "Active, waiting, and recent" : "Matches"}>
      {visibleRows.map(({ node, depth, expanded }) => (
        <AgentCommandItem
          key={node.agent.path}
          node={node}
          depth={depth}
          expanded={expanded}
          nowMs={nowMs}
          onOpen={onOpen}
          onToggleExpanded={onToggleExpanded}
          onTogglePinned={onTogglePinned}
        />
      ))}
    </CommandGroup>
  );
}

function AgentCommandItem({
  node,
  depth = 0,
  expanded = false,
  nowMs,
  onOpen,
  onToggleExpanded,
  onTogglePinned,
}: {
  node: AgentTreeNode;
  depth?: number;
  expanded?: boolean;
  nowMs: number;
  onOpen: (path: string) => void;
  onToggleExpanded: (path: string) => void;
  onTogglePinned: (agent: AgentRecord) => void | Promise<void>;
}) {
  const hasChildren = node.children.length > 0;
  return (
    <CommandItem
      value={agentCommandValue(node.agent.path)}
      onSelect={() => onOpen(node.agent.path)}
      className="gap-2"
      style={{ marginLeft: `${Math.min(depth, 4) * 12}px` }}
      aria-label={agentCommandAccessibleLabel(node, expanded)}
      aria-expanded={hasChildren ? expanded : undefined}
      aria-keyshortcuts="Shift+P"
      onClickCapture={(event) => {
        const target = event.target as Element;
        if (target.closest("[data-agent-pin]")) {
          event.preventDefault();
          event.stopPropagation();
          void onTogglePinned(node.agent);
        } else if (hasChildren && target.closest("[data-agent-disclosure]")) {
          event.preventDefault();
          event.stopPropagation();
          onToggleExpanded(node.agent.path);
        }
      }}
    >
      <AgentCommandPresentation expanded={expanded} node={node} nowMs={nowMs} />
    </CommandItem>
  );
}

function StreamTreeResults({
  currentPath,
  expandedPaths,
  loading,
  query,
  streams,
  onOpen,
  onToggleExpanded,
}: {
  currentPath: string;
  expandedPaths: ReadonlySet<string>;
  loading: boolean;
  query: string;
  streams: Record<string, StreamIndexRow>;
  onOpen: (path: string) => void;
  onToggleExpanded: (path: string) => void;
}) {
  const forest = useMemo(() => buildStreamForest(streams), [streams]);
  const rows = useMemo(
    () => flattenStreamRows(forest, expandedPaths, query).slice(0, MAX_STREAM_TREE_RESULTS),
    [expandedPaths, forest, query],
  );
  if (rows.length === 0) {
    return <CommandEmpty>{loading ? "Loading streams…" : "No matching streams."}</CommandEmpty>;
  }
  return (
    <CommandGroup heading="Stream tree">
      {rows.map(({ node, depth, expanded }) => {
        const hasChildren = node.children.length > 0;
        return (
          <CommandItem
            key={node.row.path}
            value={node.row.path}
            onSelect={() => onOpen(node.row.path)}
            className={cn(currentPath === node.row.path && "bg-accent")}
            aria-expanded={hasChildren ? expanded : undefined}
            onClickCapture={(event) => {
              if (!hasChildren || !(event.target as Element).closest("[data-stream-disclosure]")) {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              onToggleExpanded(node.row.path);
            }}
          >
            <span style={{ width: `${Math.min(depth, 5) * 12}px` }} className="shrink-0" />
            {hasChildren ? (
              <span
                data-stream-disclosure
                className="-m-1 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded hover:bg-muted"
                title={expanded ? "Collapse stream" : "Expand stream"}
                aria-hidden
              >
                <ChevronRight
                  className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
                />
              </span>
            ) : (
              <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{node.row.path}</span>
            <CommandShortcut>{node.row.eventCount}</CommandShortcut>
          </CommandItem>
        );
      })}
    </CommandGroup>
  );
}

function RecentStreamResults({
  loading,
  nowMs,
  query,
  streams,
  onOpen,
}: {
  loading: boolean;
  nowMs: number;
  query: string;
  streams: Record<string, StreamIndexRow>;
  onOpen: (path: string) => void;
}) {
  const normalizedQuery = query.trim().toLowerCase();
  const rows = useMemo(
    () =>
      Object.values(streams)
        .filter((row) => normalizedQuery === "" || row.path.toLowerCase().includes(normalizedQuery))
        .toSorted(
          (left, right) =>
            right.lastActivityAt.localeCompare(left.lastActivityAt) ||
            left.path.localeCompare(right.path),
        )
        .slice(0, MAX_RECENT_RESULTS),
    [normalizedQuery, streams],
  );
  if (rows.length === 0) {
    return <CommandEmpty>{loading ? "Loading streams…" : "No recent streams."}</CommandEmpty>;
  }
  return (
    <CommandGroup heading="Most recently active">
      {rows.map((row) => (
        <CommandItem key={row.path} value={row.path} onSelect={() => onOpen(row.path)}>
          <Clock3 className="text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono text-xs">{row.path}</span>
            <span className="block truncate text-[10px] text-muted-foreground">{row.lastType}</span>
          </span>
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            {formatTimeAgo(row.lastActivityAt, nowMs)}
          </span>
          <CommandShortcut>{row.eventCount}</CommandShortcut>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

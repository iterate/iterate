import { useEffect, useMemo, useReducer, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronRight, Plus } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@iterate-com/ui/components/command";
import { Tabs, TabsList, TabsTrigger } from "@iterate-com/ui/components/tabs";
import { cn } from "@iterate-com/ui/lib/utils";
import { useLiveState } from "iterate/sdk/itx/react";
import {
  buildStreamForest,
  defaultPaletteTab,
  flattenStreamRows,
  formatEventCount,
  hasPathDescendant,
  initialPaletteDialogState,
  isPaletteResultKeyboardTarget,
  normalizeDestination,
  paletteKeyboardAction,
  paletteKeyboardTarget,
  reducePaletteDialogState,
  streamTreeLabel,
  type PaletteTab,
} from "./command-palette-model.ts";
import type { AgentRecord } from "~/domains/agents/agent-presence.ts";
import { normalizePath } from "~/domains/durable-object-names.ts";
import type { StreamIndexRow } from "~/domains/projects/stream-database.ts";
import { formatTimeAgo } from "~/lib/format-relative-time.ts";
import type { StreamNavigator } from "~/lib/stream-navigation.ts";
import { useTickingNowMs } from "~/lib/use-ticking-now-ms.ts";
import { updateAgentSummary } from "~/components/agents/agent-summary.ts";
import { useAgentTreeTable } from "~/components/agents/agent-tree-table.ts";
import { AgentCommandHeader, AgentCommandItem } from "~/components/agents/agent.tsx";
import { AdminRemoteStreamTree } from "~/components/admin-remote-stream-tree.tsx";

const CLOCK_TICK_MS = 5_000;
const MAX_AGENT_RESULTS = 100;
const MAX_STREAM_TREE_RESULTS = 200;
const MAX_RECENT_RESULTS = 50;

const PALETTE_TABS: { value: PaletteTab; label: string }[] = [
  { value: "tree", label: "Tree" },
  { value: "agents", label: "Agents" },
  { value: "recent", label: "Recent" },
];

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
  const { tab, query, selectedValue, expandedAgentPaths, collapsedStreamPaths } = palette;
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
        className="flex h-[calc(100svh-2rem)] w-[calc(100vw-1rem)] max-w-none flex-col sm:h-[66svh] sm:w-[66vw] sm:max-w-[66vw]"
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 border-b px-3 py-2">
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
        : !collapsedStreamPaths.has(target.path);
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
        className="flex min-h-0 flex-1 flex-col"
      >
        <Tabs
          value={tab}
          onValueChange={(value) => {
            dispatchPalette({ type: "tab_changed", tab: value as PaletteTab });
          }}
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          <div className="flex shrink-0 items-center justify-end border-b px-3 py-2">
            <TabsList className="h-8" aria-label="Navigation mode">
              {PALETTE_TABS.map((item) => (
                <TabsTrigger key={item.value} value={item.value} className="px-2.5 text-xs">
                  {item.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

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
                collapsedPaths={collapsedStreamPaths}
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

        <div className="shrink-0 border-t">
          {tab === "tree" && normalizedCreatePath !== null ? (
            <div className="border-b px-2 py-1.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 w-full justify-start font-mono text-xs"
                onClick={() => openStream(normalizedCreatePath)}
              >
                <Plus /> Open or create {normalizedCreatePath}
              </Button>
            </div>
          ) : null}
          <CommandInput
            value={query}
            onValueChange={(value) => {
              dispatchPalette({ type: "query_changed", query: value });
            }}
            placeholder={
              tab === "agents"
                ? "Search agents…"
                : tab === "tree"
                  ? "Search streams by path…"
                  : "Search recent streams…"
            }
          />
        </div>
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
  const table = useAgentTreeTable({ agents, expandedPaths, query });
  const visibleRows = table.getRowModel().rows.slice(0, MAX_AGENT_RESULTS);

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
    <CommandGroup className="p-0">
      <AgentCommandHeader />
      {visibleRows.map((row) => (
        <AgentCommandItem
          key={row.id}
          node={row.original}
          depth={row.depth}
          expanded={row.getIsExpanded()}
          nowMs={nowMs}
          onOpen={onOpen}
          onToggleExpanded={onToggleExpanded}
          onTogglePinned={onTogglePinned}
        />
      ))}
    </CommandGroup>
  );
}

function StreamTreeResults({
  currentPath,
  collapsedPaths,
  loading,
  query,
  streams,
  onOpen,
  onToggleExpanded,
}: {
  currentPath: string;
  collapsedPaths: ReadonlySet<string>;
  loading: boolean;
  query: string;
  streams: Record<string, StreamIndexRow>;
  onOpen: (path: string) => void;
  onToggleExpanded: (path: string) => void;
}) {
  const forest = useMemo(() => buildStreamForest(streams), [streams]);
  const rows = useMemo(
    () => flattenStreamRows(forest, collapsedPaths, query).slice(0, MAX_STREAM_TREE_RESULTS),
    [collapsedPaths, forest, query],
  );
  if (rows.length === 0) {
    return <CommandEmpty>{loading ? "Loading streams…" : "No matching streams."}</CommandEmpty>;
  }
  return (
    <CommandGroup className="p-0">
      {rows.map(({ node, depth, expanded }) => {
        const hasChildren = node.children.length > 0;
        return (
          <CommandItem
            key={node.row.path}
            value={node.row.path}
            onSelect={() => onOpen(node.row.path)}
            className={cn(
              "gap-1.5 border-b border-border/40 py-1.5 font-mono text-xs last:border-b-0",
              currentPath === node.row.path && "bg-accent",
            )}
            aria-expanded={hasChildren ? expanded : undefined}
            onClickCapture={(event) => {
              if (
                !hasChildren ||
                !(event.target instanceof Element) ||
                !event.target.closest("[data-stream-disclosure]")
              ) {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              onToggleExpanded(node.row.path);
            }}
          >
            <span
              style={{ width: `${Math.min(depth, 8) * 12}px` }}
              className="shrink-0"
              aria-hidden
            />
            <span className="flex w-4 shrink-0 justify-center" aria-hidden>
              {hasChildren ? (
                <span
                  data-stream-disclosure
                  className="-m-1 flex size-4 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-muted"
                  title={expanded ? "Collapse" : "Expand"}
                >
                  <ChevronRight
                    className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
                  />
                </span>
              ) : null}
            </span>
            <span className="min-w-0 flex-1 truncate" title={node.row.path}>
              {streamTreeLabel(node.row.path)}
            </span>
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {formatEventCount(node.row.eventCount)}
            </span>
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
    // overflow-visible: the group's default overflow-hidden would trap the
    // sticky header, which must stick to the scrolling CommandList instead.
    <CommandGroup className="overflow-visible p-0">
      <div
        className="sticky top-0 z-10 hidden border-b bg-popover px-3 py-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)_5.5rem_5.5rem] sm:gap-3"
        aria-hidden
      >
        <span>Path</span>
        <span>Last event</span>
        <span className="text-right">Active</span>
        <span className="text-right">Events</span>
      </div>
      {rows.map((row) => (
        <CommandItem
          key={row.path}
          value={row.path}
          onSelect={() => onOpen(row.path)}
          className="items-start gap-0 border-b border-border/40 py-2 last:border-b-0 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)_5.5rem_5.5rem] sm:items-center sm:gap-3"
        >
          <span className="min-w-0 flex-1 truncate font-mono text-xs sm:flex-none" title={row.path}>
            {row.path}
          </span>
          <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground sm:mt-0 sm:contents">
            <span className="min-w-0 truncate" title={row.lastType}>
              {shortEventType(row.lastType)}
            </span>
            <time
              dateTime={row.lastActivityAt}
              title={row.lastActivityAt}
              className="shrink-0 tabular-nums sm:text-right"
            >
              {formatTimeAgo(row.lastActivityAt, nowMs)}
            </time>
            <span className="shrink-0 tabular-nums sm:text-right">
              {formatEventCount(row.eventCount)}
            </span>
          </span>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

/** Drop the long `events.iterate.com/` prefix when present for denser columns. */
function shortEventType(type: string): string {
  const prefix = "events.iterate.com/";
  return type.startsWith(prefix) ? type.slice(prefix.length) : type;
}

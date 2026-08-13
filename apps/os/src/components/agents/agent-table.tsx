import { createContext, useContext, useMemo, useRef } from "react";
import {
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getFilteredRowModel,
  useReactTable,
  type ColumnDef,
  type ExpandedState,
  type Row,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iterate-com/ui/components/table";
import { cn } from "@iterate-com/ui/lib/utils";
import { useLiveState } from "iterate/sdk/itx/react";
import { BindingLink, PinButton, StateDot } from "./agent.tsx";
import { AGENT_DISPLAY_STATE_PRESENTATION, runtimeCountFragments } from "./agent-presentation.ts";
import {
  agentPathNodeRuntime,
  buildAgentPathForest,
  type AgentPathTreeNode,
} from "./agent-path-tree.ts";
import { agentNodeWaitingFor, agentSearchText, agentTitle } from "./agent-tree.ts";
import type { AgentRuntimeTransition } from "~/domains/agents/agent-processor-contract.ts";
import {
  deriveAgentDisplayState,
  deriveAgentRuntimeDisplayState,
  type AgentDisplayState,
  type AgentRecord,
} from "~/domains/agents/agent-presence.ts";
import { formatTimeAgo } from "~/lib/format-relative-time.ts";

const TABLE_GRID =
  "grid-cols-[minmax(20rem,2.3fr)_minmax(11rem,1fr)_minmax(17rem,2fr)_minmax(12rem,1.2fr)_8rem_7rem_7rem_7rem_3rem]";

const AGENT_COLUMN_ID = {
  agent: "agent",
  status: "status",
  activity: "activity",
  source: "source",
  subagents: "subagents",
  lastWork: "lastWork",
  updated: "updated",
  created: "created",
  pin: "pin",
} as const;

const COLUMN_CLASS_NAMES: Record<string, string> = {
  agent: "min-w-0 whitespace-normal",
  status: "whitespace-normal",
  activity: "min-w-0 whitespace-normal",
  source: "min-w-0 whitespace-normal text-muted-foreground",
  subagents: "whitespace-normal tabular-nums",
  lastWork: "text-xs tabular-nums text-muted-foreground",
  updated: "text-xs tabular-nums text-muted-foreground",
  created: "text-xs tabular-nums text-muted-foreground",
  pin: "",
} satisfies Record<(typeof AGENT_COLUMN_ID)[keyof typeof AGENT_COLUMN_ID], string>;

const AGENT_COLUMNS: ColumnDef<AgentPathTreeNode>[] = [
  {
    id: AGENT_COLUMN_ID.agent,
    header: "Agent",
    accessorFn: (node) => (!node.agent ? node.path.toLowerCase() : agentSearchText(node.agent)),
    cell: AgentCell,
  },
  { id: AGENT_COLUMN_ID.status, header: "Status", cell: StatusCell },
  { id: AGENT_COLUMN_ID.activity, header: "Activity", cell: ActivityCell },
  { id: AGENT_COLUMN_ID.source, header: "Source", cell: SourceCell },
  { id: AGENT_COLUMN_ID.subagents, header: "Subagents", cell: SubagentsCell },
  { id: AGENT_COLUMN_ID.lastWork, header: "Last work", cell: LastWorkCell },
  { id: AGENT_COLUMN_ID.updated, header: "Updated", cell: UpdatedCell },
  { id: AGENT_COLUMN_ID.created, header: "Created", cell: CreatedCell },
  {
    id: AGENT_COLUMN_ID.pin,
    header: () => <span className="sr-only">Pin</span>,
    cell: PinCell,
  },
];

/** Data and interactions required by the path-derived agents table. */
type AgentTableProps = {
  agents: Record<string, AgentRecord>;
  collapsedPaths: ReadonlySet<string>;
  nowMs: number;
  projectId: string;
  query: string;
  onOpen: (path: string) => void;
  onToggleExpanded: (path: string) => void;
  onTogglePinned: (agent: AgentRecord) => void | Promise<unknown>;
};

export function AgentTable({
  agents,
  collapsedPaths,
  nowMs,
  projectId,
  query,
  onOpen,
  onToggleExpanded,
  onTogglePinned,
}: AgentTableProps) {
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
  const table = useReactTable({
    data: forest,
    columns: AGENT_COLUMNS,
    state: { expanded, globalFilter: normalizedQuery },
    getRowId: (node) => node.path,
    getSubRows: (node) => node.children,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    filterFromLeafRows: true,
  });
  const rows = table.getRowModel().rows;
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 65,
    overscan: 8,
  });

  return (
    <Table
      containerRef={scrollRef}
      containerClassName="h-full overflow-auto"
      className="grid"
      aria-label="Agents table"
      aria-rowcount={rows.length + 1}
    >
      <TableHeader className="sticky top-0 z-10 grid bg-background">
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id} className={cn("grid hover:bg-background", TABLE_GRID)}>
            {headerGroup.headers.map((header) => (
              <TableHead key={header.id} className={COLUMN_CLASS_NAMES[header.column.id]}>
                {header.isPlaceholder
                  ? null
                  : flexRender(header.column.columnDef.header, header.getContext())}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody className="relative grid" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (!row) return null;
          const rowProps: VirtualAgentRowProps = {
            ref: virtualizer.measureElement,
            dataIndex: virtualRow.index,
            row,
            nowMs,
            searching,
            style: { transform: `translateY(${virtualRow.start}px)` },
            onOpen,
            onToggleExpanded,
            onTogglePinned,
          };
          const agent = row.original.agent;
          return !agent ? (
            <AgentTableRow key={row.id} {...rowProps} />
          ) : (
            <LiveAgentTableRow key={row.id} {...rowProps} agent={agent} projectId={projectId} />
          );
        })}
      </TableBody>
    </Table>
  );
}

/** Stable props shared by inferred-container and live-agent virtual rows. */
type VirtualAgentRowProps = {
  ref: (node: Element | null) => void;
  dataIndex: number;
  row: Row<AgentPathTreeNode>;
  nowMs: number;
  searching: boolean;
  style: React.CSSProperties;
  onOpen: AgentTableProps["onOpen"];
  onToggleExpanded: AgentTableProps["onToggleExpanded"];
  onTogglePinned: AgentTableProps["onTogglePinned"];
};

function LiveAgentTableRow({
  agent,
  projectId,
  ...props
}: VirtualAgentRowProps & { agent: AgentRecord; projectId: string }) {
  const runtimeTransition = useLiveState(
    (itx) => itx.agents.get(agent.path).liveState,
    (state) => state.runtimeChange,
    [agent.path],
    { slug: projectId },
  ).value;
  return <AgentTableRow {...props} runtimeTransition={runtimeTransition} />;
}

/** Derived presentation shared by the TanStack cells in one mounted row. */
type AgentTableRowContextValue = Omit<VirtualAgentRowProps, "ref" | "dataIndex" | "style"> & {
  node: AgentPathTreeNode;
  agent: AgentRecord | undefined;
  state: (typeof AGENT_DISPLAY_STATE_PRESENTATION)[AgentDisplayState];
  runtimeCounts: string[];
  descendantCount: number;
  activeCount: number;
  updated: string | undefined;
};

const AgentTableRowContext = createContext<AgentTableRowContextValue | undefined>(undefined);

function AgentTableRow({
  ref,
  dataIndex,
  row,
  nowMs,
  searching,
  runtimeTransition,
  style,
  onOpen,
  onToggleExpanded,
  onTogglePinned,
}: VirtualAgentRowProps & { runtimeTransition?: AgentRuntimeTransition }) {
  const node = row.original;
  const agent = node.agent;
  const runtime = agentPathNodeRuntime(node, runtimeTransition?.runtime);
  const waitingFor =
    agent && row.getIsExpanded() ? agent.summary.waitingFor : agentNodeWaitingFor(node);
  const displayState = deriveAgentDisplayState(runtime, waitingFor);
  const context = useMemo<AgentTableRowContextValue>(
    () => ({
      row,
      node,
      agent,
      nowMs,
      searching,
      onOpen,
      onToggleExpanded,
      onTogglePinned,
      state: AGENT_DISPLAY_STATE_PRESENTATION[displayState],
      runtimeCounts: runtimeCountFragments(runtime),
      descendantCount: node.aggregateAgentCount - (!agent ? 0 : 1),
      activeCount:
        node.aggregateActiveCount -
        (!agent || deriveAgentRuntimeDisplayState(agent.runtime) === "idle" ? 0 : 1),
      updated: !agent ? undefined : latestAgentUpdate(agent.timestamps),
    }),
    [
      agent,
      displayState,
      node,
      nowMs,
      onOpen,
      onToggleExpanded,
      onTogglePinned,
      row,
      runtime,
      searching,
    ],
  );

  return (
    <AgentTableRowContext value={context}>
      <TableRow
        ref={ref}
        aria-rowindex={dataIndex + 2}
        data-index={dataIndex}
        data-agent-table-row
        data-agent-path={node.path}
        data-agent-row-kind={!agent ? "container" : "agent"}
        data-agent-state={displayState}
        className={cn("absolute left-0 top-0 grid w-full items-center", TABLE_GRID)}
        style={style}
      >
        {row.getVisibleCells().map((cell) => (
          <TableCell key={cell.id} className={COLUMN_CLASS_NAMES[cell.column.id]}>
            {flexRender(cell.column.columnDef.cell, cell.getContext())}
          </TableCell>
        ))}
      </TableRow>
    </AgentTableRowContext>
  );
}

function useAgentTableRow() {
  const context = useContext(AgentTableRowContext);
  if (!context) throw new Error("agent table cells require an agent table row");
  return context;
}

function AgentCell() {
  const { row, node, agent, searching, state, onOpen, onToggleExpanded } = useAgentTableRow();
  return (
    <div className="flex min-w-0 items-start gap-2" style={{ paddingLeft: row.depth * 16 }}>
      <span className="flex size-5 shrink-0 items-center justify-center">
        {row.getCanExpand() && !searching ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={row.getIsExpanded() ? "Collapse child agents" : "Expand child agents"}
            aria-expanded={row.getIsExpanded()}
            onClick={() => onToggleExpanded(node.path)}
          >
            <ChevronRight
              className={cn("size-3.5 transition-transform", row.getIsExpanded() && "rotate-90")}
            />
          </Button>
        ) : null}
      </span>
      {!agent ? (
        <>
          {row.getIsExpanded() ? (
            <FolderOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          ) : (
            <Folder className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          )}
          {searching ? (
            <code className="min-w-0 truncate font-mono text-sm font-medium" title={node.path}>
              {node.path}
            </code>
          ) : (
            <button
              type="button"
              className="min-w-0 truncate text-left font-mono text-sm font-medium hover:underline"
              title={node.path}
              onClick={() => onToggleExpanded(node.path)}
            >
              {node.path}
            </button>
          )}
        </>
      ) : (
        <>
          <StateDot state={state} className="mt-1.5" />
          <span className="min-w-0">
            <button
              type="button"
              className="block max-w-full truncate text-left font-medium hover:underline"
              title={agent.path}
              onClick={() => onOpen(agent.path)}
            >
              {agentTitle(agent)}
            </button>
            <code
              className="block truncate font-mono text-[11px] text-muted-foreground"
              title={agent.path}
            >
              {agent.path}
            </code>
          </span>
        </>
      )}
    </div>
  );
}

function StatusCell() {
  const { state, runtimeCounts } = useAgentTableRow();
  return (
    <>
      <span className="block">{state.label}</span>
      {runtimeCounts.length === 0 ? null : (
        <span className="block truncate text-xs text-muted-foreground">
          {runtimeCounts.join(" · ")}
        </span>
      )}
    </>
  );
}

function ActivityCell() {
  const { node, agent } = useAgentTableRow();
  return (
    <>
      <span className="block truncate">
        {!agent
          ? `${node.aggregateAgentCount} descendant ${node.aggregateAgentCount === 1 ? "agent" : "agents"}`
          : (agent.summary.activity ?? "—")}
      </span>
      {!agent?.summary.description ? null : (
        <span className="block truncate text-xs text-muted-foreground">
          {agent.summary.description}
        </span>
      )}
    </>
  );
}

function SourceCell() {
  const { agent } = useAgentTableRow();
  return !agent?.binding ? (
    "—"
  ) : (
    <BindingLink binding={agent.binding} className="block max-w-full" />
  );
}

function SubagentsCell() {
  const { descendantCount, activeCount } = useAgentTableRow();
  return (
    <>
      <span className="block">{descendantCount}</span>
      {activeCount === 0 ? null : (
        <span className="block text-xs text-muted-foreground">{activeCount} active</span>
      )}
    </>
  );
}

function LastWorkCell() {
  const { node, nowMs } = useAgentTableRow();
  return <TimeValue value={node.aggregateLastWorkAt} nowMs={nowMs} />;
}

function UpdatedCell() {
  const { updated, nowMs } = useAgentTableRow();
  return <TimeValue value={updated} nowMs={nowMs} />;
}

function CreatedCell() {
  const { agent, nowMs } = useAgentTableRow();
  return <TimeValue value={agent?.timestamps.createdAt} nowMs={nowMs} />;
}

function PinCell() {
  const { agent, onTogglePinned } = useAgentTableRow();
  return !agent ? null : (
    <PinButton
      pinned={agent.summary.pinned}
      onToggle={() => onTogglePinned(agent)}
      size="icon-sm"
    />
  );
}

function TimeValue({ value, nowMs }: { value?: string; nowMs: number }) {
  return !value ? (
    "—"
  ) : (
    <time dateTime={value} title={value}>
      {formatTimeAgo(value, nowMs)}
    </time>
  );
}

function latestAgentUpdate(timestamps: AgentRecord["timestamps"]): string {
  let latest = timestamps.lastWorkAt;
  for (const timestamp of [
    timestamps.runtimeUpdatedAt,
    timestamps.activityUpdatedAt,
    timestamps.summaryUpdatedAt,
  ]) {
    if (timestamp && timestamp > latest) latest = timestamp;
  }
  return latest;
}

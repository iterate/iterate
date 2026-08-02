import { useRef } from "react";
import type { Row } from "@tanstack/react-table";
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
import { AGENT_DISPLAY_STATE_PRESENTATION } from "./agent-presentation.ts";
import {
  agentPathNodeDisplayState,
  agentPathNodeRuntime,
  agentPathNodeWaitingFor,
  type AgentPathTreeNode,
} from "./agent-path-tree.ts";
import { agentTitle } from "./agent-tree.ts";
import type { AgentRuntimeTransition } from "~/domains/agents/agent-processor-contract.ts";
import { deriveAgentRuntimeDisplayState } from "~/domains/agents/agent-presence.ts";
import { formatTimeAgo } from "~/lib/format-relative-time.ts";

const TABLE_GRID =
  "grid-cols-[minmax(20rem,2.3fr)_minmax(11rem,1fr)_minmax(17rem,2fr)_minmax(12rem,1.2fr)_8rem_7rem_7rem_7rem_3rem]";

export function AgentTable({
  rows,
  nowMs,
  projectId,
  searching,
  onOpen,
  onToggleExpanded,
  onTogglePinned,
}: {
  rows: Row<AgentPathTreeNode>[];
  nowMs: number;
  projectId: string;
  searching: boolean;
  onOpen: (path: string) => void;
  onToggleExpanded: (path: string) => void;
  onTogglePinned: (agent: NonNullable<AgentPathTreeNode["agent"]>) => void | Promise<unknown>;
}) {
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
      className="grid min-w-[104rem]"
      aria-label="Agents table"
      aria-rowcount={rows.length + 1}
    >
      <TableHeader className="sticky top-0 z-10 grid bg-background">
        <TableRow className={cn("grid hover:bg-background", TABLE_GRID)}>
          <TableHead>Agent</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Activity</TableHead>
          <TableHead>Source</TableHead>
          <TableHead>Subagents</TableHead>
          <TableHead>Last work</TableHead>
          <TableHead>Updated</TableHead>
          <TableHead>Created</TableHead>
          <TableHead>
            <span className="sr-only">Pin</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody className="relative grid" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (row === undefined) return null;
          const props = {
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
          return row.original.agent === undefined ? (
            <AgentTableRow key={row.id} {...props} />
          ) : (
            <LiveAgentTableRow key={row.id} {...props} projectId={projectId} />
          );
        })}
      </TableBody>
    </Table>
  );
}

function LiveAgentTableRow({
  ref,
  dataIndex,
  row,
  nowMs,
  searching,
  projectId,
  style,
  onOpen,
  onToggleExpanded,
  onTogglePinned,
}: {
  ref: (node: Element | null) => void;
  dataIndex: number;
  row: Row<AgentPathTreeNode>;
  nowMs: number;
  searching: boolean;
  projectId: string;
  style: React.CSSProperties;
  onOpen: (path: string) => void;
  onToggleExpanded: (path: string) => void;
  onTogglePinned: (agent: NonNullable<AgentPathTreeNode["agent"]>) => void | Promise<unknown>;
}) {
  const agent = row.original.agent;
  if (agent === undefined) throw new Error("live agent table row requires an agent");
  const runtimeTransition = useLiveState(
    (itx) => itx.agents.get(agent.path).liveState,
    (state) => state.runtimeChange,
    [agent.path],
    { slug: projectId },
  ).value;
  return (
    <AgentTableRow
      ref={ref}
      dataIndex={dataIndex}
      row={row}
      nowMs={nowMs}
      searching={searching}
      runtimeTransition={runtimeTransition}
      style={style}
      onOpen={onOpen}
      onToggleExpanded={onToggleExpanded}
      onTogglePinned={onTogglePinned}
    />
  );
}

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
}: {
  ref: (node: Element | null) => void;
  dataIndex: number;
  row: Row<AgentPathTreeNode>;
  nowMs: number;
  searching: boolean;
  runtimeTransition?: AgentRuntimeTransition;
  style: React.CSSProperties;
  onOpen: (path: string) => void;
  onToggleExpanded: (path: string) => void;
  onTogglePinned: (agent: NonNullable<AgentPathTreeNode["agent"]>) => void | Promise<unknown>;
}) {
  const node = row.original;
  const agent = node.agent;
  const runtime = agentPathNodeRuntime(node, runtimeTransition?.runtime);
  const runtimeState = deriveAgentRuntimeDisplayState(runtime);
  const displayState =
    runtimeState === "idle"
      ? agentPathNodeDisplayState({
          aggregateRuntime: runtime,
          aggregateWaiting: node.aggregateWaiting,
        })
      : runtimeState;
  const state = AGENT_DISPLAY_STATE_PRESENTATION[displayState];
  const waitingFor =
    agent !== undefined && row.getIsExpanded()
      ? agent.summary.waitingFor
      : agentPathNodeWaitingFor(node);
  const runtimeCounts = runtimeCountLabels(runtime);
  const descendantCount = node.aggregateAgentCount - (agent === undefined ? 0 : 1);
  const activeCount = Math.max(node.aggregateActiveCount, runtimeState === "idle" ? 0 : 1);
  const updated = agent === undefined ? undefined : latestAgentUpdate(agent.timestamps);

  return (
    <TableRow
      ref={ref}
      data-index={dataIndex}
      data-agent-table-row
      data-agent-path={node.path}
      data-agent-row-kind={agent === undefined ? "container" : "agent"}
      data-agent-state={displayState}
      className={cn("absolute left-0 top-0 grid w-full items-center", TABLE_GRID)}
      style={style}
    >
      <TableCell className="min-w-0 whitespace-normal">
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
                  className={cn(
                    "size-3.5 transition-transform",
                    row.getIsExpanded() && "rotate-90",
                  )}
                />
              </Button>
            ) : null}
          </span>
          {agent === undefined ? (
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
      </TableCell>
      <TableCell className="whitespace-normal">
        <span className="block">{state.label}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {runtimeCounts.length > 0
            ? runtimeCounts.join(" · ")
            : waitingFor === undefined
              ? "No active work"
              : waitingLabel(waitingFor)}
        </span>
      </TableCell>
      <TableCell className="min-w-0 whitespace-normal">
        <span className="block truncate">
          {agent?.summary.activity ?? `${node.aggregateAgentCount} descendant agents`}
        </span>
        {agent?.summary.description === undefined ? null : (
          <span className="block truncate text-xs text-muted-foreground">
            {agent.summary.description}
          </span>
        )}
      </TableCell>
      <TableCell className="min-w-0 whitespace-normal text-muted-foreground">
        {agent?.binding === undefined ? (
          "—"
        ) : (
          <BindingLink binding={agent.binding} className="block max-w-full" />
        )}
      </TableCell>
      <TableCell className="whitespace-normal tabular-nums">
        <span className="block">{descendantCount}</span>
        {activeCount === 0 ? null : (
          <span className="block text-xs text-muted-foreground">{activeCount} active</span>
        )}
      </TableCell>
      <TimeCell value={node.aggregateLastWorkAt} nowMs={nowMs} />
      <TimeCell value={updated} nowMs={nowMs} />
      <TimeCell value={agent?.timestamps.createdAt} nowMs={nowMs} />
      <TableCell>
        {agent === undefined ? null : (
          <PinButton
            pinned={agent.summary.pinned}
            onToggle={() => onTogglePinned(agent)}
            size="icon-sm"
          />
        )}
      </TableCell>
    </TableRow>
  );
}

function TimeCell({ value, nowMs }: { value?: string; nowMs: number }) {
  return (
    <TableCell className="text-xs tabular-nums text-muted-foreground">
      {value === undefined ? (
        "—"
      ) : (
        <time dateTime={value} title={value}>
          {formatTimeAgo(value, nowMs)}
        </time>
      )}
    </TableCell>
  );
}

function runtimeCountLabels(runtime: AgentPathTreeNode["aggregateRuntime"]): string[] {
  const unreadyTriggers = Math.max(0, runtime.triggers.pending - runtime.triggers.runnable);
  const modelRequests = runtime.llmRequests.started + runtime.llmRequests.requested;
  const queued = runtime.llmRequests.scheduled + runtime.triggers.runnable;
  return [
    runtime.runningScripts > 0 ? pluralCount(runtime.runningScripts, "script") : null,
    modelRequests > 0 ? pluralCount(modelRequests, "model request") : null,
    queued > 0 ? `${queued} queued` : null,
    unreadyTriggers > 0 ? pluralCount(unreadyTriggers, "pending trigger") : null,
  ].filter((value): value is string => value !== null);
}

function pluralCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function waitingLabel(
  waitingFor: NonNullable<NonNullable<AgentPathTreeNode["agent"]>["summary"]["waitingFor"]>,
) {
  if (waitingFor === "user_input") return "Needs input";
  if (waitingFor === "external_event") return "Waiting externally";
  return "Waiting for timer";
}

function latestAgentUpdate(
  timestamps: NonNullable<AgentPathTreeNode["agent"]>["timestamps"],
): string {
  return (
    [
      timestamps.runtimeUpdatedAt,
      timestamps.activityUpdatedAt,
      timestamps.summaryUpdatedAt,
      timestamps.lastWorkAt,
    ]
      .filter((value): value is string => value !== undefined)
      .toSorted()
      .at(-1) ?? timestamps.lastWorkAt
  );
}

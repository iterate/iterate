import { DragDropProvider, useDraggable, useDroppable } from "@dnd-kit/react";
import { useMemo, useState } from "react";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleEllipsisIcon,
  FolderIcon,
  MessageSquareIcon,
  PlusIcon,
  TagIcon,
} from "lucide-react";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@iterate-com/ui/components/tooltip";
import { cn } from "@iterate-com/ui/lib/utils";
import type { TaskChangeStatus } from "../state.ts";
import { taskColumnState } from "../tasks-model.ts";
import {
  stateLabel,
  type BoardTask,
  type PresenceUser,
  type RowField,
} from "../lib/board-model.ts";
import type { BoardProjection } from "../lib/board-engine.ts";

/**
 * The board proper, in the apps/os repo-ide dialect: rows are folder
 * swimlanes (or one row when grouping is off), columns are task states, and
 * every cell is a drop target. Cards wear change tint (emerald added, amber
 * modified) and the presence dots of collaborators editing them.
 */
export function Board({
  projection,
  taskChangeByPath,
  presenceByPath,
  onMove,
  onAdd,
  onOpen,
}: {
  projection: BoardProjection;
  taskChangeByPath: Map<string, TaskChangeStatus>;
  presenceByPath: Map<string, PresenceUser[]>;
  onMove: (task: BoardTask, state: string, folder: string, labels?: string[]) => void;
  onAdd: (state: string, folder: string | null, label?: string) => void;
  onOpen: (path: string) => void;
}) {
  const { rowField, rows, columns, filterActive } = projection;
  const hasGroupBars = !!rowField && rows.length > 1;
  // The centered content's exact width: columns + gaps + wrapper padding.
  // Group-bar labels use it to align with the leftmost column's edge.
  const contentWidth = `calc(${columns.length * 18}rem + ${(columns.length - 1) * 0.5}rem + 1rem)`;
  const byPath = useMemo(() => {
    const map = new Map<string, BoardTask>();
    for (const row of rows) {
      for (const cell of row.cells) for (const task of cell.tasks) map.set(task.path, task);
    }
    return map;
  }, [rows]);

  return (
    <DragDropProvider
      onDragEnd={(event) => {
        if (event.canceled) return;
        const source = parseCardId(String(event.operation.source?.id ?? ""));
        const target = parseCellId(String(event.operation.target?.id ?? ""));
        if (!source || !target) return;
        const task = byPath.get(source.path);
        const row = rows.find((candidate) => candidate.key === target.rowKey);
        if (!task || !row) return;
        const folder = rowField === "folder" ? (row.value ?? task.folder) : task.folder;
        // Dropping into another tag row re-tags the task (no-tag row clears).
        const labels =
          rowField === "label" && source.rowKey !== target.rowKey
            ? !row.value
              ? []
              : [row.value]
            : undefined;
        if (taskColumnState(task.state) !== target.state || task.folder !== folder || labels) {
          onMove(task, target.state, folder, labels);
        }
      }}
    >
      <div className="min-h-0 min-w-0 flex-1 overflow-auto bg-background">
        <div className="w-max min-w-full">
          {/* Column headers: stuck to the very top of the scroll. */}
          <div
            className={cn("sticky top-0 z-20 min-w-full bg-background", hasGroupBars && "border-b")}
          >
            <div className="mx-auto flex w-max gap-2 px-2">
              {columns.map((column) => (
                <div
                  key={column.state}
                  className="flex h-10 w-72 flex-none items-center gap-2 px-3"
                >
                  <TaskStateIcon state={column.state} />
                  <h2 className="truncate text-sm font-medium">{stateLabel(column.state)}</h2>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {filterActive ? `${column.visible}/${column.total}` : column.total}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto h-7 w-7 px-0 text-muted-foreground/60 hover:text-foreground"
                    aria-label={`Add task to ${stateLabel(column.state)}`}
                    onClick={() => onAdd(column.state, null)}
                  >
                    <PlusIcon aria-hidden className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
          {rows.map((row) => (
            <section key={row.key} className="min-w-full">
              {!hasGroupBars ? null : (
                // Full-bleed group bar. Each bar is sticky just below the
                // column headers WITHIN its own section, so scrolling past a
                // group hands the slot to the next bar — pure CSS.
                <header className="sticky top-10 z-10 min-w-full border-y border-border/40 bg-muted">
                  <div className="mx-auto min-w-0" style={{ width: contentWidth }}>
                    {/* Columns sit inside px-2 + per-column px-3 (20px = pl-5): the row icon left edge aligns with the column icon. */}
                    <div className="sticky left-0 flex h-9 w-fit max-w-[100vw] items-center gap-2 pr-3 pl-5 text-sm font-medium">
                      {rowField === "folder" ? (
                        <FolderIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <TagIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <span
                        className={cn("truncate text-xs", rowField === "folder" && "font-mono")}
                      >
                        {row.label}
                      </span>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {row.count}
                      </span>
                    </div>
                  </div>
                </header>
              )}
              <div className="mx-auto flex w-max gap-2 px-2 py-2">
                {row.cells.map((cell) => (
                  <BoardCell
                    key={cell.state}
                    rowField={rowField}
                    state={cell.state}
                    rowKey={row.key}
                    rowValue={row.value}
                    showTags={rowField !== "label"}
                    showFolder={rowField !== "folder"}
                    tasks={cell.tasks}
                    taskChangeByPath={taskChangeByPath}
                    presenceByPath={presenceByPath}
                    onAdd={onAdd}
                    onOpen={onOpen}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </DragDropProvider>
  );
}

/** Cards mounted per cell before "show more" paging kicks in. */
const CELL_PAGE = 60;

function BoardCell({
  rowField,
  state,
  rowKey,
  rowValue,
  showTags,
  showFolder,
  tasks,
  taskChangeByPath,
  presenceByPath,
  onAdd,
  onOpen,
}: {
  rowField: RowField;
  state: string;
  rowKey: string;
  rowValue: string | null;
  showTags: boolean;
  showFolder: boolean;
  tasks: BoardTask[];
  taskChangeByPath: Map<string, TaskChangeStatus>;
  presenceByPath: Map<string, PresenceUser[]>;
  onAdd: (state: string, folder: string | null, label?: string) => void;
  onOpen: (path: string) => void;
}) {
  const { ref, isDropTarget } = useDroppable({
    id: `cell:${encodeURIComponent(rowKey)}:${encodeURIComponent(state)}`,
    accept: "task",
  });
  // DOM stays bounded no matter how big the board gets: cells render a page
  // of cards and grow on demand. 4k mounted cards froze drag outright.
  const [limit, setLimit] = useState(CELL_PAGE);
  const visible = tasks.length > limit ? tasks.slice(0, limit) : tasks;
  return (
    <section
      ref={ref}
      className={cn(
        "group/cell flex min-h-36 w-72 flex-none flex-col pb-4 transition-colors",
        isDropTarget && "rounded-lg bg-accent/40",
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col px-1 pb-1">
        <div className="flex flex-col gap-2">
          {visible.map((task) => (
            <BoardCard
              key={task.path}
              task={task}
              rowKey={rowKey}
              showTags={showTags}
              showFolder={showFolder}
              changeStatus={taskChangeByPath.get(task.path)}
              presence={presenceByPath.get(task.path) ?? []}
              onOpen={onOpen}
            />
          ))}
          {tasks.length > limit && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-full justify-center text-xs text-muted-foreground"
              onClick={() => setLimit((current) => current + CELL_PAGE)}
            >
              Show {Math.min(CELL_PAGE, tasks.length - limit)} more ({tasks.length - limit} hidden)
            </Button>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label="New task"
          className="mt-1 h-8 w-full justify-center text-muted-foreground/60 opacity-0 transition-opacity group-hover/cell:opacity-100 focus-visible:opacity-100 hover:text-foreground"
          onClick={() =>
            // A row value is a FOLDER only under folder grouping; under label
            // grouping it's a tag — the new task goes to the default folder
            // and wears the row's tag instead.
            onAdd(
              state,
              rowField === "folder" ? rowValue : null,
              rowField === "label" ? (rowValue ?? undefined) : undefined,
            )
          }
        >
          <PlusIcon aria-hidden className="size-4" />
        </Button>
      </div>
    </section>
  );
}

function BoardCard({
  task,
  rowKey,
  showTags,
  showFolder,
  changeStatus,
  presence,
  onOpen,
}: {
  task: BoardTask;
  rowKey: string;
  showTags: boolean;
  showFolder: boolean;
  changeStatus: TaskChangeStatus | undefined;
  presence: PresenceUser[];
  onOpen: (path: string) => void;
}) {
  const { ref, isDragging } = useDraggable({
    id: `card:${encodeURIComponent(task.path)}:${encodeURIComponent(rowKey)}`,
    type: "task",
  });
  const changeWord =
    changeStatus === "added" ? "New" : changeStatus === "modified" ? "Edited" : undefined;
  const hoverLines = [changeWord].filter((line): line is string => !!line);
  const card = (
    <button
      type="button"
      ref={ref}
      onClick={() => onOpen(task.path)}
      className={cn(
        "relative w-full cursor-grab rounded-md border border-border/70 bg-card p-2.5 text-left transition-[background-color,border-color,box-shadow,opacity] hover:bg-accent/40 active:cursor-grabbing",
        changeStatus === "added" &&
          "border-emerald-500/60 shadow-[inset_0_0_10px_-4px_rgba(16,185,129,0.4)]",
        changeStatus === "modified" &&
          "border-amber-500/60 shadow-[inset_0_0_10px_-4px_rgba(245,158,11,0.4)]",
        isDragging && "opacity-40",
      )}
    >
      {presence.length > 0 ? (
        <span className="absolute right-2 bottom-2 flex -space-x-1">
          {presence.slice(0, 4).map((user, index) => (
            <span
              key={`${user.name}${index}`}
              title={`${user.name} is here`}
              className="size-2.5 rounded-full ring-2 ring-card"
              style={{ backgroundColor: user.color }}
            />
          ))}
        </span>
      ) : null}
      <div className="flex items-start">
        <span className="min-w-0 flex-1 text-sm leading-snug font-medium">{task.title}</span>
      </div>
      {task.summary === "" ? null : (
        <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {task.summary}
        </p>
      )}
      {(showTags && task.labels.length > 0) ||
      (showFolder && task.folder !== "tasks") ||
      task.commentCount > 0 ? (
        <div className="mt-3 flex min-w-0 flex-wrap items-center gap-1.5">
          {showFolder && task.folder !== "tasks" ? (
            <Badge variant="outline" className="gap-1 font-mono">
              <FolderIcon aria-hidden className="size-3" />
              {task.folder}
            </Badge>
          ) : null}
          {showTags
            ? task.labels.map((label) => (
                <Badge key={label} variant="secondary">
                  {label}
                </Badge>
              ))
            : null}
          {task.commentCount > 0 ? (
            <span
              title={`${task.commentCount} comment${task.commentCount === 1 ? "" : "s"}`}
              className="flex items-center gap-1 text-[11px] text-muted-foreground"
            >
              <MessageSquareIcon aria-hidden className="size-3" />
              {task.commentCount}
            </span>
          ) : null}
        </div>
      ) : null}
    </button>
  );
  if (hoverLines.length === 0) return card;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="block w-full" />}>{card}</TooltipTrigger>
      <TooltipContent side="bottom" className="flex flex-col gap-0.5">
        {hoverLines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

export function TaskStateIcon({ state, className }: { state: string; className?: string }) {
  const shared = cn("size-3.5 shrink-0", className);
  switch (state) {
    case "in-progress":
      return <CircleDotIcon aria-hidden className={cn(shared, "text-amber-500")} />;
    case "in-review":
      return <CircleEllipsisIcon aria-hidden className={cn(shared, "text-sky-500")} />;
    case "done":
      return <CircleCheckIcon aria-hidden className={cn(shared, "text-emerald-600")} />;
    default:
      return <CircleDashedIcon aria-hidden className={cn(shared, "text-muted-foreground")} />;
  }
}

function parseCardId(id: string): { path: string; rowKey: string } | null {
  const match = /^card:([^:]+):(.+)$/.exec(id);
  return match
    ? { path: decodeURIComponent(match[1]!), rowKey: decodeURIComponent(match[2]!) }
    : null;
}

function parseCellId(id: string): { rowKey: string; state: string } | null {
  const match = /^cell:([^:]+):([^:]+)$/.exec(id);
  return match
    ? { rowKey: decodeURIComponent(match[1]!), state: decodeURIComponent(match[2]!) }
    : null;
}

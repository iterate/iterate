import { useEffect, useMemo, useRef, useState } from "react";
import { DragDropProvider, useDraggable, useDroppable } from "@dnd-kit/react";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  CircleIcon,
  FilePenLineIcon,
  FolderIcon,
  PlusIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  TagIcon,
  Trash2Icon,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@iterate-com/ui/components/alert-dialog";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import { Input } from "@iterate-com/ui/components/input";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@iterate-com/ui/components/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@iterate-com/ui/components/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@iterate-com/ui/components/sheet";
import { Textarea } from "@iterate-com/ui/components/textarea";
import { cn } from "@iterate-com/ui/lib/utils";
import {
  createRepoTask,
  isRepoTaskPath,
  parseRepoTask,
  queryRepoTaskBoard,
  repoTaskCreationPaths,
  repoTaskPathInDirectory,
  taskDirectoryForFolder,
  taskStateColumns,
  taskStateLabel,
  updateRepoTaskLabels,
  updateRepoTaskState,
  type RepoTask,
  type RepoTaskBoardProjection,
  type RepoTaskBoardQuery,
  type RepoTaskBoardRowField,
} from "./repo-tasks.ts";
import {
  effectiveEntry,
  textContentForEntry,
  type FileEntry,
  type WorkingTreeChanges,
} from "./staged-changes.ts";
import { useItxQuery } from "~/itx/itx-react.tsx";

type SearchPatch = {
  file?: string;
  diff?: boolean;
  preview?: boolean;
  staged?: boolean;
  tasks?: boolean;
};

export function RepoTasksView({
  projectId,
  repoPath,
  headCommitOid,
  headPaths,
  changes,
  selectedPath,
  onPatchSearch,
  onSetWorking,
  onDelete,
}: {
  projectId: string;
  repoPath: string;
  headCommitOid: string;
  headPaths: readonly string[];
  changes: WorkingTreeChanges;
  selectedPath: string | undefined;
  onPatchSearch: (patch: SearchPatch) => void;
  onSetWorking: (path: string, entry: FileEntry | undefined) => void;
  onDelete: (path: string) => void;
}) {
  const headTaskPaths = useMemo(() => headPaths.filter(isRepoTaskPath), [headPaths]);
  const headContents = useItxQuery({
    key: ["repo-task-files", projectId, repoPath, headCommitOid, headTaskPaths.join("\n")],
    query: async (itx) => {
      const reads = await Promise.all(
        headTaskPaths.map(async (path) => ({
          path,
          read: await itx.repos.get(repoPath).readFile({ path, encoding: "utf8" }),
        })),
      );
      return Object.fromEntries(
        reads.flatMap(({ path, read }) => (read === null ? [] : [[path, read.content]])),
      );
    },
  });

  const tasks = useMemo(() => {
    const contents = new Map(Object.entries(headContents));
    for (const [path, change] of changes) {
      if (!isRepoTaskPath(path)) continue;
      const entry = effectiveEntry(change);
      const content = textContentForEntry(entry);
      if (content !== undefined) contents.set(path, content);
      else if (entry !== undefined) contents.delete(path);
    }
    return [...contents]
      .flatMap(([path, content]) => {
        const task = parseRepoTask(path, content);
        return task === null ? [] : [task];
      })
      .sort((left, right) => left.title.localeCompare(right.title));
  }, [changes, headContents]);

  const effectivePaths = useMemo(() => {
    return repoTaskCreationPaths(
      headPaths,
      [...changes].map(([path, change]) => [path, effectiveEntry(change)?.type] as const),
    );
  }, [changes, headPaths]);

  const columns = taskStateColumns(tasks);
  const selectedTask = tasks.find((task) => task.path === selectedPath);
  const writeTask = (task: RepoTask, content: string) => {
    const baseline = textContentForEntry(changes.get(task.path)?.staged) ?? headContents[task.path];
    onSetWorking(task.path, content === baseline ? undefined : { type: "write", content });
  };
  const selectTask = (path: string | undefined) =>
    onPatchSearch({ file: path, diff: undefined, preview: undefined, staged: undefined });
  const createTask = (state: string, folderPath: string, labels?: readonly string[]) => {
    const created = createRepoTask("New task", effectivePaths, taskDirectoryForFolder(folderPath));
    if (created === null) return;
    const initialContent = `${created.content}\n`;
    let content = state === "todo" ? initialContent : updateRepoTaskState(initialContent, state);
    if (labels !== undefined && labels.length > 0) content = updateRepoTaskLabels(content, labels);
    onSetWorking(created.path, { type: "write", content });
    selectTask(created.path);
  };
  const deleteTask = (task: RepoTask) => {
    onDelete(task.path);
    selectTask(undefined);
  };
  const moveTaskToPath = (task: RepoTask, targetPath: string, content = task.content) => {
    if (targetPath === task.path) return true;
    if (effectivePaths.has(targetPath)) return false;
    const wasSelected = selectedPath === task.path;
    onDelete(task.path);
    onSetWorking(targetPath, { type: "write", content });
    if (wasSelected) selectTask(targetPath);
    return true;
  };
  const moveTaskOnBoard = (
    task: RepoTask,
    state: string,
    folderPath: string,
    labels?: readonly string[],
  ) => {
    let content = state === task.state ? task.content : updateRepoTaskState(task.content, state);
    if (
      labels !== undefined &&
      (labels.length !== task.labels.length ||
        labels.some((label, index) => label !== task.labels[index]))
    )
      content = updateRepoTaskLabels(content, labels);
    if (folderPath === task.folderPath) {
      if (content !== task.content) writeTask(task, content);
      return;
    }
    const targetPath = repoTaskPathInDirectory(
      task.path,
      taskDirectoryForFolder(folderPath),
      effectivePaths,
    );
    moveTaskToPath(task, targetPath, content);
  };
  const renameTask = (task: RepoTask, path: string) => {
    const targetPath = path.trim().replace(/^\/+/, "");
    const segments = targetPath.split("/");
    if (
      !isRepoTaskPath(targetPath) ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..")
    )
      return false;
    return moveTaskToPath(task, targetPath);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <TaskBoard
        tasks={tasks}
        onOpen={(task) => selectTask(task.path)}
        onMove={moveTaskOnBoard}
        onCreate={createTask}
      />
      <TaskEditorSheet
        task={selectedTask}
        columns={columns}
        onOpenChange={(open) => {
          if (!open) selectTask(undefined);
        }}
        onChangeContent={(content) => {
          if (selectedTask !== undefined) writeTask(selectedTask, content);
        }}
        onChangeState={(state) => {
          if (selectedTask !== undefined)
            writeTask(selectedTask, updateRepoTaskState(selectedTask.content, state));
        }}
        onRenamePath={(path) =>
          selectedTask === undefined ? false : renameTask(selectedTask, path)
        }
        onOpenInEditor={() => {
          if (selectedTask !== undefined)
            onPatchSearch({
              file: selectedTask.path,
              tasks: undefined,
              diff: undefined,
              preview: undefined,
              staged: undefined,
            });
        }}
        onDelete={() => {
          if (selectedTask !== undefined) deleteTask(selectedTask);
        }}
      />
    </div>
  );
}

const TASK_CARD_PREFIX = "task-card:";
const TASK_CELL_PREFIX = "task-cell:";

function TaskBoard({
  tasks,
  onOpen,
  onMove,
  onCreate,
}: {
  tasks: readonly RepoTask[];
  onOpen: (task: RepoTask) => void;
  onMove: (task: RepoTask, state: string, folderPath: string, labels?: readonly string[]) => void;
  onCreate: (state: string, folderPath: string, labels?: readonly string[]) => void;
}) {
  const [rowField, setRowField] = useState<RepoTaskBoardRowField>("folder");
  const [filter, setFilter] = useState("");
  const draggedPathRef = useRef<string | undefined>(undefined);
  const boardScrollRef = useRef<HTMLDivElement>(null);
  const query = useMemo<RepoTaskBoardQuery>(
    () => ({ filter, columns: "state", rows: rowField }),
    [filter, rowField],
  );
  const board = useMemo<RepoTaskBoardProjection>(
    () => queryRepoTaskBoard(tasks, query),
    [query, tasks],
  );
  useEffect(() => {
    boardScrollRef.current?.scrollTo({ left: 0, top: 0 });
  }, [rowField]);

  return (
    <DragDropProvider
      onDragStart={(event) => {
        draggedPathRef.current = taskFromDragId(String(event.operation.source?.id ?? ""))?.path;
      }}
      onDragEnd={(event) => {
        const source = taskFromDragId(String(event.operation.source?.id ?? ""));
        const path = source?.path;
        if (!event.canceled && source !== undefined) {
          const target = taskCellFromDropId(String(event.operation.target?.id ?? ""));
          const task = tasks.find((candidate) => candidate.path === source.path);
          const row = board.rows.find((candidate) => candidate.key === target?.rowKey);
          if (task !== undefined && target !== undefined && row !== undefined) {
            const folderPath = rowField === "folder" ? (row.value ?? "/") : task.folderPath;
            const labels =
              rowField === "label" && source.rowKey !== target.rowKey
                ? row.value === null
                  ? []
                  : [row.value]
                : undefined;
            if (
              task.state !== target.state ||
              task.folderPath !== folderPath ||
              labels !== undefined
            )
              onMove(task, target.state, folderPath, labels);
          }
        }
        setTimeout(() => {
          if (draggedPathRef.current === path) draggedPathRef.current = undefined;
        });
      }}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-muted/30">
        <div className="flex shrink-0 items-center gap-2 border-b bg-background px-2 py-2">
          <div className="relative min-w-0 flex-1 sm:max-w-sm">
            <SearchIcon
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={filter}
              onChange={(event) => setFilter(event.currentTarget.value)}
              aria-label="Filter tasks"
              placeholder="Filter tasks"
              className="h-8 bg-background pl-8"
            />
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline">
              {board.taskCount} {board.taskCount === 1 ? "task" : "tasks"}
            </span>
            <BoardDisplaySettings rowField={rowField} onChangeRowField={setRowField} />
          </div>
        </div>
        <div ref={boardScrollRef} className="min-h-0 min-w-0 flex-1 overflow-auto p-2">
          <div className="flex min-h-full w-max min-w-full flex-col gap-4">
            {board.rows.map((row, rowIndex) => (
              <section
                key={row.key}
                data-task-row={row.key}
                className={cn(
                  "flex min-w-full flex-col",
                  board.rows.length === 1 && "min-h-full flex-1",
                )}
              >
                {rowField === null ? null : (
                  <header className="sticky left-0 flex h-9 w-fit max-w-[calc(100vw-4rem)] items-center gap-2 px-2 text-sm font-medium">
                    {rowField === "folder" ? (
                      <FolderIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <TagIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate">{row.label}</span>
                  </header>
                )}
                <div className="flex min-h-0 min-w-full flex-1 snap-x snap-mandatory gap-2 sm:snap-none">
                  {row.cells.map((cell) => (
                    <TaskColumn
                      key={`${row.key}:${cell.state}`}
                      state={cell.state}
                      rowKey={row.key}
                      rowLabel={row.label}
                      tasks={cell.tasks}
                      visibleProperties={board.visibleProperties}
                      showHeader={rowIndex === 0}
                      onOpen={(task) => {
                        if (draggedPathRef.current !== task.path) onOpen(task);
                      }}
                      onCreate={() => {
                        const labels =
                          rowField === "label" && row.value !== null ? [row.value] : undefined;
                        onCreate(
                          cell.state,
                          rowField === "folder" ? (row.value ?? "/") : "/",
                          labels,
                        );
                      }}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
    </DragDropProvider>
  );
}

function BoardDisplaySettings({
  rowField,
  onChangeRowField,
}: {
  rowField: RepoTaskBoardRowField;
  onChangeRowField: (field: RepoTaskBoardRowField) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" size="default" />}>
        <SlidersHorizontalIcon data-icon="inline-start" />
        Display
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 gap-4 p-4">
        <PopoverHeader>
          <PopoverTitle>Board display</PopoverTitle>
          <PopoverDescription>
            Choose the two dimensions used to query the tasks.
          </PopoverDescription>
        </PopoverHeader>
        <div className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-3">
          <span className="text-muted-foreground">Columns</span>
          <Badge variant="secondary">Status</Badge>
          <span className="text-muted-foreground">Rows</span>
          <Select
            value={rowField ?? "none"}
            onValueChange={(value) => {
              if (value === "none") onChangeRowField(null);
              else if (value === "folder" || value === "label") onChangeRowField(value);
            }}
          >
            <SelectTrigger aria-label="Task board row grouping" size="sm" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Group rows by</SelectLabel>
                <SelectItem value="none">No grouping</SelectItem>
                <SelectItem value="folder">Folder</SelectItem>
                <SelectItem value="label">Label</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function TaskColumn({
  state,
  rowKey,
  rowLabel,
  tasks,
  visibleProperties,
  showHeader,
  onOpen,
  onCreate,
}: {
  state: string;
  rowKey: string;
  rowLabel: string | null;
  tasks: readonly RepoTask[];
  visibleProperties: RepoTaskBoardProjection["visibleProperties"];
  showHeader: boolean;
  onOpen: (task: RepoTask) => void;
  onCreate: () => void;
}) {
  const dropId = `${TASK_CELL_PREFIX}${encodeURIComponent(rowKey)}:${encodeURIComponent(state)}`;
  const { ref, isDropTarget } = useDroppable({ id: dropId, accept: "repo-task" });
  const label = taskStateLabel(state);
  const creationLabel = rowLabel === null ? label : `${label} in ${rowLabel}`;

  return (
    <section
      ref={ref}
      data-task-cell={dropId}
      className={cn(
        "flex min-h-52 min-w-[calc(100vw-3.5rem)] flex-1 basis-72 snap-start flex-col rounded-lg bg-background/70 transition-colors sm:min-w-72",
        isDropTarget && "bg-accent/40",
      )}
    >
      {showHeader ? (
        <header className="flex h-12 shrink-0 items-center px-3">
          <div className="flex min-w-0 items-center gap-2">
            <TaskStateIcon state={state} />
            <h2 className="truncate text-sm font-medium">{label}</h2>
            <span className="text-xs tabular-nums text-muted-foreground">{tasks.length}</span>
          </div>
        </header>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col px-2 pb-1">
        <div className="flex flex-col gap-2">
          {tasks.map((task) => (
            <TaskCard
              key={task.path}
              task={task}
              dragId={`${TASK_CARD_PREFIX}${encodeURIComponent(task.path)}:${encodeURIComponent(rowKey)}`}
              visibleProperties={visibleProperties}
              onOpen={onOpen}
            />
          ))}
        </div>
        <div className="group/task-footer mt-auto min-h-16 pt-3 pb-2">
          <Button
            variant="ghost"
            className="h-10 w-full border border-dashed border-border/70 text-muted-foreground/60 opacity-100 transition-[opacity,background-color,color] pointer-fine:opacity-0 group-hover/task-footer:opacity-100! focus-visible:opacity-100! hover:bg-muted/70 hover:text-muted-foreground"
            title={`Add task to ${creationLabel}`}
            aria-label={`Add task to ${creationLabel}`}
            onClick={onCreate}
          >
            <PlusIcon className="size-5" data-icon="inline-start" />
          </Button>
        </div>
      </div>
    </section>
  );
}

function taskFromDragId(id: string): { path: string; rowKey: string } | undefined {
  if (!id.startsWith(TASK_CARD_PREFIX)) return undefined;
  const [encodedPath, encodedRow] = id.slice(TASK_CARD_PREFIX.length).split(":", 2);
  if (encodedPath === undefined || encodedRow === undefined) return undefined;
  return { path: decodeURIComponent(encodedPath), rowKey: decodeURIComponent(encodedRow) };
}

function taskCellFromDropId(id: string): { rowKey: string; state: string } | undefined {
  if (!id.startsWith(TASK_CELL_PREFIX)) return undefined;
  const [encodedRow, encodedState] = id.slice(TASK_CELL_PREFIX.length).split(":", 2);
  if (encodedRow === undefined || encodedState === undefined) return undefined;
  return { rowKey: decodeURIComponent(encodedRow), state: decodeURIComponent(encodedState) };
}

function TaskCard({
  task,
  dragId,
  visibleProperties,
  onOpen,
}: {
  task: RepoTask;
  dragId: string;
  visibleProperties: RepoTaskBoardProjection["visibleProperties"];
  onOpen: (task: RepoTask) => void;
}) {
  const { ref, isDragging } = useDraggable({ id: dragId, type: "repo-task" });
  const summary = task.description.replace(/\s+/g, " ").slice(0, 160);
  return (
    <button
      type="button"
      ref={ref}
      data-task-path={task.path}
      aria-label={task.title}
      onClick={() => onOpen(task)}
      className={cn(
        "w-full cursor-grab rounded-lg border bg-card p-3 text-left shadow-xs transition-[background-color,border-color,box-shadow,opacity] hover:border-foreground/15 hover:bg-accent/30 hover:shadow-sm active:cursor-grabbing",
        isDragging && "opacity-40 shadow-none",
      )}
    >
      {visibleProperties.folder ? (
        <div className="mb-2 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <FolderIcon aria-hidden className="size-3 shrink-0" />
          <span className="truncate font-mono">{task.folderPath}</span>
        </div>
      ) : null}
      <div className="flex items-start gap-2">
        {visibleProperties.state ? <TaskStateIcon state={task.state} className="mt-0.5" /> : null}
        <span className="min-w-0 flex-1 text-sm font-medium leading-snug">{task.title}</span>
      </div>
      {summary === "" ? null : (
        <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{summary}</p>
      )}
      {!visibleProperties.labels || task.labels.length === 0 ? null : (
        <div className="mt-3 flex min-w-0 flex-wrap items-center gap-1.5">
          {task.labels.map((label) => (
            <Badge key={label} variant="secondary">
              {label}
            </Badge>
          ))}
        </div>
      )}
    </button>
  );
}

function TaskStateIcon({ state, className }: { state: string; className?: string }) {
  const Icon =
    state === "backlog"
      ? CircleDashedIcon
      : state === "done"
        ? CircleCheckIcon
        : state === "in-progress"
          ? CircleDotDashedIcon
          : CircleIcon;
  const tone =
    state === "done"
      ? "text-emerald-500"
      : state === "in-progress"
        ? "text-primary"
        : "text-muted-foreground";
  return <Icon aria-hidden className={cn("size-4 shrink-0", tone, className)} />;
}

function TaskEditorSheet({
  task,
  columns,
  onOpenChange,
  onChangeContent,
  onChangeState,
  onRenamePath,
  onOpenInEditor,
  onDelete,
}: {
  task: RepoTask | undefined;
  columns: readonly string[];
  onOpenChange: (open: boolean) => void;
  onChangeContent: (content: string) => void;
  onChangeState: (state: string) => void;
  onRenamePath: (path: string) => boolean;
  onOpenInEditor: () => void;
  onDelete: () => void;
}) {
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const taskPath = task?.path;
  useEffect(() => {
    if (taskPath === undefined) return;
    const frame = requestAnimationFrame(() => {
      const editor = editorRef.current;
      if (editor === null) return;
      editor.focus();
      editor.setSelectionRange(editor.value.length, editor.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, [taskPath]);

  return (
    <Sheet
      open={task !== undefined}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(open) => {
        if (!open) return;
        const editor = editorRef.current;
        if (editor === null) return;
        editor.focus();
        editor.setSelectionRange(editor.value.length, editor.value.length);
      }}
    >
      {task === undefined ? null : (
        <SheetContent
          initialFocus={editorRef}
          className="w-full gap-0 p-0 data-[side=right]:sm:w-[60vw] data-[side=right]:sm:max-w-[60vw]"
        >
          <SheetHeader className="shrink-0 border-b pr-14">
            <SheetTitle>{task.title}</SheetTitle>
            <SheetDescription className="sr-only">
              Edit the task Markdown and file metadata.
            </SheetDescription>
            <Input
              key={task.path}
              defaultValue={`/${task.path}`}
              aria-label="Task file path"
              className="h-6 rounded-none border-0 px-0 font-mono text-xs text-muted-foreground shadow-none focus-visible:ring-0"
              onBlur={(event) => {
                if (!onRenamePath(event.currentTarget.value))
                  event.currentTarget.value = `/${task.path}`;
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.blur();
                } else if (event.key === "Escape") {
                  event.currentTarget.value = `/${task.path}`;
                  event.currentTarget.blur();
                }
              }}
            />
          </SheetHeader>
          <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
            <Select value={task.state} onValueChange={(value) => value && onChangeState(value)}>
              <SelectTrigger aria-label="Task state" size="sm" className="w-32 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>State</SelectLabel>
                  {columns.map((state) => (
                    <SelectItem key={state} value={state}>
                      {taskStateLabel(state)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <div className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
              <FolderIcon aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate font-mono">{task.folderPath}</span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 text-muted-foreground"
              title="Open in editor"
              onClick={onOpenInEditor}
            >
              <FilePenLineIcon data-icon="inline-start" />
              Editor
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-muted-foreground hover:text-destructive"
              title="Delete task"
              aria-label="Delete task"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2Icon data-icon="inline-start" />
            </Button>
          </div>
          <Textarea
            ref={editorRef}
            aria-label={`Edit ${task.title} Markdown`}
            value={task.content}
            onChange={(event) => onChangeContent(event.currentTarget.value)}
            className="min-h-0 flex-1 resize-none rounded-none border-0 px-5 py-4 font-mono text-sm leading-relaxed focus-visible:border-transparent focus-visible:ring-0"
          />
          <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
            <AlertDialogContent size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {task.title}?</AlertDialogTitle>
                <AlertDialogDescription>
                  This adds the deletion of {task.path} to Source Control. You can restore it until
                  you commit.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => {
                    setDeleteOpen(false);
                    onDelete();
                  }}
                >
                  Delete task
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </SheetContent>
      )}
    </Sheet>
  );
}

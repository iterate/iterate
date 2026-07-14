import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { DragDropProvider, useDraggable, useDroppable } from "@dnd-kit/react";
import { Link } from "@tanstack/react-router";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  CircleIcon,
  BotIcon,
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
import { Field, FieldGroup, FieldLabel, FieldTitle } from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@iterate-com/ui/components/input-group";
import { Kbd } from "@iterate-com/ui/components/kbd";
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
import { Spinner } from "@iterate-com/ui/components/spinner";
import { Textarea } from "@iterate-com/ui/components/textarea";
import { cn } from "@iterate-com/ui/lib/utils";
import {
  createRepoTask,
  isRepoTaskPath,
  parseRepoTask,
  queryRepoTaskBoard,
  repoTaskHeadingSelection,
  repoTaskHeadingTitle,
  repoTaskCreationPaths,
  repoTaskPathForTitle,
  repoTaskPathInDirectory,
  repoTaskWithPath,
  taskColumnState,
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
import { reconcileEditorPathOverride, type EditorPathOverride } from "./repo-task-editor-state.ts";
import { useItxQuery } from "~/itx/itx-react.tsx";
import { linkOptionsForStreamPath } from "~/lib/stream-routes.ts";

type SearchPatch = {
  file?: string;
  diff?: boolean;
  preview?: boolean;
  staged?: boolean;
  tasks?: boolean;
};

export function RepoTasksView({
  projectId,
  projectSlug,
  repoPath,
  headCommitOid,
  headPaths,
  changes,
  selectedPath,
  onPatchSearch,
  onSetWorking,
  onDelete,
  onAssignAgent,
}: {
  projectId: string;
  projectSlug: string;
  repoPath: string;
  headCommitOid: string;
  headPaths: readonly string[];
  changes: WorkingTreeChanges;
  selectedPath: string | undefined;
  onPatchSearch: (patch: SearchPatch) => void;
  onSetWorking: (path: string, entry: FileEntry | undefined) => void;
  onDelete: (path: string) => void;
  onAssignAgent: (task: RepoTask, renamedFromPath?: string) => Promise<string | undefined>;
}) {
  const [draft, setDraft] = useState<RepoTask | undefined>();
  const [editorPathOverride, setEditorPathOverride] = useState<EditorPathOverride>();
  const editorPath =
    editorPathOverride !== undefined && editorPathOverride.source === selectedPath
      ? editorPathOverride.target
      : selectedPath;
  const renameOrigins = useRef(new Map<string, string>());
  const lastCreationContext = useRef<{
    state: string;
    folderPath: string;
    labels?: readonly string[];
  }>({ state: "todo", folderPath: "/" });
  // All task file contents in ONE clone, keyed by path. The previous approach
  // (list the whole tree, then a readFile per task) fanned N reads at the repo
  // DO, and on any repo without the root workspace cache each readFile is its
  // own full clone — N concurrent clones of a big repo overload the DO. This
  // scales with the number of tasks, not the repo size. `headCommitOid` alone
  // keys the cache: the task file set is fully determined by the commit.
  const headContents = useItxQuery({
    key: ["repo-task-files", projectId, repoPath, headCommitOid],
    query: (itx) =>
      itx.repos
        .get(repoPath)
        .listTaskFiles()
        .then((result) => result.files),
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
    const paths = repoTaskCreationPaths(
      headPaths,
      [...changes].map(([path, change]) => [path, effectiveEntry(change)?.type] as const),
    );
    // Committed task cards come from `listTaskFiles` (headContents), which can
    // observe a newer HEAD than `headPaths` (the repo-files listing). Reserve
    // those committed task paths too, so create/rename collision checks never
    // hand out a path that already holds a committed task the file listing has
    // not caught up to.
    for (const path of Object.keys(headContents)) paths.add(path);
    return paths;
  }, [changes, headPaths, headContents]);

  const columns = taskStateColumns(tasks);
  const selectedTask = tasks.find((task) => task.path === editorPath);
  const editorTask = draft ?? selectedTask;

  useEffect(() => {
    setEditorPathOverride((override) => reconcileEditorPathOverride(override, selectedPath));
  }, [selectedPath]);

  const writeTask = (task: RepoTask, content: string) => {
    const baseline = textContentForEntry(changes.get(task.path)?.staged) ?? headContents[task.path];
    onSetWorking(task.path, content === baseline ? undefined : { type: "write", content });
  };
  const selectTask = (path: string | undefined) => {
    // Keep the editor bound to its destination synchronously. Working-tree
    // renames update the task list before router navigation can update the URL.
    setEditorPathOverride({ source: selectedPath, target: path });
    onPatchSearch({ file: path, diff: undefined, preview: undefined, staged: undefined });
  };
  const persistDraft = (task = draft) => {
    if (task === undefined) return;
    onSetWorking(task.path, { type: "write", content: task.content });
    setDraft(undefined);
  };
  const openTask = (task: RepoTask) => {
    // Starting another action should never silently replace a new task. Put
    // the current draft into the ordinary working tree first; it remains
    // uncommitted and can be edited, staged, or discarded like any file.
    persistDraft();
    selectTask(task.path);
  };
  const createTask = (state: string, folderPath: string, labels?: readonly string[]) => {
    lastCreationContext.current = {
      state,
      folderPath,
      ...(labels === undefined ? {} : { labels }),
    };
    const reservedPaths = new Set(effectivePaths);
    if (draft !== undefined) reservedPaths.add(draft.path);
    persistDraft();
    const created = createRepoTask("New task", reservedPaths, taskDirectoryForFolder(folderPath));
    if (created === null) return;
    const initialContent = created.content;
    let content = state === "todo" ? initialContent : updateRepoTaskState(initialContent, state);
    if (labels !== undefined && labels.length > 0) content = updateRepoTaskLabels(content, labels);
    const createdDraft = parseRepoTask(created.path, content);
    if (createdDraft !== null) {
      selectTask(undefined);
      setDraft(createdDraft);
    }
  };
  const deleteTask = (task: RepoTask) => {
    renameOrigins.current.delete(task.path);
    onDelete(task.path);
    selectTask(undefined);
  };
  const moveTaskToPath = (task: RepoTask, targetPath: string, content = task.content) => {
    if (targetPath === task.path) return true;
    if (effectivePaths.has(targetPath)) return false;
    const originalPath =
      renameOrigins.current.get(task.path) ??
      (Object.prototype.hasOwnProperty.call(headContents, task.path) ? task.path : undefined);
    const wasSelected = editorPath === task.path;
    onDelete(task.path);
    onSetWorking(targetPath, { type: "write", content });
    renameOrigins.current.delete(task.path);
    if (originalPath !== undefined && originalPath !== targetPath)
      renameOrigins.current.set(targetPath, originalPath);
    if (wasSelected) selectTask(targetPath);
    return true;
  };
  const moveTaskOnBoard = (
    task: RepoTask,
    state: string,
    folderPath: string,
    labels?: readonly string[],
  ) => {
    let content =
      state === taskColumnState(task) ? task.content : updateRepoTaskState(task.content, state);
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
  const resolveEditorPath = (path: string) => {
    const task = editorTask;
    if (task === undefined) return undefined;
    const resolved = repoTaskWithPath(task, path, effectivePaths);
    if (resolved === null) return undefined;
    if (resolved.path === task.path) return task;
    if (draft !== undefined) setDraft(resolved);
    else if (!moveTaskToPath(task, resolved.path)) return undefined;
    return resolved;
  };
  const updateEditorContent = (content: string, syncPath: boolean) => {
    const task = editorTask;
    if (task === undefined) return;
    const headingTitle = syncPath ? repoTaskHeadingTitle(content) : undefined;
    const nextPath =
      headingTitle === undefined
        ? task.path
        : repoTaskPathForTitle(task.path, headingTitle, effectivePaths);
    if (draft !== undefined) {
      const updated = parseRepoTask(nextPath, content);
      if (updated !== null) setDraft(updated);
    } else if (nextPath === task.path) writeTask(task, content);
    else moveTaskToPath(task, nextPath, content);
  };
  const closeEditor = (task: RepoTask) => {
    // Dismissing a new-task sheet should behave like switching cards: keep
    // what was typed as an ordinary uncommitted working-tree file.
    if (draft !== undefined) persistDraft(task);
    selectTask(undefined);
  };

  const persistDraftOnUnmount = useEffectEvent(() => {
    if (draft === undefined) return;
    onSetWorking(draft.path, { type: "write", content: draft.content });
  });

  const createTaskFromKeyboard = useEffectEvent((event: KeyboardEvent) => {
    const target = event.target;
    if (
      event.key.toLocaleLowerCase() !== "c" ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      editorTask !== undefined ||
      (target instanceof HTMLElement &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)))
    )
      return;
    event.preventDefault();
    const context = lastCreationContext.current;
    createTask(context.state, context.folderPath, context.labels);
  });

  useEffect(() => () => persistDraftOnUnmount(), []);

  useEffect(() => {
    const createFromKeyboard = (event: KeyboardEvent) => createTaskFromKeyboard(event);
    window.addEventListener("keydown", createFromKeyboard);
    return () => window.removeEventListener("keydown", createFromKeyboard);
  }, []);

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <TaskBoard tasks={tasks} onOpen={openTask} onMove={moveTaskOnBoard} onCreate={createTask} />
      <TaskEditorSheet
        task={editorTask}
        projectSlug={projectSlug}
        isNew={draft !== undefined}
        columns={columns}
        onDismiss={closeEditor}
        onChangeContent={updateEditorContent}
        onChangeState={(state) => {
          if (draft !== undefined) {
            const updated = parseRepoTask(draft.path, updateRepoTaskState(draft.content, state));
            if (updated !== null) setDraft(updated);
          } else if (selectedTask !== undefined)
            writeTask(selectedTask, updateRepoTaskState(selectedTask.content, state));
        }}
        onResolvePath={resolveEditorPath}
        onOpenInEditor={(task) =>
          onPatchSearch({
            file: task.path,
            tasks: undefined,
            diff: undefined,
            preview: undefined,
            staged: undefined,
          })
        }
        onDelete={deleteTask}
        onSubmit={closeEditor}
        onAssignAgent={async (task) => {
          const agentPath = await onAssignAgent(task, renameOrigins.current.get(task.path));
          if (agentPath !== undefined) renameOrigins.current.delete(task.path);
          return agentPath;
        }}
      />
    </div>
  );
}

const TASK_CARD_PREFIX = "task-card:";
const TASK_CELL_PREFIX = "task-cell:";
const TASK_BOARD_ROW_ITEMS = [
  { label: "No grouping", value: "none" },
  { label: "Folder", value: "folder" },
  { label: "Label", value: "label" },
] as const;

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
              taskColumnState(task) !== target.state ||
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
          <FieldGroup className="min-w-0 flex-1 gap-0 sm:max-w-sm">
            <Field className="gap-0">
              <FieldLabel htmlFor="task-board-filter" className="sr-only">
                Filter tasks
              </FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id="task-board-filter"
                  value={filter}
                  onChange={(event) => setFilter(event.currentTarget.value)}
                  placeholder="Filter tasks"
                />
                <InputGroupAddon aria-hidden tabIndex={-1}>
                  <SearchIcon aria-hidden />
                </InputGroupAddon>
              </InputGroup>
            </Field>
          </FieldGroup>
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
        <FieldGroup className="gap-3">
          <Field orientation="horizontal">
            <FieldTitle>Columns</FieldTitle>
            <Badge variant="secondary" className="ml-auto">
              Status
            </Badge>
          </Field>
          <Field orientation="horizontal">
            <FieldLabel htmlFor="task-board-row-grouping">Rows</FieldLabel>
            <Select
              items={TASK_BOARD_ROW_ITEMS}
              value={rowField ?? "none"}
              onValueChange={(value) => {
                if (value === "none") onChangeRowField(null);
                else if (value === "folder" || value === "label") onChangeRowField(value);
              }}
            >
              <SelectTrigger id="task-board-row-grouping" size="sm" className="ml-auto w-32">
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
          </Field>
        </FieldGroup>
      </PopoverContent>
    </Popover>
  );
}

export function TaskColumn({
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
        "flex min-h-36 w-[calc(100vw-3.5rem)] flex-none snap-start flex-col pb-4 transition-colors sm:w-72",
        isDropTarget && "rounded-lg bg-accent/40",
      )}
    >
      {showHeader ? (
        <header className="flex h-12 shrink-0 items-center px-3">
          <div className="flex min-w-0 items-center gap-2">
            <TaskStateIcon state={state} />
            <h2 className="truncate text-sm font-medium">{label}</h2>
          </div>
        </header>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col px-2 pb-2">
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
        <Button
          variant="outline"
          className="mt-2 h-10 w-full border-dashed text-muted-foreground"
          title={`Add task to ${creationLabel}`}
          aria-label={`Add task to ${creationLabel}`}
          onClick={onCreate}
        >
          <PlusIcon data-icon="inline-start" />
        </Button>
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
        {visibleProperties.state ? (
          <TaskStateIcon state={taskColumnState(task)} className="mt-0.5" />
        ) : null}
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
  projectSlug,
  isNew,
  columns,
  onDismiss,
  onChangeContent,
  onChangeState,
  onResolvePath,
  onOpenInEditor,
  onDelete,
  onSubmit,
  onAssignAgent,
}: {
  task: RepoTask | undefined;
  projectSlug: string;
  isNew: boolean;
  columns: readonly string[];
  onDismiss: (task: RepoTask) => void;
  onChangeContent: (content: string, syncPath: boolean) => void;
  onChangeState: (state: string) => void;
  onResolvePath: (path: string) => RepoTask | undefined;
  onOpenInEditor: (task: RepoTask) => void;
  onDelete: (task: RepoTask) => void;
  onSubmit: (task: RepoTask) => void;
  onAssignAgent: (task: RepoTask) => Promise<string | undefined>;
}) {
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [deleteTargetPath, setDeleteTargetPath] = useState<string>();
  const [pathDraft, setPathDraft] = useState<{ source: string; value: string }>();
  const [assignment, setAssignment] = useState<{
    taskPath: string;
    assigning: boolean;
    agent?: string;
  }>();
  const taskPath = task?.path;
  const pathWasEdited = taskPath !== undefined && pathDraft?.source === taskPath;
  const pathValue = taskPath === undefined ? "" : pathWasEdited ? pathDraft.value : `/${taskPath}`;
  const currentAssignment = assignment?.taskPath === taskPath ? assignment : undefined;
  const assigning = currentAssignment?.assigning ?? false;
  const visibleAgent = task?.agent ?? currentAssignment?.agent;
  const deleteOpen = taskPath !== undefined && deleteTargetPath === taskPath;
  const columnItems = columns.map((state) => ({ label: taskStateLabel(state), value: state }));

  const resolvePath = () => {
    if (task === undefined) return undefined;
    if (!pathWasEdited) return task;
    const resolved = onResolvePath(pathValue);
    setPathDraft(undefined);
    return resolved;
  };

  const withResolvedPath = (action: (resolved: RepoTask) => void) => {
    const resolved = resolvePath();
    if (resolved !== undefined) action(resolved);
  };

  return (
    <Sheet
      open={task !== undefined}
      onOpenChange={(open) => {
        if (!open && task !== undefined) onDismiss(resolvePath() ?? task);
      }}
    >
      {task === undefined ? null : (
        <SheetContent
          initialFocus={() => {
            const editor = editorRef.current;
            if (editor === null) return null;
            const titleSelection = isNew ? repoTaskHeadingSelection(editor.value) : undefined;
            const start = titleSelection?.start ?? editor.value.length;
            const end = titleSelection?.end ?? editor.value.length;
            editor.setSelectionRange(start, end);
            return editor;
          }}
          className="w-full gap-0 p-0 data-[side=right]:sm:w-[60vw] data-[side=right]:sm:max-w-[60vw]"
        >
          <SheetHeader className="shrink-0 border-b pr-14">
            <SheetTitle>{task.title}</SheetTitle>
            <SheetDescription className="sr-only">
              Edit the task Markdown and file metadata.
            </SheetDescription>
            <FieldGroup className="contents">
              <Field className="contents">
                <FieldLabel htmlFor="task-file-path" className="sr-only">
                  Task file path
                </FieldLabel>
                <Input
                  id="task-file-path"
                  value={pathValue}
                  className="h-6 rounded-none border-0 px-0 font-mono text-xs text-muted-foreground shadow-none focus-visible:ring-0"
                  onChange={(event) =>
                    setPathDraft({ source: task.path, value: event.currentTarget.value })
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      resolvePath();
                      event.currentTarget.blur();
                    } else if (event.key === "Escape") {
                      setPathDraft(undefined);
                      event.currentTarget.blur();
                    }
                  }}
                />
              </Field>
            </FieldGroup>
          </SheetHeader>
          <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
            <Select
              items={columnItems}
              value={taskColumnState(task)}
              onValueChange={(value) => value && onChangeState(value)}
            >
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
            <div className="ml-auto flex min-w-0 items-center gap-1">
              {isNew ? (
                <Button size="sm" onClick={() => withResolvedPath(onSubmit)}>
                  Create task
                  <Kbd className="ml-1 hidden sm:inline-flex">⌘↵</Kbd>
                </Button>
              ) : (
                <>
                  {visibleAgent === undefined ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={assigning}
                      onClick={async () => {
                        const resolved = resolvePath();
                        if (resolved === undefined) return;
                        setAssignment({ taskPath: resolved.path, assigning: true });
                        try {
                          const agent = await onAssignAgent(resolved);
                          setAssignment({
                            taskPath: resolved.path,
                            assigning: false,
                            ...(agent === undefined ? {} : { agent }),
                          });
                        } catch (error) {
                          setAssignment(undefined);
                          throw error;
                        }
                      }}
                    >
                      {assigning ? (
                        <Spinner data-icon="inline-start" />
                      ) : (
                        <BotIcon data-icon="inline-start" />
                      )}
                      {assigning ? "Assigning…" : "Assign agent"}
                    </Button>
                  ) : (
                    <Button
                      render={<Link {...linkOptionsForStreamPath(projectSlug, visibleAgent)} />}
                      nativeButton={false}
                      variant="secondary"
                      size="sm"
                      className="min-w-0 max-w-48"
                      title={visibleAgent}
                    >
                      <BotIcon data-icon="inline-start" />
                      <span className="sm:hidden">Agent</span>
                      <span className="hidden truncate font-mono sm:block">{visibleAgent}</span>
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    title="Open in editor"
                    onClick={() => withResolvedPath(onOpenInEditor)}
                  >
                    <FilePenLineIcon data-icon="inline-start" />
                    <span className="hidden sm:inline">Editor</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    title="Delete task"
                    aria-label="Delete task"
                    onClick={() => {
                      const resolved = resolvePath();
                      if (resolved !== undefined) setDeleteTargetPath(resolved.path);
                    }}
                  >
                    <Trash2Icon data-icon="inline-start" />
                  </Button>
                </>
              )}
            </div>
          </div>
          <FieldGroup className="contents">
            <Field className="contents">
              <FieldLabel htmlFor="task-markdown" className="sr-only">
                Edit {task.title} Markdown
              </FieldLabel>
              <Textarea
                id="task-markdown"
                ref={editorRef}
                value={task.content}
                onChange={(event) =>
                  onChangeContent(event.currentTarget.value, isNew && !pathWasEdited)
                }
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    (event.metaKey || event.ctrlKey) &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    withResolvedPath(onSubmit);
                  }
                }}
                className="min-h-0 flex-1 resize-none rounded-none border-0 px-5 py-4 font-mono text-sm leading-relaxed focus-visible:border-transparent focus-visible:ring-0"
              />
            </Field>
          </FieldGroup>
          <AlertDialog
            open={deleteOpen}
            onOpenChange={(open) => {
              if (!open) setDeleteTargetPath(undefined);
            }}
          >
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
                    setDeleteTargetPath(undefined);
                    withResolvedPath(onDelete);
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

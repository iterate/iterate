import { useEffect, useMemo, useRef, useState } from "react";
import { DragDropProvider, useDraggable, useDroppable } from "@dnd-kit/react";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  CircleIcon,
  FolderIcon,
  PlusIcon,
  SearchIcon,
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
  repoTaskCreationPaths,
  repoTaskPathInDirectory,
  taskDirectoryForFolder,
  taskStateColumns,
  taskStateLabel,
  updateRepoTaskState,
  type RepoTask,
} from "./repo-tasks.ts";
import { effectiveEntry, type FileEntry, type WorkingTreeChanges } from "./staged-changes.ts";
import { useItxQuery } from "~/itx/itx-react.tsx";

type SearchPatch = {
  file?: string;
  diff?: boolean;
  preview?: boolean;
  staged?: boolean;
};

type GroupMode = "state" | "folder";

export function RepoTasksView({
  projectId,
  repoPath,
  headCommitOid,
  headPaths,
  changes,
  selectedPath,
  onPatchSearch,
  onSetWorking,
  onSetStaged,
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
  onSetStaged: (path: string, entry: FileEntry | undefined) => void;
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
      if (entry?.type === "write") contents.set(path, entry.content);
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
    const staged = changes.get(task.path)?.staged;
    const baseline = staged?.type === "write" ? staged.content : headContents[task.path];
    onSetWorking(task.path, content === baseline ? undefined : { type: "write", content });
  };
  const selectTask = (path: string | undefined) =>
    onPatchSearch({ file: path, diff: undefined, preview: undefined, staged: undefined });
  const createTask = (title: string, state: string, folderPath: string) => {
    const created = createRepoTask(title, effectivePaths, taskDirectoryForFolder(folderPath));
    if (created === null) return false;
    const content =
      state === "todo" ? created.content : updateRepoTaskState(created.content, state);
    onSetWorking(created.path, { type: "write", content });
    selectTask(created.path);
    return true;
  };
  const deleteTask = (task: RepoTask) => {
    onSetStaged(task.path, undefined);
    onDelete(task.path);
    selectTask(undefined);
  };
  const moveTaskToFolder = (task: RepoTask, folderPath: string) => {
    const targetPath = repoTaskPathInDirectory(
      task.path,
      taskDirectoryForFolder(folderPath),
      effectivePaths,
    );
    if (targetPath === task.path) return;

    const wasSelected = selectedPath === task.path;
    onSetStaged(task.path, undefined);
    onDelete(task.path);
    onSetStaged(targetPath, undefined);
    onSetWorking(targetPath, { type: "write", content: task.content });
    if (wasSelected) selectTask(targetPath);
  };

  return (
    <div className="flex min-h-0 flex-1">
      <TaskBoard
        tasks={tasks}
        columns={columns}
        onOpen={(task) => selectTask(task.path)}
        onMoveState={(task, state) => writeTask(task, updateRepoTaskState(task.content, state))}
        onMoveFolder={moveTaskToFolder}
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
        onDelete={() => {
          if (selectedTask !== undefined) deleteTask(selectedTask);
        }}
      />
    </div>
  );
}

function TaskBoard({
  tasks,
  columns,
  onOpen,
  onMoveState,
  onMoveFolder,
  onCreate,
}: {
  tasks: readonly RepoTask[];
  columns: readonly string[];
  onOpen: (task: RepoTask) => void;
  onMoveState: (task: RepoTask, state: string) => void;
  onMoveFolder: (task: RepoTask, folderPath: string) => void;
  onCreate: (title: string, state: string, folderPath: string) => boolean;
}) {
  const [groupMode, setGroupMode] = useState<GroupMode>("state");
  const [filter, setFilter] = useState("");
  const draggedPathRef = useRef<string | undefined>(undefined);
  const filteredTasks = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    if (query === "") return tasks;
    return tasks.filter((task) =>
      [task.title, task.description, task.state, task.folderPath, ...task.labels].some((value) =>
        value.toLocaleLowerCase().includes(query),
      ),
    );
  }, [filter, tasks]);
  const folderPaths = useMemo(() => {
    const paths = [...new Set(tasks.map((task) => task.folderPath))];
    if (paths.length === 0) return ["/"];
    return paths.sort((left, right) => {
      if (left === "/") return -1;
      if (right === "/") return 1;
      return left.localeCompare(right);
    });
  }, [tasks]);
  const groups = groupMode === "state" ? columns : folderPaths;

  return (
    <DragDropProvider
      onDragStart={(event) => {
        draggedPathRef.current = String(event.operation.source?.id ?? "");
      }}
      onDragEnd={(event) => {
        const path = String(event.operation.source?.id ?? "");
        if (!event.canceled) {
          const targetId = String(event.operation.target?.id ?? "");
          const task = tasks.find((candidate) => candidate.path === path);
          if (task !== undefined && targetId.startsWith("task-state:")) {
            const state = targetId.slice("task-state:".length);
            if (state !== "" && task.state !== state) onMoveState(task, state);
          } else if (task !== undefined && targetId.startsWith("task-folder:")) {
            const folderPath = targetId.slice("task-folder:".length);
            if (folderPath !== "" && task.folderPath !== folderPath) onMoveFolder(task, folderPath);
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
          <Select
            value={groupMode}
            onValueChange={(value) => {
              if (value === "state" || value === "folder") setGroupMode(value);
            }}
          >
            <SelectTrigger aria-label="Group tasks by" className="w-28 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Group by</SelectLabel>
                <SelectItem value="state">State</SelectItem>
                <SelectItem value="folder">Folder</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:inline">
            {filteredTasks.length} {filteredTasks.length === 1 ? "task" : "tasks"}
          </span>
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 snap-x snap-mandatory gap-2 overflow-x-auto p-2 sm:snap-none">
          {groups.map((group) => (
            <TaskColumn
              key={`${groupMode}:${group}`}
              groupMode={groupMode}
              group={group}
              tasks={filteredTasks.filter((task) =>
                groupMode === "state" ? task.state === group : task.folderPath === group,
              )}
              onOpen={(task) => {
                if (draggedPathRef.current !== task.path) onOpen(task);
              }}
              onCreate={(title) =>
                groupMode === "state" ? onCreate(title, group, "/") : onCreate(title, "todo", group)
              }
            />
          ))}
        </div>
      </div>
    </DragDropProvider>
  );
}

function TaskColumn({
  groupMode,
  group,
  tasks,
  onOpen,
  onCreate,
}: {
  groupMode: GroupMode;
  group: string;
  tasks: readonly RepoTask[];
  onOpen: (task: RepoTask) => void;
  onCreate: (title: string) => boolean;
}) {
  const dropId = `task-${groupMode}:${group}`;
  const { ref, isDropTarget } = useDroppable({ id: dropId, accept: "repo-task" });
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const label = groupMode === "state" ? taskStateLabel(group) : group;
  useEffect(() => {
    if (!creating) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [creating]);

  return (
    <section
      ref={ref}
      data-task-group={dropId}
      className={cn(
        "flex min-h-full min-w-[calc(100vw-1rem)] flex-1 basis-72 snap-start flex-col rounded-lg bg-background/70 transition-colors sm:min-w-72",
        isDropTarget && "bg-accent/40",
      )}
    >
      <header className="flex h-12 shrink-0 items-center justify-between px-3">
        <div className="flex min-w-0 items-center gap-2">
          {groupMode === "state" ? (
            <TaskStateIcon state={group} />
          ) : (
            <FolderIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          )}
          <h2 className="truncate text-sm font-medium">{label}</h2>
          <span className="text-xs tabular-nums text-muted-foreground">{tasks.length}</span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          title={`Add task to ${label}`}
          aria-label={`Add task to ${label}`}
          onClick={() => setCreating(true)}
        >
          <PlusIcon data-icon="inline-start" />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2">
        {creating ? (
          <form
            className="mb-2 rounded-lg border bg-card p-2 shadow-xs"
            onSubmit={(event) => {
              event.preventDefault();
              const title = String(new FormData(event.currentTarget).get("title") ?? "");
              if (onCreate(title)) setCreating(false);
            }}
          >
            <Input
              ref={inputRef}
              aria-label={`New ${label} task title`}
              name="title"
              placeholder="Task title"
              onKeyDown={(event) => {
                if (event.key === "Escape") setCreating(false);
              }}
            />
          </form>
        ) : null}
        <div className="flex flex-col gap-2">
          {tasks.map((task) => (
            <TaskCard key={task.path} task={task} onOpen={onOpen} />
          ))}
        </div>
      </div>
    </section>
  );
}

function TaskCard({ task, onOpen }: { task: RepoTask; onOpen: (task: RepoTask) => void }) {
  const { ref, isDragging } = useDraggable({ id: task.path, type: "repo-task" });
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
      <div className="mb-2 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        <FolderIcon aria-hidden className="size-3 shrink-0" />
        <span className="truncate font-mono">{task.folderPath}</span>
      </div>
      <div className="flex items-start gap-2">
        <TaskStateIcon state={task.state} className="mt-0.5" />
        <span className="min-w-0 flex-1 text-sm font-medium leading-snug">{task.title}</span>
      </div>
      {summary === "" ? null : (
        <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{summary}</p>
      )}
      {task.labels.length === 0 ? null : (
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
  onDelete,
}: {
  task: RepoTask | undefined;
  columns: readonly string[];
  onOpenChange: (open: boolean) => void;
  onChangeContent: (content: string) => void;
  onChangeState: (state: string) => void;
  onDelete: () => void;
}) {
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const taskPath = task?.path;
  useEffect(() => {
    if (taskPath === undefined) return;
    const frame = requestAnimationFrame(() => editorRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [taskPath]);

  return (
    <Sheet open={task !== undefined} onOpenChange={onOpenChange}>
      {task === undefined ? null : (
        <SheetContent
          initialFocus={editorRef}
          className="w-full gap-0 p-0 data-[side=right]:sm:w-[60vw] data-[side=right]:sm:max-w-[60vw]"
        >
          <SheetHeader className="shrink-0 border-b pr-14">
            <SheetTitle>{task.title}</SheetTitle>
            <SheetDescription className="truncate font-mono text-xs">{task.path}</SheetDescription>
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

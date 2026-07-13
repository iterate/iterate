import { useEffect, useMemo, useRef, useState } from "react";
import { DragDropProvider, useDraggable, useDroppable } from "@dnd-kit/react";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  CircleIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
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
  taskStateColumns,
  taskStateLabel,
  updateRepoTaskLabels,
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

export function RepoTasksView({
  projectId,
  repoPath,
  headCommitOid,
  headPaths,
  changes,
  selectedPath,
  onPatchSearch,
  onSetWorking,
}: {
  projectId: string;
  repoPath: string;
  headCommitOid: string;
  headPaths: readonly string[];
  changes: WorkingTreeChanges;
  selectedPath: string | undefined;
  onPatchSearch: (patch: SearchPatch) => void;
  onSetWorking: (path: string, entry: FileEntry | undefined) => void;
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
  const createTask = (title: string, state: string) => {
    const created = createRepoTask(title, effectivePaths);
    if (created === null) return false;
    const content =
      state === "todo" ? created.content : updateRepoTaskState(created.content, state);
    onSetWorking(created.path, { type: "write", content });
    selectTask(created.path);
    return true;
  };

  return (
    <div className="flex min-h-0 flex-1">
      <TaskBoard
        tasks={tasks}
        columns={columns}
        onOpen={(task) => selectTask(task.path)}
        onMove={(task, state) => writeTask(task, updateRepoTaskState(task.content, state))}
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
        onChangeLabels={(labels) => {
          if (selectedTask !== undefined)
            writeTask(selectedTask, updateRepoTaskLabels(selectedTask.content, labels));
        }}
      />
    </div>
  );
}

function TaskBoard({
  tasks,
  columns,
  onOpen,
  onMove,
  onCreate,
}: {
  tasks: readonly RepoTask[];
  columns: readonly string[];
  onOpen: (task: RepoTask) => void;
  onMove: (task: RepoTask, state: string) => void;
  onCreate: (title: string, state: string) => boolean;
}) {
  const draggedPathRef = useRef<string | undefined>(undefined);
  return (
    <DragDropProvider
      onDragStart={(event) => {
        draggedPathRef.current = String(event.operation.source?.id ?? "");
      }}
      onDragEnd={(event) => {
        const path = String(event.operation.source?.id ?? "");
        if (!event.canceled) {
          const targetId = String(event.operation.target?.id ?? "");
          const state = targetId.startsWith("task-state:")
            ? targetId.slice("task-state:".length)
            : "";
          const task = tasks.find((candidate) => candidate.path === path);
          if (task !== undefined && state !== "" && task.state !== state) onMove(task, state);
        }
        setTimeout(() => {
          if (draggedPathRef.current === path) draggedPathRef.current = undefined;
        });
      }}
    >
      <div className="flex min-h-0 min-w-0 flex-1 gap-2 overflow-x-auto bg-muted/30 p-2">
        {columns.map((state) => (
          <TaskColumn
            key={state}
            state={state}
            tasks={tasks.filter((task) => task.state === state)}
            onOpen={(task) => {
              if (draggedPathRef.current !== task.path) onOpen(task);
            }}
            onCreate={onCreate}
          />
        ))}
      </div>
    </DragDropProvider>
  );
}

function TaskColumn({
  state,
  tasks,
  onOpen,
  onCreate,
}: {
  state: string;
  tasks: readonly RepoTask[];
  onOpen: (task: RepoTask) => void;
  onCreate: (title: string, state: string) => boolean;
}) {
  const { ref, isDropTarget } = useDroppable({ id: `task-state:${state}`, accept: "repo-task" });
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!creating) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [creating]);

  return (
    <section
      ref={ref}
      data-task-state={state}
      className={cn(
        "flex min-h-full min-w-72 flex-1 basis-72 flex-col rounded-lg bg-background/70 transition-colors",
        isDropTarget && "bg-accent/40",
      )}
    >
      <header className="flex h-12 shrink-0 items-center justify-between px-3">
        <div className="flex min-w-0 items-center gap-2">
          <TaskStateIcon state={state} />
          <h2 className="truncate text-sm font-medium">{taskStateLabel(state)}</h2>
          <span className="text-xs tabular-nums text-muted-foreground">{tasks.length}</span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          title={`Add task to ${taskStateLabel(state)}`}
          aria-label={`Add task to ${taskStateLabel(state)}`}
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
              if (onCreate(title, state)) setCreating(false);
            }}
          >
            <Input
              ref={inputRef}
              aria-label={`New ${taskStateLabel(state)} task title`}
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
      <div className="flex items-start gap-2">
        <TaskStateIcon state={task.state} className="mt-0.5" />
        <span className="min-w-0 flex-1 text-sm font-medium leading-snug">{task.title}</span>
      </div>
      {summary === "" ? null : (
        <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{summary}</p>
      )}
      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="truncate font-mono text-[10px] text-muted-foreground">
          {task.labels[0]}
        </span>
        {task.explicitLabels.map((label) => (
          <Badge key={label} variant="secondary">
            {label}
          </Badge>
        ))}
      </div>
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
  onChangeLabels,
}: {
  task: RepoTask | undefined;
  columns: readonly string[];
  onOpenChange: (open: boolean) => void;
  onChangeContent: (content: string) => void;
  onChangeState: (state: string) => void;
  onChangeLabels: (labels: string[]) => void;
}) {
  const editorRef = useRef<HTMLTextAreaElement>(null);
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
            <SheetDescription className="font-mono text-xs">{task.path}</SheetDescription>
          </SheetHeader>
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
            <Select value={task.state} onValueChange={(value) => value && onChangeState(value)}>
              <SelectTrigger aria-label="Task state" size="sm" className="w-36">
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
            <Badge variant="outline">{task.labels[0]}</Badge>
            {task.explicitLabels.map((label) => (
              <span key={label} className="flex items-center gap-0.5">
                <Badge variant="secondary">{label}</Badge>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title={`Remove ${label}`}
                  aria-label={`Remove ${label}`}
                  onClick={() =>
                    onChangeLabels(task.explicitLabels.filter((candidate) => candidate !== label))
                  }
                >
                  <XIcon data-icon="inline-start" />
                </Button>
              </span>
            ))}
            <form
              className="ml-auto flex items-center gap-1"
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const label = String(new FormData(form).get("label") ?? "").trim();
                if (label === "") return;
                onChangeLabels([...task.explicitLabels, label]);
                form.reset();
              }}
            >
              <Input
                aria-label="New task label"
                name="label"
                placeholder="Add label"
                className="h-8 w-28"
              />
              <Button type="submit" size="icon-sm" variant="ghost" aria-label="Add label">
                <PlusIcon data-icon="inline-start" />
              </Button>
            </form>
          </div>
          <Textarea
            ref={editorRef}
            aria-label={`Edit ${task.title} Markdown`}
            value={task.content}
            onChange={(event) => onChangeContent(event.currentTarget.value)}
            className="min-h-0 flex-1 resize-none rounded-none border-0 px-5 py-4 font-mono text-sm leading-relaxed focus-visible:border-transparent focus-visible:ring-0"
          />
        </SheetContent>
      )}
    </Sheet>
  );
}

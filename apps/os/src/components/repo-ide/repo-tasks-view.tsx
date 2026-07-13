import { useMemo, useRef } from "react";
import { DragDropProvider, useDraggable, useDroppable } from "@dnd-kit/react";
import { GripVerticalIcon, ListTodoIcon, PlusIcon, XIcon } from "lucide-react";
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

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <TasksSidebar
        taskCount={tasks.length}
        onCreate={(title, reset) => {
          const created = createRepoTask(title, effectivePaths);
          if (created === null) return;
          onSetWorking(created.path, { type: "write", content: created.content });
          reset();
          selectTask(created.path);
        }}
      />
      <TaskBoard
        tasks={tasks}
        columns={columns}
        onOpen={(task) => selectTask(task.path)}
        onMove={(task, state) => writeTask(task, updateRepoTaskState(task.content, state))}
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

function TasksSidebar({
  taskCount,
  onCreate,
}: {
  taskCount: number;
  onCreate: (title: string, reset: () => void) => void;
}) {
  return (
    <aside className="flex shrink-0 items-center gap-3 border-b p-3 md:h-full md:w-60 md:flex-col md:items-stretch md:border-r md:border-b-0">
      <div className="flex items-center gap-2 md:justify-between">
        <div className="flex items-center gap-2">
          <ListTodoIcon className="size-4" />
          <span className="text-sm font-medium">Tasks</span>
        </div>
        <Badge variant="secondary">{taskCount}</Badge>
      </div>
      <form
        className="flex min-w-0 flex-1 gap-2 md:flex-none"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          onCreate(String(new FormData(form).get("title") ?? ""), () => form.reset());
        }}
      >
        <Input
          aria-label="New task title"
          name="title"
          placeholder="New task"
          className="min-w-0"
        />
        <Button type="submit" size="icon" title="Create task" aria-label="Create task">
          <PlusIcon data-icon="inline-start" />
        </Button>
      </form>
    </aside>
  );
}

function TaskBoard({
  tasks,
  columns,
  onOpen,
  onMove,
}: {
  tasks: readonly RepoTask[];
  columns: readonly string[];
  onOpen: (task: RepoTask) => void;
  onMove: (task: RepoTask, state: string) => void;
}) {
  return (
    <DragDropProvider
      onDragEnd={(event) => {
        if (event.canceled) return;
        const path = String(event.operation.source?.id ?? "");
        const targetId = String(event.operation.target?.id ?? "");
        const state = targetId.startsWith("task-state:")
          ? targetId.slice("task-state:".length)
          : "";
        const task = tasks.find((candidate) => candidate.path === path);
        if (task !== undefined && state !== "" && task.state !== state) onMove(task, state);
      }}
    >
      <div className="flex min-h-0 min-w-0 flex-1 overflow-x-auto">
        {columns.map((state) => (
          <TaskColumn
            key={state}
            state={state}
            tasks={tasks.filter((task) => task.state === state)}
            onOpen={onOpen}
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
}: {
  state: string;
  tasks: readonly RepoTask[];
  onOpen: (task: RepoTask) => void;
}) {
  const { ref, isDropTarget } = useDroppable({ id: `task-state:${state}`, accept: "repo-task" });
  return (
    <section
      ref={ref}
      data-task-state={state}
      className={cn(
        "flex min-h-full w-72 shrink-0 flex-col border-r last:border-r-0",
        isDropTarget && "bg-accent/40",
      )}
    >
      <header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
        <h2 className="text-sm font-medium">{taskStateLabel(state)}</h2>
        <span className="text-xs tabular-nums text-muted-foreground">{tasks.length}</span>
      </header>
      <div className="flex flex-1 flex-col">
        {tasks.length === 0 ? (
          <p className="p-4 text-xs text-muted-foreground">Drop tasks here</p>
        ) : (
          tasks.map((task) => <TaskRow key={task.path} task={task} onOpen={onOpen} />)
        )}
      </div>
    </section>
  );
}

function TaskRow({ task, onOpen }: { task: RepoTask; onOpen: (task: RepoTask) => void }) {
  const { ref, handleRef, isDragging } = useDraggable({ id: task.path, type: "repo-task" });
  const summary = task.description.replace(/\s+/g, " ").slice(0, 160);
  return (
    <article
      ref={ref}
      data-task-path={task.path}
      className={cn(
        "group border-b px-3 py-3 transition-colors hover:bg-muted/40",
        isDragging && "opacity-50",
      )}
    >
      <div className="flex items-start gap-1">
        <Button
          ref={handleRef}
          variant="ghost"
          size="icon-xs"
          className="mt-0.5 shrink-0 text-muted-foreground opacity-40 group-hover:opacity-100"
          title={`Drag ${task.title}`}
          aria-label={`Drag ${task.title}`}
        >
          <GripVerticalIcon data-icon="inline-start" />
        </Button>
        <div className="min-w-0 flex-1">
          <button
            type="button"
            className="block w-full text-left text-sm font-medium hover:underline"
            onClick={() => onOpen(task)}
          >
            {task.title}
          </button>
          {summary === "" ? null : (
            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              {summary}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-1">
            {task.labels.map((label, index) => (
              <Badge key={label} variant={index === 0 ? "outline" : "secondary"}>
                {label}
              </Badge>
            ))}
          </div>
        </div>
      </div>
    </article>
  );
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

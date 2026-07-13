import { useMemo } from "react";
import { DragDropProvider, useDraggable, useDroppable } from "@dnd-kit/react";
import { GripVerticalIcon, ListTodoIcon, PlusIcon, XIcon } from "lucide-react";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@iterate-com/ui/components/card";
import { Empty, EmptyHeader, EmptyTitle } from "@iterate-com/ui/components/empty";
import { Field, FieldGroup, FieldLabel } from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@iterate-com/ui/components/resizable";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@iterate-com/ui/components/select";
import { cn } from "@iterate-com/ui/lib/utils";
import { RepoEditorPane } from "./repo-editor-pane.tsx";
import {
  createRepoTask,
  isRepoTaskPath,
  parseRepoTask,
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
  diffOpen,
  previewOpen,
  stagedView,
  onPatchSearch,
  onSetWorking,
  onSetStaged,
  onStage,
  onUnstage,
  onRestore,
}: {
  projectId: string;
  repoPath: string;
  headCommitOid: string;
  headPaths: readonly string[];
  changes: WorkingTreeChanges;
  selectedPath: string | undefined;
  diffOpen: boolean;
  previewOpen: boolean;
  stagedView: boolean;
  onPatchSearch: (patch: SearchPatch) => void;
  onSetWorking: (path: string, entry: FileEntry | undefined) => void;
  onSetStaged: (path: string, entry: FileEntry | undefined) => void;
  onStage: (path: string) => void;
  onUnstage: (path: string) => void;
  onRestore: (path: string) => void;
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
    const paths = new Set(headPaths);
    for (const [path, change] of changes) {
      const entry = effectiveEntry(change);
      if (entry?.type === "delete") paths.delete(path);
      else if (entry !== undefined) paths.add(path);
    }
    return paths;
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
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
      <ResizablePanel defaultSize="20%" minSize="12rem" className="min-w-0">
        <TasksSidebar
          tasks={tasks}
          columns={columns}
          selectedTask={selectedTask}
          onShowBoard={() => selectTask(undefined)}
          onCreate={(title, reset) => {
            const created = createRepoTask(title, effectivePaths);
            if (created === null) return;
            onSetWorking(created.path, { type: "write", content: created.content });
            reset();
            selectTask(created.path);
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
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel className="flex min-w-0 flex-col">
        {selectedTask === undefined ? (
          <TaskBoard
            tasks={tasks}
            columns={columns}
            onOpen={(task) => selectTask(task.path)}
            onMove={(task, state) => writeTask(task, updateRepoTaskState(task.content, state))}
          />
        ) : (
          <RepoEditorPane
            key={selectedTask.path}
            projectId={projectId}
            repoPath={repoPath}
            path={selectedTask.path}
            headCommitOid={headCommitOid}
            headHasPath={headPaths.includes(selectedTask.path)}
            change={changes.get(selectedTask.path)}
            diffOpen={diffOpen}
            onToggleDiff={(open) =>
              onPatchSearch({ diff: open ? true : undefined, preview: undefined })
            }
            previewOpen={previewOpen}
            onTogglePreview={(open) =>
              onPatchSearch({ preview: open ? true : undefined, diff: undefined })
            }
            onSetWorking={(entry) => onSetWorking(selectedTask.path, entry)}
            onSetStaged={(entry) => onSetStaged(selectedTask.path, entry)}
            onStageFile={() => onStage(selectedTask.path)}
            onUnstageFile={() => {
              onUnstage(selectedTask.path);
              onPatchSearch({ staged: undefined });
            }}
            onOpenWorking={() =>
              onPatchSearch({ staged: undefined, diff: undefined, preview: undefined })
            }
            stagedView={stagedView && changes.get(selectedTask.path)?.staged !== undefined}
            onRestore={() => onRestore(selectedTask.path)}
          />
        )}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function TasksSidebar({
  tasks,
  columns,
  selectedTask,
  onShowBoard,
  onCreate,
  onChangeState,
  onChangeLabels,
}: {
  tasks: readonly RepoTask[];
  columns: readonly string[];
  selectedTask: RepoTask | undefined;
  onShowBoard: () => void;
  onCreate: (title: string, reset: () => void) => void;
  onChangeState: (state: string) => void;
  onChangeLabels: (labels: string[]) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b p-3">
        <div className="flex items-center gap-2">
          <ListTodoIcon />
          <span className="text-sm font-medium">Tasks</span>
        </div>
        <Badge variant="secondary">{tasks.length}</Badge>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-3">
        <Button
          variant={selectedTask === undefined ? "secondary" : "ghost"}
          className="w-full justify-start"
          onClick={onShowBoard}
        >
          Board
        </Button>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            onCreate(String(new FormData(form).get("title") ?? ""), () => form.reset());
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="new-task-title">New task</FieldLabel>
              <div className="flex gap-2">
                <Input id="new-task-title" name="title" placeholder="Task title" />
                <Button type="submit" size="icon" title="Create task" aria-label="Create task">
                  <PlusIcon data-icon="inline-start" />
                </Button>
              </div>
            </Field>
          </FieldGroup>
        </form>

        {selectedTask === undefined ? null : (
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="task-state">State</FieldLabel>
              <Select
                value={selectedTask.state}
                onValueChange={(value) => value && onChangeState(value)}
              >
                <SelectTrigger id="task-state" className="w-full">
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
            </Field>
            <Field>
              <FieldLabel>Labels</FieldLabel>
              <div className="flex flex-col gap-2">
                <Badge variant="outline">{selectedTask.labels[0]}</Badge>
                {selectedTask.explicitLabels.map((label) => (
                  <div key={label} className="flex items-center justify-between gap-2">
                    <Badge variant="secondary">{label}</Badge>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      title={`Remove ${label}`}
                      aria-label={`Remove ${label}`}
                      onClick={() =>
                        onChangeLabels(
                          selectedTask.explicitLabels.filter((candidate) => candidate !== label),
                        )
                      }
                    >
                      <XIcon data-icon="inline-start" />
                    </Button>
                  </div>
                ))}
              </div>
            </Field>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const label = String(new FormData(form).get("label") ?? "").trim();
                if (label === "") return;
                onChangeLabels([...selectedTask.explicitLabels, label]);
                form.reset();
              }}
            >
              <Field>
                <FieldLabel htmlFor="new-task-label">Add label</FieldLabel>
                <div className="flex gap-2">
                  <Input id="new-task-label" name="label" placeholder="Label" />
                  <Button type="submit" size="icon" title="Add label" aria-label="Add label">
                    <PlusIcon data-icon="inline-start" />
                  </Button>
                </div>
              </Field>
            </form>
          </FieldGroup>
        )}
      </div>
    </div>
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
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
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
    <Card
      ref={ref}
      data-task-state={state}
      className={cn("min-h-full w-72 shrink-0 self-start", isDropTarget && "ring-2 ring-primary")}
    >
      <CardHeader>
        <CardTitle>{taskStateLabel(state)}</CardTitle>
        <CardAction>
          <Badge variant="secondary">{tasks.length}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {tasks.length === 0 ? (
          <Empty className="min-h-24 border">
            <EmptyHeader>
              <EmptyTitle>No tasks</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          tasks.map((task) => <TaskCard key={task.path} task={task} onOpen={onOpen} />)
        )}
      </CardContent>
    </Card>
  );
}

function TaskCard({ task, onOpen }: { task: RepoTask; onOpen: (task: RepoTask) => void }) {
  const { ref, handleRef, isDragging } = useDraggable({ id: task.path, type: "repo-task" });
  const summary = task.description.replace(/\s+/g, " ").slice(0, 160);
  return (
    <Card ref={ref} size="sm" data-task-path={task.path} className={cn(isDragging && "opacity-50")}>
      <CardHeader>
        <CardTitle>
          <button type="button" className="text-left hover:underline" onClick={() => onOpen(task)}>
            {task.title}
          </button>
        </CardTitle>
        <CardAction>
          <Button
            ref={handleRef}
            variant="ghost"
            size="icon-sm"
            title={`Drag ${task.title}`}
            aria-label={`Drag ${task.title}`}
          >
            <GripVerticalIcon data-icon="inline-start" />
          </Button>
        </CardAction>
        {summary === "" ? null : <CardDescription>{summary}</CardDescription>}
      </CardHeader>
      <CardFooter className="flex-wrap gap-1.5">
        {task.labels.map((label, index) => (
          <Badge key={label} variant={index === 0 ? "outline" : "secondary"}>
            {label}
          </Badge>
        ))}
      </CardFooter>
    </Card>
  );
}

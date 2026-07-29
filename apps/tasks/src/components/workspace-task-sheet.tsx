import { lazy, Suspense, useState } from "react";
import { RotateCcwIcon, Trash2Icon } from "lucide-react";
import { Input } from "@iterate-com/ui/components/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@iterate-com/ui/components/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@iterate-com/ui/components/tabs";
import { Button } from "@iterate-com/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@iterate-com/ui/components/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@iterate-com/ui/components/alert-dialog";
import { stateLabel, type BoardTask } from "../lib/board-model.ts";
import type { TaskChangeStatus } from "../state.ts";
import { projectSlug } from "../lib/project-label.ts";
import { TaskStateIcon } from "./board.tsx";
import { TagPicker } from "./tag-picker.tsx";

// The editor stack (CM6 + collab + merge) loads only when a sheet opens.
const WorkspaceTaskEditor = lazy(() =>
  import("./workspace-task-editor.tsx").then((module) => ({
    default: module.WorkspaceTaskEditor,
  })),
);
const WorkspaceTaskPreview = lazy(() =>
  import("./workspace-task-preview.tsx").then((module) => ({
    default: module.WorkspaceTaskPreview,
  })),
);
const TaskComments = lazy(() =>
  import("./task-comments.tsx").then((module) => ({
    default: module.TaskComments,
  })),
);

/**
 * The task detail sheet on the WORKSPACE lane: the shared collab-editor
 * state machine (rebase model over the vessel WS) with the redline layers
 * where the Yjs sheet had y-collab.
 */
export function WorkspaceTaskSheet({
  task,
  checkoutId,
  repoPath,
  columns,
  allTags,
  changeStatus,
  onRename,
  focusHeadline,
  editorEpoch,
  redline,
  liveSource,
  editorApiRef,
  commentIdentity,
  onApplyTransform,
  onLiveContent,
  onChangeState,
  onChangeLabels,
  onRevert,
  onDelete,
  onClose,
}: {
  task: BoardTask | null;
  checkoutId: string;
  repoPath: string;
  columns: string[];
  allTags: string[];
  changeStatus: TaskChangeStatus | undefined;
  /** Rename the task file; resolves an error message or null on success. */
  onRename: (nextPath: string) => Promise<string | null>;
  focusHeadline?: "select" | "end" | { caret: number };
  /** Bumped when the session was ended server-side (revert) — remounts the
   * editor so it reseeds instead of showing the dead session's text. */
  editorEpoch?: number;
  /** Track changes: the redline layer on the editor (board setting). */
  redline?: boolean;
  /** Live document text when a session is open (Preview must not lag). */
  liveSource?: () => string | null;
  editorApiRef?: { current: import("../lib/collab-editor-api.ts").CollabEditorApi | null };
  /** Who authors discussion comments (null → comments are read-only). */
  commentIdentity: import("./task-comments.tsx").CommentIdentity | null;
  /** Route a whole-file transform to the live editor or the write lane;
   * resolves whether it landed (the write lane can roll back). */
  onApplyTransform: (transform: (source: string) => string) => Promise<boolean>;
  onLiveContent: (path: string, content: string) => void;
  onChangeState: (state: string) => void;
  onChangeLabels: (labels: string[]) => void;
  onRevert: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet open={task !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 data-[side=right]:sm:w-[62vw] data-[side=right]:sm:max-w-[62vw]"
      >
        {task !== null && (
          <SheetBody
            key={task.path}
            task={task}
            checkoutId={checkoutId}
            repoPath={repoPath}
            columns={columns}
            allTags={allTags}
            changeStatus={changeStatus}
            onRename={onRename}
            focusHeadline={focusHeadline}
            editorEpoch={editorEpoch}
            redline={redline}
            liveSource={liveSource}
            editorApiRef={editorApiRef}
            commentIdentity={commentIdentity}
            onApplyTransform={onApplyTransform}
            onLiveContent={onLiveContent}
            onChangeState={onChangeState}
            onChangeLabels={onChangeLabels}
            onRevert={onRevert}
            onDelete={onDelete}
            onRequestClose={onClose}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function SheetBody({
  task,
  checkoutId,
  repoPath,
  columns,
  allTags,
  changeStatus,
  onRename,
  focusHeadline,
  editorEpoch,
  redline,
  liveSource,
  editorApiRef,
  commentIdentity,
  onApplyTransform,
  onLiveContent,
  onChangeState,
  onChangeLabels,
  onRevert,
  onDelete,
  onRequestClose,
}: {
  task: BoardTask;
  checkoutId: string;
  repoPath: string;
  columns: string[];
  allTags: string[];
  changeStatus: TaskChangeStatus | undefined;
  /** Rename the task file; resolves an error message or null on success. */
  onRename: (nextPath: string) => Promise<string | null>;
  focusHeadline?: "select" | "end" | { caret: number };
  /** Bumped when the session was ended server-side (revert) — remounts the
   * editor so it reseeds instead of showing the dead session's text. */
  editorEpoch?: number;
  /** Track changes: the redline layer on the editor (board setting). */
  redline?: boolean;
  /** Live document text when a session is open (Preview must not lag). */
  liveSource?: () => string | null;
  editorApiRef?: { current: import("../lib/collab-editor-api.ts").CollabEditorApi | null };
  /** Who authors discussion comments (null → comments are read-only). */
  commentIdentity: import("./task-comments.tsx").CommentIdentity | null;
  /** Route a whole-file transform to the live editor or the write lane;
   * resolves whether it landed (the write lane can roll back). */
  onApplyTransform: (transform: (source: string) => string) => Promise<boolean>;
  onLiveContent: (path: string, content: string) => void;
  onChangeState: (state: string) => void;
  onChangeLabels: (labels: string[]) => void;
  onRevert: () => void;
  onDelete: () => void;
  /** Cmd/Ctrl+Enter inside the editor: done editing — close the sheet. */
  onRequestClose: () => void;
}) {
  const [status, setStatus] = useState("connecting…");
  // The path is editable in place; SheetBody is keyed by task.path, so a
  // successful rename remounts with the fresh path and clean state.
  const [pathDraft, setPathDraft] = useState(task.path);
  const [pathError, setPathError] = useState<string | null>(null);
  const commitPath = () => {
    if (pathDraft === task.path) {
      setPathError(null);
      return;
    }
    // The REAL outcome: async failures (a failed create) surface here too.
    void onRename(pathDraft).then(setPathError);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SheetHeader className="shrink-0 gap-1 border-b pr-12">
        <SheetTitle className="flex items-center gap-2 text-base">
          <span className="truncate">{task.title}</span>
          {changeStatus === "added" ? (
            <span className="shrink-0 rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-emerald-700 uppercase">
              New
            </span>
          ) : changeStatus === "modified" ? (
            <span className="shrink-0 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-amber-800 uppercase">
              Edited
            </span>
          ) : null}
        </SheetTitle>
        <Input
          value={pathDraft}
          onChange={(event) => setPathDraft(event.target.value)}
          onBlur={commitPath}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitPath();
            }
            if (event.key === "Escape") {
              event.stopPropagation();
              setPathDraft(task.path);
              setPathError(null);
            }
          }}
          aria-invalid={pathError !== null}
          aria-label="Task file path"
          spellCheck={false}
          className={
            "-ml-1 h-6 border-transparent px-1 font-mono text-xs shadow-none " +
            "hover:border-input focus-visible:border-input md:text-xs"
          }
        />
        {pathError !== null && <p className="text-xs text-red-700">{pathError}</p>}
        {task.createdBy !== null && (
          <p className="text-xs text-muted-foreground">
            created by{" "}
            {task.createdBy.startsWith("/") ? (
              // A /-prefixed creator is a STREAM PATH (an agent) — link it.
              <a
                className="font-mono underline underline-offset-2 hover:text-foreground"
                href={`https://os.iterate.com/projects/${projectSlug()}/agents/streams${task.createdBy}`}
                target="_blank"
                rel="noreferrer"
              >
                {task.createdBy}
              </a>
            ) : (
              task.createdBy
            )}
          </p>
        )}
      </SheetHeader>
      <Tabs defaultValue="editor" className="flex min-h-0 flex-1 flex-col gap-0">
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b px-4 py-1.5">
        <Select
          items={columns.map((state) => ({ label: stateLabel(state), value: state }))}
          value={columnState(task, columns)}
          onValueChange={(value) => {
            if (typeof value === "string" && value !== "") onChangeState(value);
          }}
        >
          <SelectTrigger aria-label="Task state" size="sm" className="w-36 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {columns.map((state) => (
              <SelectItem key={state} value={state}>
                <span className="flex items-center gap-2">
                  <TaskStateIcon state={state} />
                  {stateLabel(state)}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <TagPicker value={task.labels} options={allTags} onChange={onChangeLabels} />
        <div className="ml-auto flex items-center gap-1">
          <span className="font-mono text-[11px] text-muted-foreground">{status}</span>
          {changeStatus === undefined ? null : (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              title="Revert to the base commit's version"
              onClick={onRevert}
            >
              <RotateCcwIcon aria-hidden className="size-3.5" />
              Revert
            </Button>
          )}
          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  title="Delete task"
                />
              }
            >
              <Trash2Icon aria-hidden className="size-3.5" />
              Delete
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {task.title}?</AlertDialogTitle>
                <AlertDialogDescription>
                  Removes {task.path} from the workspace. It stays restorable from the Deleted
                  strip until someone commits.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={onDelete}>
                  Delete task
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <TabsList className="ml-1 h-8">
            <TabsTrigger value="editor">Editor</TabsTrigger>
            <TabsTrigger value="preview">Preview</TabsTrigger>
          </TabsList>
        </div>
      </div>
        <TabsContent value="preview" className="flex min-h-0 flex-1 flex-col">
          <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">Rendering…</p>}>
            <WorkspaceTaskPreview source={liveSource?.() ?? task.source} />
          </Suspense>
        </TabsContent>
        <TabsContent value="editor" keepMounted className="flex min-h-0 flex-1 flex-col data-[hidden]:hidden">
      <Suspense
        fallback={<p className="p-4 text-sm text-muted-foreground">Loading editor…</p>}
      >
        <WorkspaceTaskEditor
          key={editorEpoch ?? 0}
          checkoutId={checkoutId}
          repoPath={repoPath}
          path={task.path}
          redline={redline ?? true}
          focusHeadline={focusHeadline}
          apiRef={editorApiRef}
          onLiveContent={onLiveContent}
          onStatus={setStatus}
          onRequestClose={onRequestClose}
        />
      </Suspense>
        </TabsContent>
      </Tabs>
      <div className="flex max-h-[45%] shrink-0 flex-col border-t">
        <Suspense fallback={null}>
          <TaskComments
            source={liveSource?.() ?? task.source}
            identity={commentIdentity}
            // While the editor is attaching, a transform would fall through
            // to the raw write lane — which the arriving session then
            // overwrites with its older snapshot, dropping the comment.
            busy={status === "connecting…"}
            onTransform={onApplyTransform}
          />
        </Suspense>
      </div>
    </div>
  );
}

function columnState(task: BoardTask, columns: string[]): string {
  const literal = task.state.trim();
  if (literal === "" || literal === "backlog") return "todo";
  return columns.includes(literal) ? literal : "todo";
}

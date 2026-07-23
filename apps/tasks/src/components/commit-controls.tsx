import { useEffect, useState } from "react";
import { ChevronDownIcon, GitCommitVerticalIcon, SparklesIcon, Undo2Icon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { Checkbox } from "@iterate-com/ui/components/checkbox";
import { Input } from "@iterate-com/ui/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "@iterate-com/ui/components/popover";
import { cn } from "@iterate-com/ui/lib/utils";
import type { TaskChangeStatus, TaskChangeSummary } from "../state.ts";

const STATUS_LETTER: Record<TaskChangeStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
};
const STATUS_CLASS: Record<TaskChangeStatus, string> = {
  added: "text-emerald-600",
  modified: "text-amber-600",
  deleted: "text-red-600",
};
const STATUS_WORD: Record<TaskChangeStatus, string> = {
  added: "New",
  modified: "Edited",
  deleted: "Deleted",
};

/** The A/M/D letter a changed row wears. */
function ChangeStatusMark({ status }: { status: TaskChangeStatus }) {
  return (
    <span
      title={STATUS_WORD[status]}
      className={cn("flex-none font-mono text-xs font-semibold", STATUS_CLASS[status])}
    >
      {STATUS_LETTER[status]}
    </span>
  );
}

/**
 * The board's git surface, restyled to the apps/os dialect: a Commit button
 * with the autosave countdown beside it and a popover reviewing the pending
 * change set — one row per changed file, a message input (empty
 * auto-generates), the AI message helper, and Discard all.
 */
export function CommitControls({
  taskChanges,
  commitMessage,
  onCommitMessageChange,
  commitPending,
  generatingMessage,
  autoSaveDueAt,
  autoCommit,
  onAutoCommitChange,
  canCommit,
  onMakeCommit,
  onWriteCommitMessage,
  onDiscardAll,
}: {
  taskChanges: readonly TaskChangeSummary[];
  commitMessage: string;
  onCommitMessageChange: (message: string) => void;
  commitPending: boolean;
  generatingMessage: boolean;
  autoSaveDueAt: number | undefined;
  autoCommit: boolean;
  onAutoCommitChange: (value: boolean) => void;
  canCommit: boolean;
  onMakeCommit: () => void;
  onWriteCommitMessage: () => void;
  onDiscardAll: () => void;
}) {
  const dirty = taskChanges.length > 0;
  const busy = commitPending || generatingMessage;
  const [open, setOpen] = useState(false);

  // A successful commit empties the change set (the new base syncs back);
  // the review popover has nothing left to say, so it closes itself.
  useEffect(() => {
    if (!dirty) setOpen(false);
  }, [dirty]);

  return (
    <div className="flex items-center gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button variant={dirty ? "default" : "outline"} size="sm" className="h-8" disabled={!dirty} />
          }
        >
          <GitCommitVerticalIcon aria-hidden className="size-3.5" />
          Commit{dirty ? ` (${taskChanges.length})` : ""}
          {dirty && !commitPending && autoSaveDueAt !== undefined ? (
            <AutoSaveCountdown dueAt={autoSaveDueAt} />
          ) : null}
          <ChevronDownIcon aria-hidden className="size-3" />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-96 p-3">
          <div className="flex flex-col gap-2.5">
            <label htmlFor="auto-commit-toggle" className="flex items-center gap-2 text-xs font-medium">
              <Checkbox
                id="auto-commit-toggle"
                checked={autoCommit}
                onCheckedChange={(checked) => onAutoCommitChange(checked === true)}
              />
              Auto-commit after 60s of quiet
            </label>
            <p className="text-xs text-muted-foreground">
              {taskChanges.length} uncommitted task {taskChanges.length === 1 ? "file" : "files"}.
              An empty message auto-generates one.
            </p>
            <ul className="flex max-h-44 flex-col gap-1 overflow-y-auto rounded-md border bg-muted/30 p-2">
              {taskChanges.map((change) => (
                <li
                  key={change.path}
                  title={change.path}
                  className="flex items-center gap-2 text-xs"
                >
                  <ChangeStatusMark status={change.status} />
                  <span className="min-w-0 flex-1 truncate">{change.title}</span>
                  <span className="flex-none text-muted-foreground">
                    {STATUS_WORD[change.status]}
                  </span>
                </li>
              ))}
            </ul>
            <Input
              value={commitMessage}
              onChange={(event) => onCommitMessageChange(event.target.value)}
              placeholder="Commit message (empty auto-generates)"
              aria-label="Commit message"
              disabled={busy}
              className="h-8 text-xs"
            />
            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || !canCommit}
                onClick={onWriteCommitMessage}
                className="text-muted-foreground"
              >
                <SparklesIcon aria-hidden className="size-3.5" />
                {generatingMessage ? "Writing…" : "Write message"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                className="text-muted-foreground hover:text-destructive"
                onClick={() => {
                  if (window.confirm("Discard all uncommitted task changes?")) onDiscardAll();
                }}
              >
                <Undo2Icon aria-hidden className="size-3.5" />
                Discard all
              </Button>
              <Button
                size="sm"
                className="ml-auto"
                disabled={busy || !canCommit || !dirty}
                onClick={onMakeCommit}
              >
                {commitPending ? "Committing…" : "Commit"}
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * The auto-commit countdown, living INSIDE the Commit button as a quiet
 * suffix. Ticks in its own leaf so the board never re-renders on ticks.
 */
function AutoSaveCountdown({ dueAt }: { dueAt: number }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  const secondsLeft = Math.max(0, Math.ceil((dueAt - nowMs) / 1000));
  return (
    <span className="text-[11px] tabular-nums whitespace-nowrap opacity-70">
      {secondsLeft <= 0 ? "…" : `· ${secondsLeft}s`}
    </span>
  );
}

/**
 * Deleted cards leave the board instantly, so this strip is where a pending
 * deletion stays visible — and reversible — until it is committed.
 */
export function DeletedTasksStrip({
  deletedChanges,
  onRestore,
}: {
  deletedChanges: readonly TaskChangeSummary[];
  onRestore: (path: string) => void;
}) {
  if (deletedChanges.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 border-b bg-background px-3 py-1">
      <span className="text-xs text-muted-foreground">Deleted</span>
      {deletedChanges.map((change) => (
        <span
          key={change.path}
          title={change.path}
          className="inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-1 pl-2.5 text-xs text-muted-foreground"
        >
          <span className="size-1.5 rounded-full bg-red-500" aria-hidden />
          <span className="line-through">{change.title}</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 text-[11px] text-foreground"
            onClick={() => onRestore(change.path)}
            title={`Restore ${change.title}`}
          >
            restore
          </Button>
        </span>
      ))}
    </div>
  );
}

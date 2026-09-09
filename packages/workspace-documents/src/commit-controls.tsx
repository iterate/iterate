import { useEffect, useId, useState } from "react";
import { ChevronDownIcon, GitCommitVerticalIcon, SparklesIcon, Undo2Icon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { Checkbox } from "@iterate-com/ui/components/checkbox";
import { Field, FieldLabel } from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "@iterate-com/ui/components/popover";
import { cn } from "@iterate-com/ui/lib/utils";
import type { RepoFileStatus } from "@iterate-com/ui/components/repo-file-tree";
import type { FileChangeSummary } from "./change-summary.ts";

const STATUS_LETTER: Record<RepoFileStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
};
const STATUS_CLASS: Record<RepoFileStatus, string> = {
  added: "text-emerald-600",
  modified: "text-amber-600",
  deleted: "text-red-600",
};
const STATUS_WORD: Record<RepoFileStatus, string> = {
  added: "New",
  modified: "Edited",
  deleted: "Deleted",
};

/** The A/M/D letter a changed row wears. */
function ChangeStatusMark({ status }: { status: RepoFileStatus }) {
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
 * The commit surface of one change set, in the apps/os dialect: a Commit
 * button with the autosave countdown beside it and a popover reviewing the
 * pending changes — one row per changed file, a message input (empty
 * auto-generates), the message helper, and Discard all.
 */
export function CommitControls({
  taskChanges,
  scope,
  label,
  commitMessage,
  onCommitMessageChange,
  commitPending,
  generatingMessage,
  autoSaveDueAt,
  autoCommit,
  onAutoCommitChange,
  onMakeCommit,
  onWriteCommitMessage,
  onDiscardAll,
}: {
  taskChanges: readonly FileChangeSummary[];
  /** The mount the commit lands on (`/repos/config`), when the host knows it. */
  scope?: string | null;
  /** A short mount name on the button, when several mounts are dirty at once. */
  label?: string | null;
  commitMessage: string;
  onCommitMessageChange: (message: string) => void;
  commitPending: boolean;
  generatingMessage: boolean;
  autoSaveDueAt: number | undefined;
  autoCommit: boolean;
  onAutoCommitChange: (value: boolean) => void;
  onMakeCommit: () => void;
  onWriteCommitMessage: () => void;
  onDiscardAll: () => void;
}) {
  const autoCommitId = useId();
  const dirty = taskChanges.length > 0;
  const busy = commitPending || generatingMessage;
  const commitDisabled = busy || !dirty;
  const [open, setOpen] = useState(false);
  // A successful commit (or discard) empties the change set: the review
  // popover has nothing left to say, so it closes — and STAYS closed until
  // the user opens it again (the state resets, not just the rendering).
  // Adjusted during render, the you-might-not-need-an-effect way.
  const [wasDirty, setWasDirty] = useState(dirty);
  if (dirty !== wasDirty) {
    setWasDirty(dirty);
    if (!dirty) setOpen(false);
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={<Button variant={dirty ? "default" : "outline"} size="sm" className="h-8" />}
        >
          <GitCommitVerticalIcon aria-hidden data-icon="inline-start" />
          Commit{label ? ` ${label}` : ""}
          {dirty ? ` (${taskChanges.length})` : ""}
          {dirty && !commitPending && autoSaveDueAt !== undefined ? (
            <AutoSaveCountdown dueAt={autoSaveDueAt} />
          ) : null}
          <ChevronDownIcon aria-hidden data-icon="inline-start" />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-96 max-w-[calc(100vw-1rem)] p-3">
          <div className="flex flex-col gap-2.5">
            <Field orientation="horizontal">
              <Checkbox
                id={autoCommitId}
                aria-label="Auto-commit after 60s"
                checked={autoCommit}
                onCheckedChange={(checked) => onAutoCommitChange(checked === true)}
              />
              <FieldLabel htmlFor={autoCommitId}>Auto-commit after 60s</FieldLabel>
            </Field>
            <ChangeList taskChanges={taskChanges} scope={scope} />
            <Input
              value={commitMessage}
              onChange={(event) => onCommitMessageChange(event.target.value)}
              placeholder="Commit message (empty auto-generates)"
              aria-label="Commit message"
              disabled={busy}
              className="h-8 text-xs"
            />
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                disabled={commitDisabled}
                onClick={onWriteCommitMessage}
                className="text-muted-foreground"
              >
                <SparklesIcon aria-hidden data-icon="inline-start" />
                {generatingMessage ? "Writing…" : "Write message"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || !dirty}
                className="text-muted-foreground hover:text-destructive"
                onClick={() => {
                  if (window.confirm("Discard all uncommitted changes?")) onDiscardAll();
                }}
              >
                <Undo2Icon aria-hidden data-icon="inline-start" />
                Discard all
              </Button>
              <Button
                size="sm"
                className="ml-auto"
                disabled={commitDisabled}
                onClick={onMakeCommit}
              >
                {commitPending ? "Committing…" : "Commit"}
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}

/** The pending change set under review: a count, where it lands, one row per file. */
function ChangeList({
  taskChanges,
  scope,
}: {
  taskChanges: readonly FileChangeSummary[];
  scope: string | null | undefined;
}) {
  return (
    <>
      <p className="text-xs text-muted-foreground">
        {taskChanges.length} uncommitted {taskChanges.length === 1 ? "file" : "files"}
        {scope ? (
          <>
            , committed to <span className="font-mono">{scope}</span> main
          </>
        ) : null}
        . An empty message auto-generates one.
      </p>
      <ul className="flex max-h-44 flex-col gap-1 overflow-y-auto rounded-md border bg-muted/30 p-2">
        {taskChanges.map((change) => (
          <li key={change.path} title={change.path} className="flex items-center gap-2 text-xs">
            <ChangeStatusMark status={change.status} />
            <span className="min-w-0 flex-1 truncate">{change.title}</span>
            <span className="flex-none text-muted-foreground">{STATUS_WORD[change.status]}</span>
          </li>
        ))}
      </ul>
    </>
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

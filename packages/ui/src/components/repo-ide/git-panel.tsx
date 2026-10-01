import { useState, type ReactNode } from "react";
import { GitCommitVerticalIcon, MinusIcon, PlusIcon, Undo2Icon } from "lucide-react";
import { commitPlan, type FileEntry, type WorkingTreeChanges } from "./staged-changes.ts";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";

type ChangeStatus = "added" | "deleted" | "modified";

const STATUS_LETTERS: Record<ChangeStatus, { letter: string; className: string }> = {
  added: { letter: "A", className: "text-green-600" },
  deleted: { letter: "D", className: "text-red-600" },
  modified: { letter: "M", className: "text-blue-600" },
};

/** What the Source Control sidebar does: the IDE owns the working tree. */
export interface GitPanelActions {
  commit: (message: string, onCommitted: () => void) => void;
  stage: (path: string) => void;
  unstage: (path: string) => void;
  discard: (path: string) => void;
  discardAll: () => void;
  open: (path: string, status: ChangeStatus) => void;
  openStaged: (path: string) => void;
}

/** The Source Control sidebar: commit box on top, then Staged Changes and Changes (vscode's shape,
 *  a file appearing in both when it was edited again after staging). Commit takes the staged
 *  snapshots when anything is staged, otherwise everything. */
export function GitPanel({
  changes,
  headPathSet,
  commitPending,
  actions,
}: {
  changes: WorkingTreeChanges;
  headPathSet: ReadonlySet<string>;
  commitPending: boolean;
  actions: GitPanelActions;
}) {
  const staged = [...changes].flatMap(([path, change]) =>
    change.staged ? [{ path, entry: change.staged }] : [],
  );
  const working = [...changes].flatMap(([path, change]) =>
    change.working ? [{ path, entry: change.working }] : [],
  );
  const statusOf = (path: string, entry: FileEntry): ChangeStatus => {
    if (entry.type === "delete") return "deleted";
    return headPathSet.has(path) ? "modified" : "added";
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <CommitForm changes={changes} pending={commitPending} onCommit={actions.commit} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2">
        {staged.length > 0 ? (
          <>
            <SectionHeader
              title="Staged Changes"
              buttons={
                <IconButton
                  title="Unstage all"
                  onClick={() => staged.forEach(({ path }) => actions.unstage(path))}
                >
                  <MinusIcon className="size-3" />
                </IconButton>
              }
            />
            <div className="flex flex-col gap-0.5 px-1.5">
              {staged.map(({ path, entry }) => (
                <ChangeRow
                  key={path}
                  path={path}
                  status={statusOf(path, entry)}
                  onOpen={() => actions.openStaged(path)}
                  buttons={
                    <IconButton title="Unstage change" onClick={() => actions.unstage(path)}>
                      <MinusIcon className="size-3" />
                    </IconButton>
                  }
                />
              ))}
            </div>
          </>
        ) : null}
        <SectionHeader
          title="Changes"
          buttons={
            working.length > 0 ? (
              <>
                <IconButton title="Discard all changes" onClick={actions.discardAll}>
                  <Undo2Icon className="size-3" />
                </IconButton>
                <IconButton
                  title="Stage all changes"
                  onClick={() => working.forEach(({ path }) => actions.stage(path))}
                >
                  <PlusIcon className="size-3" />
                </IconButton>
              </>
            ) : null
          }
        />
        <div className="flex flex-col gap-0.5 px-1.5">
          {working.length === 0 ? (
            <span className="px-1.5 py-2 text-xs text-muted-foreground">No changes.</span>
          ) : (
            working.map(({ path, entry }) => {
              const status = statusOf(path, entry);
              return (
                <ChangeRow
                  key={path}
                  path={path}
                  status={status}
                  onOpen={() => actions.open(path, status)}
                  buttons={
                    <>
                      <IconButton title="Discard changes" onClick={() => actions.discard(path)}>
                        <Undo2Icon className="size-3" />
                      </IconButton>
                      <IconButton title="Stage change" onClick={() => actions.stage(path)}>
                        <PlusIcon className="size-3" />
                      </IconButton>
                    </>
                  }
                />
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

/** The message box and Commit button. A form action, so submitting needs no handler of its own. */
function CommitForm({
  changes,
  pending,
  onCommit,
}: {
  changes: WorkingTreeChanges;
  pending: boolean;
  onCommit: (message: string, onCommitted: () => void) => void;
}) {
  const [message, setMessage] = useState("");
  const plan = commitPlan(changes);
  const disabled = changes.size === 0 || pending;
  let label = `Commit ${plan.paths.length || ""}`;
  if (pending) label = "Committing…";
  else if (plan.mode === "staged") label = `Commit ${plan.paths.length} staged`;
  return (
    <form
      className="flex shrink-0 flex-col gap-2 border-b p-2"
      action={() => {
        if (message.trim() && !disabled) onCommit(message.trim(), () => setMessage(""));
      }}
    >
      <Input
        name="message"
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        placeholder="Commit message"
        className="h-8 text-xs"
        disabled={disabled}
      />
      <Button type="submit" size="sm" disabled={disabled} className="text-xs">
        <GitCommitVerticalIcon className="size-3.5" />
        {label}
      </Button>
    </form>
  );
}

function SectionHeader({ title, buttons }: { title: string; buttons: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-3 pt-2 pb-1">
      <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </span>
      <span className="flex items-center gap-0.5">{buttons}</span>
    </div>
  );
}

function ChangeRow({
  path,
  status,
  buttons,
  onOpen,
}: {
  path: string;
  status: ChangeStatus;
  buttons: ReactNode;
  onOpen: () => void;
}) {
  const { letter, className } = STATUS_LETTERS[status];
  return (
    <div className="group flex items-center gap-1.5 rounded-sm px-1.5 py-1 hover:bg-accent">
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-left font-mono text-xs"
        title={path}
        onClick={onOpen}
      >
        {path}
      </button>
      <span className="invisible flex items-center gap-0.5 group-hover:visible">{buttons}</span>
      <span className={`font-mono text-xs font-semibold ${className}`}>{letter}</span>
    </div>
  );
}

function IconButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      title={title}
      onClick={onClick}
      // size-5, not icon-sm's size-7: the buttons must fit inside the row's natural height, or
      // hovering makes every row jump taller
      className="size-5 text-muted-foreground"
    >
      {children}
    </Button>
  );
}

import { useCallback, useMemo, useState } from "react";
import { fallbackCommitMessage, type FileChangeSummary } from "./change-summary.ts";
import { CommitControls } from "./commit-controls.tsx";
import { useCommit } from "./use-commit.ts";
import type { WorkspaceMountChanges, useWorkspaceFiles } from "./workspace-files.ts";

/**
 * One Commit control per dirty mount of a workspace — a commit never spans
 * mounts, and every project repo is one. Read-only mounts and the
 * workspace's own directory show their changes in the tree but get no
 * control here. Renders nothing when the host withholds committing (a guest
 * view on someone else's workspace) or nothing is dirty.
 */
export function WorkspaceChanges({
  files,
  canCommit,
  onDiscarded,
}: {
  files: ReturnType<typeof useWorkspaceFiles>;
  /** Publishing is the workspace owner's act; false withholds every control. */
  canCommit: boolean;
  /** Every change under one mount was reverted (null: the own directory). */
  onDiscarded: (scope: string | null) => void;
}) {
  const committable = canCommit
    ? files.mounts.filter((mount) => mount.scope !== null && mount.policy === "commit-to-main")
    : [];
  if (committable.length === 0) return null;
  return (
    <>
      {committable.map((mount) => (
        <MountCommit
          key={mount.scope}
          mount={mount}
          label={committable.length > 1 ? (mount.scope!.split("/").at(-1) ?? mount.scope!) : null}
          onCommit={(message) => files.commit({ message, scope: mount.scope! })}
          onDiscardAll={() =>
            void files.discardAll(mount.scope).then((ok) => {
              if (ok) onDiscarded(mount.scope);
            })
          }
        />
      ))}
    </>
  );
}

/** One mount's commit control, with its own draft message and auto-commit timer. */
function MountCommit({
  mount,
  label,
  onCommit,
  onDiscardAll,
}: {
  mount: WorkspaceMountChanges;
  /** The mount's short name when several mounts are dirty; null when it is the only one. */
  label: string | null;
  onCommit: (message: string) => Promise<boolean>;
  onDiscardAll: () => void;
}) {
  const changes = useMemo<FileChangeSummary[]>(
    () =>
      mount.changes.map((change) => ({
        path: change.path,
        status: change.status,
        title: change.path.split("/").at(-1) ?? change.path,
      })),
    [mount.changes],
  );
  const [autoCommit, setAutoCommit] = useState(true);
  const [commitPending, setCommitPending] = useState(false);
  const commitMount = useCallback(
    async (message: string | undefined) => {
      setCommitPending(true);
      try {
        const ok = await onCommit(message ?? fallbackCommitMessage(changes));
        if (!ok) throw new Error("commit failed");
      } finally {
        setCommitPending(false);
      }
    },
    [onCommit, changes],
  );
  const commit = useCommit({
    api: { generateCommitMessage: async (input) => fallbackCommitMessage(input.changes) },
    changes,
    changeSignature: changes.map((change) => `${change.path}:${change.status}`).join("\n"),
    enabled: autoCommit,
    onCommit: commitMount,
  });
  return (
    <CommitControls
      taskChanges={changes}
      scope={mount.scope}
      label={label}
      commitMessage={commit.commitMessage}
      onCommitMessageChange={commit.setCommitMessage}
      commitPending={commitPending}
      generatingMessage={commit.generatingMessage}
      autoSaveDueAt={commit.autoSaveDueAt}
      autoCommit={autoCommit}
      onAutoCommitChange={setAutoCommit}
      canCommit={true}
      onMakeCommit={commit.makeCommit}
      onWriteCommitMessage={commit.writeCommitMessage}
      onDiscardAll={onDiscardAll}
    />
  );
}

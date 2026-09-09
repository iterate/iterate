import { useCallback, useMemo, useState } from "react";
import { ButtonGroup } from "@iterate-com/ui/components/button-group";
import type { TaskChangeSummary } from "../state.ts";
import { fallbackCommitMessage } from "../tasks-model.ts";
import { isGuestWorkspacePath } from "../lib/board-shared.ts";
import { isJamWorkspacePath } from "../lib/jam.ts";
import { useTaskCommit } from "../lib/use-task-commit.ts";
import type { WorkspaceMountChanges, useWorkspaceFiles } from "../lib/use-workspace-files.ts";
import { CommitControls } from "./commit-controls.tsx";
import { InviteAgentButton } from "./invite-agent-button.tsx";

/**
 * The header's workspace actions: one Commit control per dirty mount (a
 * commit never spans mounts, and every project repo is one), and Invite AI
 * on a jam. Publishing is the workspace OWNER's act: on someone else's
 * workspace — an agent's, mid-thought — the whole commit surface is
 * withheld, discard-all and the auto-commit timers included.
 */
export function WorkspaceActions({
  files,
  workspacePath,
  selectedPath,
  onDiscarded,
}: {
  files: ReturnType<typeof useWorkspaceFiles>;
  workspacePath: string;
  selectedPath: string | undefined;
  /** Every change under one mount was reverted (null: the own directory). */
  onDiscarded: (scope: string | null) => void;
}) {
  const guest = isGuestWorkspacePath(workspacePath);
  const jam = isJamWorkspacePath(workspacePath);
  const committable = guest
    ? []
    : files.mounts.filter((mount) => mount.scope !== null && mount.policy === "commit-to-main");
  if (committable.length === 0 && !jam) return null;
  return (
    <ButtonGroup aria-label="Workspace actions">
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
      {jam ? (
        <InviteAgentButton key={workspacePath} workspacePath={workspacePath} path={selectedPath} />
      ) : null}
    </ButtonGroup>
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
  const taskChanges = useMemo<TaskChangeSummary[]>(
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
        const ok = await onCommit(message ?? fallbackCommitMessage(taskChanges, "files"));
        if (!ok) throw new Error("commit failed");
      } finally {
        setCommitPending(false);
      }
    },
    [onCommit, taskChanges],
  );
  const commit = useTaskCommit({
    api: { generateCommitMessage: async ({ changes }) => fallbackCommitMessage(changes, "files") },
    taskChanges,
    taskChangeSignature: taskChanges.map((change) => `${change.path}:${change.status}`).join("\n"),
    enabled: autoCommit,
    onCommit: commitMount,
  });
  return (
    <CommitControls
      taskChanges={taskChanges}
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

import { useCallback, useMemo, useState } from "react";
import type { TaskChangeSummary } from "../state.ts";
import { fallbackCommitMessage } from "../tasks-model.ts";
import { isGuestWorkspacePath } from "./board-shared.ts";
import type { useWorkspaceFiles } from "./use-workspace-files.ts";
import { useTaskCommit } from "./use-task-commit.ts";

/** Keep the workspace commit timer and draft alive while switching documents. */
export function useWorkspaceCommit({
  files,
  workspacePath,
  repoPath,
}: {
  files: ReturnType<typeof useWorkspaceFiles>;
  workspacePath: string;
  repoPath: string;
}) {
  const taskChanges = useMemo<TaskChangeSummary[]>(
    () =>
      [...files.changes]
        .map(([path, status]) => ({ path, status, title: path.split("/").at(-1) ?? path }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    [files.changes],
  );
  // Publishing is the workspace OWNER's act (the board's rule): on someone
  // else's workspace — an agent's, mid-thought — the whole commit surface is
  // withheld, discard-all and the auto-commit timer included.
  const guest = isGuestWorkspacePath(workspacePath, repoPath);
  const [autoCommit, setAutoCommit] = useState(true);
  const [commitPending, setCommitPending] = useState(false);
  const commitFiles = files.commit;
  const onCommit = useCallback(
    async (message: string | undefined) => {
      setCommitPending(true);
      try {
        const ok = await commitFiles(message ?? fallbackCommitMessage(taskChanges, "files"));
        if (!ok) throw new Error("commit failed");
      } finally {
        setCommitPending(false);
      }
    },
    [commitFiles, taskChanges],
  );
  const commit = useTaskCommit({
    api: { generateCommitMessage: async ({ changes }) => fallbackCommitMessage(changes, "files") },
    taskChanges,
    taskChangeSignature: taskChanges.map((change) => `${change.path}:${change.status}`).join("\n"),
    enabled: autoCommit && !guest,
    onCommit,
  });

  return {
    taskChanges,
    commitMessage: commit.commitMessage,
    onCommitMessageChange: commit.setCommitMessage,
    commitPending,
    generatingMessage: commit.generatingMessage,
    autoSaveDueAt: commit.autoSaveDueAt,
    autoCommit,
    onAutoCommitChange: setAutoCommit,
    canCommit: !guest,
    onMakeCommit: commit.makeCommit,
    onWriteCommitMessage: commit.writeCommitMessage,
  };
}

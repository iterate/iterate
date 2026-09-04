import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import type { RepoTreeActions } from "@iterate-com/ui/components/repo-file-tree";
import type { TaskChangeSummary } from "../state.ts";
import { isGuestWorkspacePath } from "../lib/board-shared.ts";
import { isJamWorkspacePath, withDocumentExtension } from "../lib/jam.ts";
import { useTaskCommit } from "../lib/use-task-commit.ts";
import { useWorkspaceFiles } from "../lib/use-workspace-files.ts";
import { fallbackCommitMessage } from "../tasks-model.ts";
import { CommitControls } from "./commit-controls.tsx";
import { InviteAgentButton } from "./invite-agent-button.tsx";

// The tree is a web component (shadow DOM): browser-only, so it stays out
// of the SSR pass and the shell bundle.
const RepoFileTree = lazy(async () => {
  const module = await import("@iterate-com/ui/components/repo-file-tree");
  return { default: module.RepoFileTree };
});

/**
 * The file column beside a document: the shared repo tree over the
 * workspace's config-repo documents (git-status badges, new/rename/delete/
 * discard), the board's commit controls publishing the mount's dirty set,
 * and — in a jam — the Invite AI button. Paths cross this component
 * repo-relative; the route speaks fully qualified ones.
 */
export function WorkspaceFilesPane({
  workspacePath,
  repoPath,
  selectedPath,
  onSelect,
  onDocumentRevised,
  className,
}: {
  workspacePath: string;
  /** The /repos/** mount the tree shows. */
  repoPath: string;
  /** The open document's fully qualified path, if any. */
  selectedPath: string | undefined;
  /** A fully qualified document path to open, or null to close the open one. */
  onSelect: (path: string | null) => void;
  /** The open document's content was replaced under the editor (a discard):
   * its collab session ended, the route must remount it. */
  onDocumentRevised: () => void;
  className?: string;
}) {
  const files = useWorkspaceFiles({ workspacePath, repoPath });
  const prefix = `${repoPath}/`;
  const selected =
    selectedPath !== undefined && selectedPath.startsWith(prefix)
      ? selectedPath.slice(prefix.length)
      : undefined;
  const select = useCallback(
    (path: string | undefined) => onSelect(path === undefined ? null : `${prefix}${path}`),
    [onSelect, prefix],
  );

  const actions: RepoTreeActions = {
    createFile: (path) => {
      const named = withDocumentExtension(path);
      void files.createFile(named).then((ok) => {
        if (ok) select(named);
      });
      return named;
    },
    rename: (from, to, isFolder) => {
      const target = isFolder ? to : withDocumentExtension(to);
      void files.rename(from, target, isFolder).then((ok) => {
        if (ok && selected === from) select(target);
      });
    },
    remove: (path, isFolder) => {
      void files.remove(path, isFolder).then((ok) => {
        const gone = selected === path || (isFolder && selected?.startsWith(`${path}/`) === true);
        if (ok && gone) select(undefined);
      });
    },
    discard: (path) => {
      // Discarding an addition removes the file; discarding anything else
      // puts HEAD's content back under the editor.
      const wasAddition = files.changes.get(path) === "added";
      void files.discard(path).then((ok) => {
        if (!ok || selected !== path) return;
        if (wasAddition) select(undefined);
        else onDocumentRevised();
      });
    },
  };

  const taskChanges = useMemo<TaskChangeSummary[]>(
    () =>
      [...files.changes]
        .map(([path, status]) => ({ path, status, title: path.split("/").at(-1) ?? path }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    [files.changes],
  );
  const [autoCommit, setAutoCommit] = useState(false);
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
    api: null,
    taskChanges,
    taskChangeSignature: taskChanges.map((change) => `${change.path}:${change.status}`).join("\n"),
    enabled: autoCommit,
    onCommit,
  });

  return (
    <div className={className}>
      <Suspense fallback={<div className="h-11 border-b" />}>
        <RepoFileTree
          className="min-h-0 flex-1"
          header={
            <span
              className="block truncate font-mono text-xs text-muted-foreground"
              title={repoPath}
            >
              {repoPath}
            </span>
          }
          headPaths={files.headPaths ?? []}
          changes={files.changes}
          selectedPath={selected}
          onSelect={select}
          actions={actions}
          untitledExtension="md"
        />
      </Suspense>
      {files.error === null ? null : (
        <p className="shrink-0 border-t px-3 py-2 text-xs text-red-700">{files.error}</p>
      )}
      <div className="flex shrink-0 items-center justify-between gap-2 border-t p-2">
        <CommitControls
          taskChanges={taskChanges}
          commitMessage={commit.commitMessage}
          onCommitMessageChange={commit.setCommitMessage}
          commitPending={commitPending}
          generatingMessage={commit.generatingMessage}
          autoSaveDueAt={commit.autoSaveDueAt}
          autoCommit={autoCommit}
          onAutoCommitChange={setAutoCommit}
          canCommit={!isGuestWorkspacePath(workspacePath, repoPath)}
          onMakeCommit={commit.makeCommit}
          onWriteCommitMessage={commit.writeCommitMessage}
          onDiscardAll={() => void files.discardAll()}
        />
        {isJamWorkspacePath(workspacePath) ? (
          <InviteAgentButton workspacePath={workspacePath} path={selectedPath} />
        ) : null}
      </div>
    </div>
  );
}

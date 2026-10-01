// What the repo IDE does to its working tree and its repo: the tree's new, rename, delete and
// discard, and the commit. The working tree is the in-browser store (staged-changes.ts); only a
// commit reaches the repo.
import { useState } from "react";
import { toast } from "sonner";
import { discardRepoFile } from "./repo-file-discard.ts";
import { repoFileKind } from "./repo-file-kinds.ts";
import type { RepoTreeActions } from "./repo-file-tree.tsx";
import type { RepoIdeSearch } from "./repo-ide-search.ts";
import { readRepoFile, type RepoFiles, type RepoProject } from "./repo-client.ts";
import {
  commitPlan,
  effectiveEntry,
  workingTreeStore,
  type FileEntry,
  type WorkingTreeChanges,
} from "./staged-changes.ts";

export function useRepoIdeActions({
  project,
  projectId,
  repoPath,
  author,
  files,
  reload,
  store,
  changes,
  selectedPath,
  onSearchChange,
}: {
  project: RepoProject;
  projectId: string;
  repoPath: string;
  author: { name: string; email: string } | undefined;
  files: RepoFiles;
  reload: () => Promise<void>;
  store: ReturnType<typeof workingTreeStore>;
  changes: WorkingTreeChanges;
  selectedPath: string | undefined;
  onSearchChange: (patch: Partial<RepoIdeSearch>) => void;
}) {
  const [committing, setCommitting] = useState(false);
  const headPaths = files.paths;
  const headPathSet = new Set(headPaths);

  const selectFile = (path: string | undefined) =>
    onSearchChange({ file: path, diff: undefined, preview: undefined, staged: undefined });

  /** The current content of a path: the live edit, the staged snapshot, or HEAD's. Rename fuel. */
  const resolveEntry = async (path: string): Promise<FileEntry> => {
    const current = effectiveEntry(changes.get(path) ?? {});
    if (current && current.type !== "delete") return current;
    if (repoFileKind(path).kind !== "text") throw new Error(`"${path}" is not a text file.`);
    const content = await readRepoFile(project, repoPath, path, files.commitOid || undefined);
    // oxlint-disable-next-line iterate/simple-truthiness-check -- undefined is no such file, "" an empty one
    if (content === undefined) throw new Error(`Repo file does not exist: "${path}".`);
    return { type: "write", content };
  };

  const dropChange = (path: string) => {
    store.setWorking(path, undefined);
    store.setStaged(path, undefined);
  };

  const discardPath = (path: string) =>
    discardRepoFile({
      path,
      headHasPath: headPathSet.has(path),
      selected: selectedPath === path,
      confirmDiscard: (message) => window.confirm(message),
      discardWorking: (trackedPath) => store.discardWorking(trackedPath),
      removeWorkingFile: dropChange,
      closeSelectedFile: () => selectFile(undefined),
    });

  const removePath = (path: string) => {
    // deleting a file never committed drops its change; deleting one at HEAD stages the deletion
    if (headPathSet.has(path)) store.setWorking(path, { type: "delete" });
    else {
      dropChange(path);
      if (selectedPath === path) selectFile(undefined);
    }
  };

  const pathsUnder = (directoryPath: string) => {
    const prefix = `${directoryPath}/`;
    const affected = new Set<string>();
    for (const path of headPaths) if (path.startsWith(prefix)) affected.add(path);
    for (const [path, change] of changes) {
      if (effectiveEntry(change)?.type !== "delete" && path.startsWith(prefix)) affected.add(path);
    }
    return [...affected];
  };

  const rename = async (fromPath: string, toPath: string, isFolder: boolean) => {
    const moves = isFolder
      ? pathsUnder(fromPath).map((path) => ({
          from: path,
          to: `${toPath}${path.slice(fromPath.length)}`,
        }))
      : [{ from: fromPath, to: toPath }];
    try {
      // every source is resolved before anything is staged, so a failed read leaves the working
      // tree untouched (the tree row already moved; the next path sync heals it)
      const resolved = await Promise.all(
        moves.map(async (move) => ({ ...move, entry: await resolveEntry(move.from) })),
      );
      for (const move of resolved) {
        store.setWorking(move.to, move.entry);
        removePath(move.from);
      }
      // the selection follows the rename, a file open inside a renamed folder included
      if (selectedPath === fromPath) selectFile(toPath);
      else if (isFolder && selectedPath?.startsWith(`${fromPath}/`))
        selectFile(`${toPath}${selectedPath.slice(fromPath.length)}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not rename.");
    }
  };

  const treeActions: RepoTreeActions = {
    createFile: (path) => {
      store.setWorking(path, { type: "write", content: "" });
      selectFile(path);
    },
    discard: discardPath,
    remove: (path, isFolder) => {
      for (const affected of isFolder ? pathsUnder(path) : [path]) removePath(affected);
    },
    rename: (fromPath, toPath, isFolder) => void rename(fromPath, toPath, isFolder),
  };

  const commit = async (message: string, onCommitted: () => void) => {
    setCommitting(true);
    try {
      const plan = commitPlan(changes);
      using repo = project.repos.get(repoPath);
      const result = await repo.commitFiles({
        message,
        changes: plan.fileChanges,
        parent: files.commitOid,
        author,
      });
      // only what was sent goes: an edit or a file made while the commit was in flight stays
      store.clearCommitted(plan.entries);
      // HEAD moved: the working edits that survive belong under the new oid's key. Migrated only
      // after the file list is read again — until then the IDE still reads and writes the old
      // oid's store, and an earlier migration would blank the working tree it shows.
      await reload();
      store.migrateTo(
        workingTreeStore({ projectId, repoPath, commitOid: result.commitOid || "unborn" }),
      );
      onCommitted();
      toast.success(
        result.changedPaths.length === 0
          ? "No changes to commit."
          : `Committed ${result.changedPaths.length} file(s) (${result.commitOid?.slice(0, 7)}).`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not commit.");
    } finally {
      setCommitting(false);
    }
  };

  return { treeActions, committing, commit, discardPath, dropChange, selectFile, headPathSet };
}

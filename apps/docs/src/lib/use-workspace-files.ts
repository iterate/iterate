import { useCallback, useEffect, useRef, useState } from "react";
import type { RepoFileStatus } from "@iterate-com/ui/components/repo-file-tree";
import { withDocsProject } from "./docs-client.ts";
import { isDocumentPath } from "./jam.ts";
import { workspaceFor } from "./project-rpc.ts";
import type { TasksWorkspace } from "./tasks-api.ts";
import { changeMap } from "./use-workspace-board.ts";

/** Files an agent adds or edits show up on this cadence; own edits refresh at once. */
const POLL_MS = 5_000;

/**
 * The Docs app's working tree over ONE repo mount of a workspace: the same
 * git-shaped picture the apps/os repo IDE draws from its in-browser store,
 * except the store here is the workspace overlay itself — shared with every
 * collaborator and agent, settled by the platform. HEAD is the merged listing
 * minus additions plus deletions; `git.status()` is the change map; every
 * mutation is the same workspace write an agent makes, and commit publishes
 * the mount's dirty set to the repo's main. Paths are repo-relative
 * throughout (the tree's shape); documents only (markdown and HTML).
 */
export function useWorkspaceFiles({
  workspacePath,
  repoPath,
}: {
  workspacePath: string;
  repoPath: string;
}) {
  const [headPaths, setHeadPaths] = useState<string[] | null>(null);
  const [changes, setChanges] = useState<ReadonlyMap<string, RepoFileStatus>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const lane = useCallback(
    <T>(operation: (ws: TasksWorkspace) => Promise<T>) =>
      withDocsProject((project) =>
        operation(workspaceFor(project, { boardId: null, workspacePath, repoPath })),
      ),
    [workspacePath, repoPath],
  );

  // Newest refresh wins: a poll that started before a create/rename/delete/
  // discard/commit must not land after the post-mutation refresh and hide
  // the user's own change until the next tick.
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    let documents: string[];
    let status: unknown;
    try {
      [documents, status] = await Promise.all([
        withDocsProject((project) => project.documentsUnder(workspacePath, repoPath)),
        lane((ws) => ws.status()),
      ]);
    } catch (cause) {
      // A superseded refresh's failure is as stale as its data would have been.
      if (generation.current !== mine) return;
      throw cause;
    }
    if (generation.current !== mine) return;
    const next = changeMap(status, repoPath, isDocumentPath);
    // The listing is the MERGED view (overlay over HEAD); HEAD itself is
    // that minus what the overlay added, plus what it deleted.
    const head = new Set(documents.map((path) => path.slice(repoPath.length + 1)));
    for (const [path, status] of next) {
      if (status === "added") head.delete(path);
      if (status === "deleted") head.add(path);
    }
    setHeadPaths([...head].sort());
    setChanges(next);
    setError(null);
  }, [lane, workspacePath, repoPath]);

  useEffect(() => {
    let cancelled = false;
    const tick = () =>
      void refresh().catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refresh]);

  /** One mutation then a refresh; false (and the error shown) when it failed. */
  const run = useCallback(
    async (work: () => Promise<unknown>): Promise<boolean> => {
      try {
        await work();
        await refresh();
        return true;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        void refresh().catch(() => {});
        return false;
      }
    },
    [refresh],
  );

  const pathsUnder = (directoryPath: string) => {
    const prefix = `${directoryPath}/`;
    const affected = new Set<string>();
    for (const path of headPaths ?? []) if (path.startsWith(prefix)) affected.add(path);
    for (const [path, status] of changes) {
      if (status !== "deleted" && path.startsWith(prefix)) affected.add(path);
    }
    return [...affected];
  };

  return {
    headPaths,
    changes,
    error,
    refresh,
    createFile: (path: string) => run(() => lane((ws) => ws.write(path, ""))),
    rename: (from: string, to: string, isFolder: boolean) =>
      run(async () => {
        if (isFolder) throw new Error("Renaming folders is not supported yet.");
        const content = await lane((ws) => ws.read(from));
        await lane((ws) => ws.write(to, content ?? ""));
        await lane((ws) => ws.delete(from));
      }),
    remove: (path: string, isFolder: boolean) =>
      run(() =>
        Promise.all(
          (isFolder ? pathsUnder(path) : [path]).map((victim) => lane((ws) => ws.delete(victim))),
        ),
      ),
    /** Back to the mount's version: restore a delete, drop an add, undo edits. */
    discard: (path: string) => run(() => lane((ws) => ws.revert(path))),
    discardAll: () =>
      run(() => Promise.all([...changes.keys()].map((path) => lane((ws) => ws.revert(path))))),
    /** Owner act: publishes the mount's whole dirty set to the repo's main. */
    commit: (message: string) => run(() => lane((ws) => ws.commit(message))),
  };
}

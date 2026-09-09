import { useCallback, useEffect, useRef, useState } from "react";
import type { RepoFileStatus } from "@iterate-com/ui/components/repo-file-tree";
import type { WorkspaceStatus } from "iterate/client";
import { DEFAULT_REPO_PATH } from "./board-shared.ts";
import { withDocsProject } from "./docs-client.ts";
import { workspaceFor } from "./project-rpc.ts";
import type { DocsWorkspace } from "./docs-api.ts";

/** Files an agent adds or edits show up on this cadence; own edits refresh at once. */
const STATUS_POLL_MS = 5_000;

/** One mount's uncommitted changes, in the shape the commit controls speak. */
export type WorkspaceMountChanges = {
  /** The mount point (`/repos/config`) — the commit scope; null for the
   * workspace's own directory, whose files are never committable. */
  scope: string | null;
  policy: "commit-to-main" | "read-only" | null;
  changes: { path: string; status: RepoFileStatus }[];
};

/**
 * The tree's ROOTS: every mount point plus the workspace's own directory.
 * Listings are loaded per root — a big repo mounted (iterate/iterate is
 * 40k+ files) must cost nothing until someone opens it — so the roots come
 * from status, which is cheap, and never from a listing.
 */
export function workspaceRoots(status: WorkspaceStatus, workspacePath: string): string[] {
  return [...new Set([...status.mounts.map((mount) => mount.path), workspacePath])].sort();
}

/** The root a path lives under, or null outside every root. */
export function rootOf(roots: readonly string[], path: string): string | null {
  return roots.find((root) => path === root || path.startsWith(`${root}/`)) ?? null;
}

/**
 * The tree's picture of a workspace from the per-root listings loaded so far
 * (each the merged view of that subtree: overlay over the mount at HEAD) and
 * ONE status (the overlay's changes, grouped by mount): what the mounts hold
 * at HEAD, the change map, the roots to show as folders even when unloaded
 * or empty, and the changes regrouped for the commit controls. Every path
 * is fully qualified.
 */
export function workspaceTree(
  roots: readonly string[],
  listings: ReadonlyMap<string, readonly string[]>,
  status: WorkspaceStatus,
): {
  headPaths: string[];
  directories: string[];
  changes: Map<string, RepoFileStatus>;
  mounts: WorkspaceMountChanges[];
} {
  const changes = new Map<string, RepoFileStatus>();
  const mounts: WorkspaceMountChanges[] = [];
  const groups = [
    ...status.mounts
      .toSorted((left, right) => left.path.localeCompare(right.path))
      .map((mount) => ({ scope: mount.path, policy: mount.policy, changes: mount.changes })),
    { scope: null, policy: null, changes: status.unmounted },
  ];
  for (const group of groups) {
    const entries = group.changes
      .toSorted((left, right) => left.path.localeCompare(right.path))
      .map((entry) => ({ path: entry.path, status: entry.change }));
    for (const entry of entries) changes.set(entry.path, entry.status);
    if (entries.length > 0) {
      mounts.push({ scope: group.scope, policy: group.policy, changes: entries });
    }
  }
  // A listing is the MERGED view of its root; HEAD is that minus what the
  // overlay added, plus what it deleted.
  const head = new Set<string>();
  for (const listing of listings.values()) for (const path of listing) head.add(path);
  for (const [path, change] of changes) {
    if (change === "added") head.delete(path);
    if (change === "deleted") head.add(path);
  }
  return { headPaths: [...head].sort(), directories: [...roots], changes, mounts };
}

/**
 * The Docs app's working tree over a WHOLE workspace: every mounted repo at
 * its own /repos/** path plus the workspace's own directory — the same
 * git-shaped picture the apps/os repo IDE draws from its in-browser store,
 * except the store here is the workspace overlay itself, shared with every
 * collaborator and agent and settled by the platform. Status (cheap) polls;
 * listings load per root, on demand: the config repo and the workspace's
 * own directory at once, any other mount when it is opened. Every mutation
 * is the same workspace write an agent makes; commit publishes ONE mount's
 * dirty set to that repo's main. Paths are fully qualified throughout.
 */
export function useWorkspaceFiles({ workspacePath }: { workspacePath: string }) {
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [listings, setListings] = useState<ReadonlyMap<string, readonly string[]>>(new Map());
  const [error, setError] = useState<string | null>(null);

  // Every workspace call goes through the platform surface for this
  // workspace (plain get; nothing here creates a workspace).
  const withWorkspace = useCallback(
    <T>(operation: (workspace: DocsWorkspace) => Promise<T>) =>
      withDocsProject((project) => operation(workspaceFor(project, workspacePath))),
    [workspacePath],
  );

  // Newest wins, per root: a listing that started before a mutation must
  // not land after the post-mutation one and hide the user's own change.
  const listingGeneration = useRef(new Map<string, number>());
  const loadRoot = useCallback(
    async (root: string) => {
      const mine = (listingGeneration.current.get(root) ?? 0) + 1;
      listingGeneration.current.set(root, mine);
      // One subtree walk, scoped server-side to this root's mount.
      const paths = await withWorkspace((workspace) => workspace.glob(`${root}/**/*`));
      if (listingGeneration.current.get(root) !== mine) return;
      setListings((current) => new Map(current).set(root, paths));
    },
    [withWorkspace],
  );

  const statusGeneration = useRef(0);
  const previousStatus = useRef<WorkspaceStatus | null>(null);
  const refreshStatus = useCallback(async () => {
    const mine = ++statusGeneration.current;
    const next = await withWorkspace((workspace) => workspace.git.status());
    if (statusGeneration.current !== mine) return null;
    setStatus(next);
    setError(null);
    return next;
  }, [withWorkspace]);

  /** Load the root a path lives under, once (a later refresh re-lists it). */
  const loaded = useRef(new Set<string>());
  const ensureLoaded = useCallback(
    (path: string) => {
      const roots = status === null ? [] : workspaceRoots(status, workspacePath);
      const root = rootOf(roots, path);
      if (root === null || loaded.current.has(root)) return;
      loaded.current.add(root);
      void loadRoot(root).catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
    },
    [loadRoot, status, workspacePath],
  );

  // The heartbeat: status every few seconds. A root whose change count
  // SHRANK was committed or reverted under us — re-list it so committed
  // files stay in the tree. The first status also seeds the roots that
  // open at once: the workspace's own directory and the config repo.
  useEffect(() => {
    let cancelled = false;
    loaded.current.clear();
    previousStatus.current = null;
    setListings(new Map());
    const tick = () =>
      void refreshStatus()
        .then((next) => {
          if (cancelled || next === null) return;
          const roots = workspaceRoots(next, workspacePath);
          const previous = previousStatus.current;
          previousStatus.current = next;
          const changedCount = (snapshot: WorkspaceStatus, root: string) =>
            root === workspacePath
              ? snapshot.unmounted.length
              : (snapshot.mounts.find((mount) => mount.path === root)?.changes.length ?? 0);
          for (const root of roots) {
            const opensAtOnce = root === workspacePath || root === DEFAULT_REPO_PATH;
            const shrank =
              previous !== null && changedCount(next, root) < changedCount(previous, root);
            if (
              (opensAtOnce && !loaded.current.has(root)) ||
              (shrank && loaded.current.has(root))
            ) {
              loaded.current.add(root);
              void loadRoot(root).catch((cause: unknown) => {
                if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
              });
            }
          }
        })
        .catch((cause: unknown) => {
          if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
        });
    tick();
    const timer = setInterval(tick, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [loadRoot, refreshStatus, workspacePath]);

  /** One mutation, then status + the touched roots again; false (and the error shown) when it failed. */
  const run = useCallback(
    async (work: () => Promise<unknown>, touched: readonly string[]): Promise<boolean> => {
      const roots = status === null ? [] : workspaceRoots(status, workspacePath);
      const reload = async () => {
        await refreshStatus();
        const reloads: Promise<void>[] = [];
        const seen = new Set<string>();
        for (const path of touched) {
          const root = rootOf(roots, path);
          if (root === null || seen.has(root) || !loaded.current.has(root)) continue;
          seen.add(root);
          reloads.push(loadRoot(root));
        }
        await Promise.all(reloads);
      };
      try {
        await work();
        await reload();
        return true;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        void reload().catch(() => {});
        return false;
      }
    },
    [loadRoot, refreshStatus, status, workspacePath],
  );

  const tree =
    status === null ? null : workspaceTree(workspaceRoots(status, workspacePath), listings, status);
  const changes = tree?.changes ?? new Map<string, RepoFileStatus>();
  const pathsUnder = (directoryPath: string) => {
    const prefix = `${directoryPath}/`;
    const affected = new Set<string>();
    for (const path of tree?.headPaths ?? []) if (path.startsWith(prefix)) affected.add(path);
    for (const [path, change] of changes) {
      if (change !== "deleted" && path.startsWith(prefix)) affected.add(path);
    }
    return [...affected];
  };

  return {
    /** What the loaded roots hold at HEAD (null until the first status lands). */
    headPaths: tree?.headPaths ?? null,
    /** Every root, shown as a folder even before its listing loads. */
    directories: tree?.directories ?? [],
    changes,
    /** Uncommitted changes grouped by mount, dirty mounts only. */
    mounts: tree?.mounts ?? [],
    error,
    ensureLoaded,
    createFile: (path: string) =>
      run(() => withWorkspace((workspace) => workspace.writeFile(path, "")), [path]),
    rename: (from: string, to: string, isFolder: boolean) =>
      run(async () => {
        if (isFolder) throw new Error("Renaming folders is not supported yet.");
        const content = await withWorkspace((workspace) => workspace.readFile(from));
        await withWorkspace((workspace) => workspace.writeFile(to, content ?? ""));
        await withWorkspace((workspace) => workspace.deleteFile(from));
      }, [from, to]),
    remove: (path: string, isFolder: boolean) =>
      run(
        () =>
          Promise.all(
            (isFolder ? pathsUnder(path) : [path]).map((victim) =>
              withWorkspace((workspace) => workspace.deleteFile(victim)),
            ),
          ),
        [path],
      ),
    /** Back to the mount's version: restore a delete, drop an add, undo edits. */
    discard: (path: string) =>
      run(() => withWorkspace((workspace) => workspace.revert(path)), [path]),
    /** Every change under one mount (null: the workspace's own directory). */
    discardAll: (scope: string | null) => {
      const paths = (tree?.mounts.find((mount) => mount.scope === scope)?.changes ?? []).map(
        (change) => change.path,
      );
      return run(
        () =>
          Promise.all(paths.map((path) => withWorkspace((workspace) => workspace.revert(path)))),
        paths,
      );
    },
    /** Owner act: publishes ONE mount's whole dirty set to its repo's main. */
    commit: (input: { message: string; scope: string }) =>
      run(() => withWorkspace((workspace) => workspace.git.commit(input)), [input.scope]),
  };
}

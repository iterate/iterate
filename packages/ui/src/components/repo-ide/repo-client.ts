// The repo IDE's reads of one repo: its file list at the tip, kept current by the repo's commits,
// and the reads a page makes once (a file at a commit, a commit's changed files). The project is
// the root context the page holds open; each read opens the repo's handle and lets it go.
import { useCallback, useEffect, useRef, useState, type DependencyList } from "react";
import { z } from "zod";
import type { AuthenticatedApp } from "iterate/app";
import type { RepoLogEntry } from "iterate/api";

export type RepoProject = Awaited<ReturnType<AuthenticatedApp["api"]["projects"]["get"]>>;

export type Read<T> =
  | { status: "pending" }
  | { status: "failed"; message: string }
  | { status: "loaded"; value: T };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** One async read as render state, made again when `deps` change: the earlier read's answer is
 *  dropped, and until the new one lands the last loaded value stays (a file read again after a
 *  commit does not blink to a spinner and lose the reader's place). */
export function useRead<T>(read: () => Promise<T>, deps: DependencyList): Read<T> {
  const [state, setState] = useState<Read<T>>({ status: "pending" });
  useEffect(() => {
    let current = true;
    setState((previous) => (previous.status === "loaded" ? previous : { status: "pending" }));
    read().then(
      (value) => current && setState({ status: "loaded", value }),
      (error: unknown) => current && setState({ status: "failed", message: messageOf(error) }),
    );
    return () => {
      current = false;
    };
    // `deps` are what `read` closes over
  }, deps);
  return state;
}

export type RepoFiles = { commitOid: string | null; paths: string[] };
export type RepoFilesState = Read<RepoFiles>;

/** The commit events the file list reads: which repo each was to. */
const CommitsCompleted = z.array(z.object({ payload: z.object({ path: z.string() }) }));

/** Calls `onCommit` after each commit to `repoPath`, whoever made it: a commit reaches the page as
 *  the project root's `repo/commit-completed`. `onWatching` runs once the subscription is open, so a
 *  read made then cannot miss a commit between. Answers what stops the watch. */
function watchRepoCommits(
  project: RepoProject,
  repoPath: string,
  handlers: {
    onWatching: () => void;
    onCommit: () => void;
    onError: (error: unknown) => void;
  },
) {
  let closed = false;
  let subscription: Disposable | undefined;
  project
    .subscribe({
      consumes: ["events.iterate.com/repo/commit-completed"],
      target: (events: unknown) => {
        if (CommitsCompleted.parse(events).some((event) => event.payload.path === repoPath))
          handlers.onCommit();
      },
    })
    .then((opened) => {
      if (closed) return opened[Symbol.dispose]();
      subscription = opened;
      handlers.onWatching();
    }, handlers.onError);
  return () => {
    closed = true;
    subscription?.[Symbol.dispose]();
  };
}

/** The repo's files at its tip, read when the page opens and again after each commit to the repo,
 *  whoever made it. `reload` reads now, after this page's own commit. */
export function useRepoFiles(project: RepoProject | undefined, repoPath: string) {
  const [state, setState] = useState<RepoFilesState>({ status: "pending" });
  // each read takes a number: an answer that is not the newest read's is dropped, so a slow read
  // never replaces the list a later one (a commit's) already showed
  const newestRead = useRef(0);

  const read = useCallback(async () => {
    if (!project) return;
    const mine = ++newestRead.current;
    try {
      using repo = project.repos.get(repoPath);
      const value = await repo.listFiles();
      if (mine === newestRead.current) setState({ status: "loaded", value });
    } catch (error) {
      if (mine === newestRead.current) setState({ status: "failed", message: messageOf(error) });
    }
  }, [project, repoPath]);

  useEffect(() => {
    if (!project) return;
    setState({ status: "pending" });
    return watchRepoCommits(project, repoPath, {
      onWatching: () => void read(),
      onCommit: () => void read(),
      onError: (error) => setState({ status: "failed", message: messageOf(error) }),
    });
  }, [project, repoPath, read]);

  return { state, reload: read };
}

/** The repo's newest commits, read while `enabled` (the History sidebar is open) and again when
 *  HEAD moves. */
export function useRepoLog(
  project: RepoProject,
  repoPath: string,
  enabled: boolean,
  headOid: string | null,
) {
  return useRead(async (): Promise<RepoLogEntry[]> => {
    if (!enabled) return [];
    using repo = project.repos.get(repoPath);
    return await repo.log({ limit: 50 });
  }, [project, repoPath, enabled, headOid]);
}

/** A file's text at a commit, or at the tip with no commit; undefined when the repo has no such
 *  file. */
export async function readRepoFile(
  project: RepoProject,
  repoPath: string,
  path: string,
  commitOid?: string,
) {
  using repo = project.repos.get(repoPath);
  const content = await repo.readFile(path, commitOid ? { commitOid } : undefined);
  // oxlint-disable-next-line iterate/simple-truthiness-check -- null is no such file, "" an empty one
  if (content === null) return undefined;
  return content;
}

export type ChangedFile = { path: string; status: "added" | "deleted" | "modified" };

/** The files a commit changed against its first parent, read from both commits' sources. */
export async function readChangedFiles(
  project: RepoProject,
  repoPath: string,
  commit: Pick<RepoLogEntry, "oid" | "parents">,
): Promise<ChangedFile[]> {
  using repo = project.repos.get(repoPath);
  const parent = commit.parents[0];
  const [after, before] = await Promise.all([
    repo.modules({ commitOid: commit.oid }),
    parent ? repo.modules({ commitOid: parent }) : Promise.resolve<Record<string, string>>({}),
  ]);
  const changed: ChangedFile[] = [];
  for (const path of Object.keys({ ...before, ...after }).sort()) {
    if (!(path in before)) changed.push({ path, status: "added" });
    else if (!(path in after)) changed.push({ path, status: "deleted" });
    else if (before[path] !== after[path]) changed.push({ path, status: "modified" });
  }
  return changed;
}

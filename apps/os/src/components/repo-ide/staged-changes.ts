import { useSyncExternalStore } from "react";
import type { RepoFileChange } from "../../domains/repos/types.ts";

/**
 * The repo IDE's in-browser working tree: uncommitted file changes keyed by
 * repo path. Nothing here touches the backend — a Commit flushes the whole
 * map through one `repo.commitFiles` batch, mirroring git's stage-then-commit
 * shape (which is also what makes dirty markers, diffs, and discard work).
 */
export type StagedEntry =
  | { type: "write"; content: string }
  | { type: "write-base64"; contentBase64: string }
  | { type: "delete" };

export type StagedChanges = ReadonlyMap<string, StagedEntry>;

export class StagedChangesStore {
  #changes: ReadonlyMap<string, StagedEntry> = new Map();
  #listeners = new Set<() => void>();

  /** Stable snapshot — replaced (never mutated) on every change. */
  get changes(): StagedChanges {
    return this.#changes;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  stage(path: string, entry: StagedEntry): void {
    const next = new Map(this.#changes);
    next.set(path, entry);
    this.#commit(next);
  }

  discard(path: string): void {
    if (!this.#changes.has(path)) return;
    const next = new Map(this.#changes);
    next.delete(path);
    this.#commit(next);
  }

  discardAll(): void {
    if (this.#changes.size === 0) return;
    this.#commit(new Map());
  }

  #commit(next: ReadonlyMap<string, StagedEntry>): void {
    this.#changes = next;
    for (const listener of this.#listeners) listener();
  }
}

/**
 * Stores keyed per repo, module-level so staged work survives client-side
 * navigation away and back (not reloads — deliberately, v1).
 */
const stores = new Map<string, StagedChangesStore>();

export function stagedChangesStore(input: { projectId: string; repoPath: string }) {
  const key = `${input.projectId}:${input.repoPath}`;
  const existing = stores.get(key);
  if (existing) return existing;
  const created = new StagedChangesStore();
  stores.set(key, created);
  return created;
}

export function useStagedChanges(store: StagedChangesStore): StagedChanges {
  return useSyncExternalStore(
    store.subscribe,
    () => store.changes,
    () => store.changes,
  );
}

/** The pierre-tree git-status annotation for every staged path. */
export function stagedGitStatus(
  changes: StagedChanges,
  headPaths: ReadonlySet<string>,
): Array<{ path: string; status: "added" | "deleted" | "modified" }> {
  return [...changes].map(([path, entry]) => ({
    path,
    status: entry.type === "delete" ? "deleted" : headPaths.has(path) ? "modified" : "added",
  }));
}

/** The `commitFiles` changes batch for the staged map. */
export function stagedRepoFileChanges(changes: StagedChanges): RepoFileChange[] {
  return [...changes].map(([path, entry]) => {
    if (entry.type === "delete") return { path, delete: true };
    if (entry.type === "write-base64") return { path, contentBase64: entry.contentBase64 };
    return { path, content: entry.content };
  });
}

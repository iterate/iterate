import { useSyncExternalStore } from "react";
import type { RepoFileChange } from "../../domains/repos/types.ts";

/**
 * The repo IDE's in-browser working tree, git-shaped: every path carries up
 * to two snapshots — `working` (live uncommitted edits) and `staged` (what
 * the next commit will take when anything is staged). Nothing here touches
 * the backend; Commit flushes staged entries (or everything when nothing is
 * staged) through one `repo.commitFiles` batch.
 *
 * Persistence: the whole map mirrors into localStorage keyed by repo AND
 * HEAD commit oid, so a reload keeps your edits — but a HEAD that moved
 * underneath you (someone else committed) orphans the old key instead of
 * producing nonsense diffs against the new checkout.
 */
export type FileEntry =
  | { type: "write"; content: string }
  | { type: "write-base64"; contentBase64: string }
  | { type: "delete" };

export type FileChange = { working?: FileEntry; staged?: FileEntry };

export type WorkingTreeChanges = ReadonlyMap<string, FileChange>;

class WorkingTreeStore {
  #changes: ReadonlyMap<string, FileChange>;
  #listeners = new Set<() => void>();

  constructor(readonly storageKey: string) {
    this.#changes = loadPersisted(storageKey);
  }

  /** Stable snapshot — replaced (never mutated) on every change. */
  get changes(): WorkingTreeChanges {
    return this.#changes;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  /** Set (or with undefined, clear) the live uncommitted edit for a path.
   * An edit identical to the staged snapshot is no edit at all — the file
   * belongs only in Staged Changes then, like vscode. */
  setWorking(path: string, entry: FileEntry | undefined): void {
    this.#patch(path, (change) => ({
      ...change,
      working: entry && change.staged && entriesEqual(entry, change.staged) ? undefined : entry,
    }));
  }

  /** Set (or with undefined, clear) the staged snapshot for a path. A working
   * edit the new snapshot just absorbed (block staging staged the last dirty
   * chunk) is dropped for the same reason. */
  setStaged(path: string, entry: FileEntry | undefined): void {
    this.#patch(path, (change) => ({
      working:
        entry && change.working && entriesEqual(change.working, entry) ? undefined : change.working,
      staged: entry,
    }));
  }

  /** git add: the working entry becomes the staged snapshot. */
  stage(path: string): void {
    this.#patch(path, (change) => ({ staged: change.working ?? change.staged }));
  }

  /** git reset a path: drop the staged snapshot. Working edits survive; when
   * there are none the staged snapshot becomes the working entry (so the
   * change moves back to Changes instead of vanishing). */
  unstage(path: string): void {
    this.#patch(path, (change) => ({ working: change.working ?? change.staged }));
  }

  /** Revert a path's live edits to its baseline (staged snapshot, else HEAD). */
  discardWorking(path: string): void {
    this.#patch(path, (change) => ({ staged: change.staged }));
  }

  /** Drop the staged snapshots of committed paths (post-commit cleanup). */
  clearStaged(paths: string[]): void {
    const next = new Map(this.#changes);
    for (const path of paths) {
      const change = next.get(path);
      if (!change) continue;
      if (!change.working) next.delete(path);
      else next.set(path, { working: change.working });
    }
    this.#commit(next);
  }

  /** Post-commit cleanup that respects edits made while the commit RPC was in
   * flight: a slot is cleared only while it still equals the entry that was
   * committed; anything newer survives (and migrates to the new HEAD's store). */
  clearCommitted(committed: ReadonlyMap<string, FileEntry>): void {
    const next = new Map(this.#changes);
    for (const [path, entry] of committed) {
      const change = next.get(path);
      if (!change) continue;
      const working =
        change.working && entriesEqual(change.working, entry) ? undefined : change.working;
      const staged =
        change.staged && entriesEqual(change.staged, entry) ? undefined : change.staged;
      if (!working && !staged) next.delete(path);
      else
        next.set(path, {
          ...(!working ? {} : { working }),
          ...(!staged ? {} : { staged }),
        });
    }
    this.#commit(next);
  }

  discardAll(): void {
    if (this.#changes.size === 0) return;
    this.#commit(new Map());
  }

  /** Move every remaining change onto another store (post-commit: HEAD moved,
   * surviving working edits belong to the new oid's key). */
  migrateTo(other: WorkingTreeStore): void {
    if (this === other) return;
    const merged = new Map(other.changes);
    for (const [path, change] of this.#changes) merged.set(path, change);
    other.#commit(merged);
    this.#commit(new Map());
  }

  #patch(path: string, update: (change: FileChange) => FileChange): void {
    const next = new Map(this.#changes);
    const updated = update(next.get(path) ?? {});
    if (!updated.working && !updated.staged) next.delete(path);
    else
      next.set(path, {
        ...(!updated.working ? {} : { working: updated.working }),
        ...(!updated.staged ? {} : { staged: updated.staged }),
      });
    this.#commit(next);
  }

  #commit(next: ReadonlyMap<string, FileChange>): void {
    this.#changes = next;
    persist(this.storageKey, next);
    for (const listener of this.#listeners) listener();
  }
}

function entriesEqual(left: FileEntry, right: FileEntry): boolean {
  if (left.type !== right.type) return false;
  if (left.type === "delete") return true;
  if (left.type === "write") return left.content === (right as { content: string }).content;
  return left.contentBase64 === (right as { contentBase64: string }).contentBase64;
}

const STORAGE_PREFIX = "repo-ide-working-tree:";

/**
 * Stores keyed per repo AND HEAD oid, module-level so staged work survives
 * client-side navigation; localStorage carries it across reloads. Stale keys
 * for the same repo at older heads are swept — their diffs would be against
 * a checkout that no longer exists.
 */
const stores = new Map<string, WorkingTreeStore>();

export function workingTreeStore(input: {
  projectId: string;
  repoPath: string;
  commitOid: string;
}) {
  const repoPrefix = `${STORAGE_PREFIX}${input.projectId}:${input.repoPath}:`;
  const key = `${repoPrefix}${input.commitOid}`;
  const existing = stores.get(key);
  if (existing) return existing;
  sweepStaleKeys(repoPrefix, key);
  const created = new WorkingTreeStore(key);
  stores.set(key, created);
  return created;
}

export function useWorkingTree(store: WorkingTreeStore): WorkingTreeChanges {
  return useSyncExternalStore(
    store.subscribe,
    () => store.changes,
    () => store.changes,
  );
}

/** The change a path currently represents, staged or not. */
export function effectiveEntry(change: FileChange): FileEntry | undefined {
  return change.working ?? change.staged;
}

/** Decode a text file regardless of which write lane produced it. Uploads use
 * the base64 lane even for Markdown, so text consumers must decode valid UTF-8
 * instead of treating every base64 entry as binary. */
export function textContentForEntry(entry: FileEntry | undefined): string | undefined {
  if (entry?.type === "write") return entry.content;
  if (entry?.type !== "write-base64") return undefined;
  try {
    const bytes = Uint8Array.from(atob(entry.contentBase64.trim()), (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** The pierre-tree git-status annotation for every changed path. */
export function workingTreeGitStatus(
  changes: WorkingTreeChanges,
  headPaths: ReadonlySet<string>,
): Array<{ path: string; status: "added" | "deleted" | "modified" }> {
  return [...changes].flatMap(([path, change]) => {
    const entry = effectiveEntry(change);
    if (!entry) return [];
    return [
      {
        path,
        status:
          entry.type === "delete"
            ? ("deleted" as const)
            : headPaths.has(path)
              ? ("modified" as const)
              : ("added" as const),
      },
    ];
  });
}

/** One working-tree entry as the wire shape `repo.commitFiles` takes. */
function fileChangeForEntry(path: string, entry: FileEntry): RepoFileChange {
  if (entry.type === "delete") return { path, delete: true };
  if (entry.type === "write-base64") return { path, contentBase64: entry.contentBase64 };
  return { path, content: entry.content };
}

/**
 * What Commit sends: the staged snapshots when anything is staged (vscode's
 * "commit what's staged"), otherwise every change ("commit everything").
 */
export function commitPlan(changes: WorkingTreeChanges): {
  mode: "staged" | "everything";
  paths: string[];
  fileChanges: RepoFileChange[];
} {
  const staged = [...changes].filter(([, change]) => !!change.staged);
  const pick = staged.length ? staged : [...changes];
  const mode = staged.length ? ("staged" as const) : ("everything" as const);
  const fileChanges: RepoFileChange[] = [];
  const paths: string[] = [];
  for (const [path, change] of pick) {
    const entry = mode === "staged" ? change.staged : effectiveEntry(change);
    if (!entry) continue;
    paths.push(path);
    fileChanges.push(fileChangeForEntry(path, entry));
  }
  return { mode, paths, fileChanges };
}

function persist(key: string, changes: WorkingTreeChanges): void {
  try {
    if (changes.size === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify([...changes]));
  } catch {
    // Quota exceeded or storage unavailable: the in-memory store still works,
    // the change just won't survive a reload.
  }
}

function loadPersisted(key: string): ReadonlyMap<string, FileChange> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Map();
    return new Map(JSON.parse(raw) as Array<[string, FileChange]>);
  } catch {
    return new Map();
  }
}

function sweepStaleKeys(repoPrefix: string, currentKey: string): void {
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(repoPrefix) && key !== currentKey) stale.push(key);
    }
    for (const key of stale) localStorage.removeItem(key);
  } catch {
    // Storage unavailable — nothing to sweep.
  }
}

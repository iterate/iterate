// Local working tree for mobile repository editing. Remote repository state remains
// canonical until the user explicitly commits the accumulated changes.

import { useSyncExternalStore } from "react";

type Snapshot = {
  buffers: Record<string, { current: string | null; head: string | null; loaded: boolean }>;
  commitMessage: string;
  drawerOpen: boolean;
  drawerView: "files" | "git";
  editorView: "preview" | "source";
  filter: string;
  headChanged: boolean;
  headCommitOid: string | null;
  headPaths: string[];
  newPath: string;
  selectedPath: string | null;
};

export type PendingRepoChange =
  | { content: string; kind: "create" | "edit"; path: string }
  | { delete: true; kind: "delete"; path: string };

class RepoWorkingTreeStore {
  #listeners = new Set<() => void>();
  #snapshot: Snapshot = {
    buffers: {},
    commitMessage: "Edit project files from mobile",
    drawerOpen: true,
    drawerView: "files",
    editorView: "source",
    filter: "",
    headChanged: false,
    headCommitOid: null,
    headPaths: [],
    newPath: "",
    selectedPath: null,
  };

  getSnapshot = () => this.#snapshot;

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  setHead(commitOid: string, paths: string[]) {
    if (this.#snapshot.headCommitOid === commitOid) return;
    if (this.#snapshot.headCommitOid !== null && pendingChanges(this.#snapshot).length > 0) {
      this.#update({ headChanged: true });
      return;
    }
    this.replaceHead(commitOid, paths);
  }

  replaceHead(commitOid: string, paths: string[]) {
    this.#update({
      buffers: {},
      headChanged: false,
      headCommitOid: commitOid,
      headPaths: paths,
      selectedPath: null,
    });
  }

  pendingChanges() {
    return pendingChanges(this.#snapshot);
  }

  open(path: string, content: string) {
    const existing = this.#snapshot.buffers[path];
    this.#update({
      buffers: existing
        ? this.#snapshot.buffers
        : {
            ...this.#snapshot.buffers,
            [path]: { current: content, head: content, loaded: true },
          },
      editorView: isMarkdownPath(path) ? "preview" : "source",
      selectedPath: path,
    });
  }

  select(path: string) {
    if (this.#snapshot.buffers[path])
      this.#update({ editorView: isMarkdownPath(path) ? "preview" : "source", selectedPath: path });
  }

  updateSelected(content: string) {
    const path = this.#snapshot.selectedPath;
    if (path === null) return;
    const buffer = this.#snapshot.buffers[path];
    if (!buffer || buffer.current === null || buffer.current === content) return;
    this.#update({
      buffers: { ...this.#snapshot.buffers, [path]: { ...buffer, current: content } },
    });
  }

  create() {
    const path = this.#snapshot.newPath.trim().replace(/^\/+/, "").replace(/\/+/g, "/");
    if (path === "") throw new Error("Enter a file path.");
    if (visiblePaths(this.#snapshot).includes(path))
      throw new Error(`File already exists: ${path}`);
    this.#update({
      buffers: {
        ...this.#snapshot.buffers,
        [path]: { current: "", head: null, loaded: true },
      },
      editorView: isMarkdownPath(path) ? "preview" : "source",
      newPath: "",
      selectedPath: path,
    });
  }

  remove(path: string) {
    const buffer = this.#snapshot.buffers[path];
    if (buffer?.head === null) {
      const buffers = { ...this.#snapshot.buffers };
      delete buffers[path];
      this.#update({
        buffers,
        selectedPath: this.#snapshot.selectedPath === path ? null : this.#snapshot.selectedPath,
      });
      return;
    }
    this.#update({
      buffers: {
        ...this.#snapshot.buffers,
        [path]: {
          current: null,
          head: buffer ? buffer.head : "",
          loaded: buffer ? buffer.loaded : false,
        },
      },
      selectedPath: this.#snapshot.selectedPath === path ? null : this.#snapshot.selectedPath,
    });
  }

  discard(path: string) {
    const buffer = this.#snapshot.buffers[path];
    if (!buffer) return;
    if (buffer.head === null || !buffer.loaded) {
      const buffers = { ...this.#snapshot.buffers };
      delete buffers[path];
      this.#update({
        buffers,
        selectedPath: this.#snapshot.selectedPath === path ? null : this.#snapshot.selectedPath,
      });
      return;
    }
    this.#update({
      buffers: { ...this.#snapshot.buffers, [path]: { ...buffer, current: buffer.head } },
    });
  }

  acceptCommit(commitOid: string, committed: PendingRepoChange[]) {
    const buffers = { ...this.#snapshot.buffers };
    const headPaths = new Set(this.#snapshot.headPaths);
    for (const change of committed) {
      if (change.kind === "delete") {
        headPaths.delete(change.path);
        const buffer = buffers[change.path];
        if (!buffer || buffer.current === null) delete buffers[change.path];
        else buffers[change.path] = { ...buffer, head: null };
      } else {
        const current = change.content;
        const buffer = buffers[change.path];
        headPaths.add(change.path);
        buffers[change.path] = {
          current: buffer && buffer.current !== change.content ? buffer.current : current,
          head: current,
          loaded: true,
        };
      }
    }
    this.#update({
      buffers,
      headChanged: false,
      headCommitOid: commitOid,
      headPaths: [...headPaths].sort(),
      selectedPath:
        this.#snapshot.selectedPath && headPaths.has(this.#snapshot.selectedPath)
          ? this.#snapshot.selectedPath
          : null,
    });
  }

  setCommitMessage(commitMessage: string) {
    this.#update({ commitMessage });
  }

  setEditorView(editorView: "preview" | "source") {
    this.#update({ editorView });
  }

  closeDrawer() {
    this.#update({ drawerOpen: false });
  }

  openDrawer(drawerView: "files" | "git") {
    this.#update({ drawerOpen: true, drawerView });
  }

  setFilter(filter: string) {
    this.#update({ filter });
  }

  setNewPath(newPath: string) {
    this.#update({ newPath });
  }

  #update(patch: Partial<Snapshot>) {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }
}

function isMarkdownPath(path: string) {
  return path.endsWith(".md") || path.endsWith(".mdx");
}

const stores = new Map<string, RepoWorkingTreeStore>();

export function repoWorkingTreeStore(projectId: string) {
  const existing = stores.get(projectId);
  if (existing) return existing;
  const store = new RepoWorkingTreeStore();
  stores.set(projectId, store);
  return store;
}

export function useRepoWorkingTree(projectId: string) {
  const store = repoWorkingTreeStore(projectId);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return {
    ...snapshot,
    paths: visiblePaths(snapshot),
    pending: pendingChanges(snapshot),
    selectedBuffer: snapshot.selectedPath ? snapshot.buffers[snapshot.selectedPath] : undefined,
    store,
  };
}

function visiblePaths(snapshot: Snapshot) {
  const paths = new Set(snapshot.headPaths);
  for (const [path, buffer] of Object.entries(snapshot.buffers)) {
    if (buffer.current === null) paths.delete(path);
    else paths.add(path);
  }
  return [...paths].sort();
}

function pendingChanges(snapshot: Snapshot): PendingRepoChange[] {
  const changes: PendingRepoChange[] = [];
  for (const [path, buffer] of Object.entries(snapshot.buffers)) {
    if (buffer.current === buffer.head) continue;
    if (buffer.current === null) changes.push({ path, delete: true, kind: "delete" });
    else
      changes.push({
        path,
        content: buffer.current,
        kind: buffer.head === null ? "create" : "edit",
      });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

// The sidebar's file tree: @pierre/trees, the tree the old apps/docs used (packages/ui's
// repo-file-tree before #2837), through its vanilla model rather than its React hooks, so the page
// needs no effects: the tree is made when its element mounts, follows the page's live list of the
// repo's files, and selects the open file after each navigation. It draws in its own shadow DOM,
// so ⌘K gets the files from the page (routes/_auth/projects.$slug.tsx), not by reading the sidebar.
import { FileTree } from "@pierre/trees";
import type { DocList } from "../lib/doc-list.ts";

export class DocTree {
  #list: DocList;
  /** The file open in the page now, if any. */
  #openPath: () => string | undefined;
  /** Runs `listener` after each navigation; answers the unsubscribe. */
  #onNavigated: (listener: () => void) => () => void;
  #open: (path: string) => void;
  #tree: FileTree | null = null;
  /** The paths the tree holds, to add and remove only what changed (a reset would fold every
   *  folder the reader opened). */
  #paths = new Set<string>();

  constructor(options: {
    list: DocList;
    openPath: () => string | undefined;
    onNavigated: (listener: () => void) => () => void;
    open: (path: string) => void;
  }) {
    this.#list = options.list;
    this.#openPath = options.openPath;
    this.#onNavigated = options.onNavigated;
    this.#open = options.open;
  }

  /** The tree's element, as a React ref. */
  mount = (parent: HTMLDivElement | null) => {
    if (!parent) return;
    const state = this.#list.state();
    const paths = state.kind === "loaded" ? state.paths : [];
    const open = this.#openPath();
    const tree = new FileTree({
      paths,
      initialExpandedPaths: open ? folders(open) : [],
      initialSelectedPaths: open ? [open] : [],
      onSelectionChange: (selected) => {
        const path = selected[0];
        // a folder opens and closes; a file opens, unless it's the one open
        if (path && path !== this.#openPath() && tree.getItem(path)?.isDirectory() === false)
          this.#open(path);
      },
    });
    tree.render({ containerWrapper: parent });
    this.#tree = tree;
    this.#paths = new Set(paths);
    const stopListing = this.#list.subscribe(() => this.#sync());
    const stopFollowing = this.#onNavigated(() => this.#reveal());
    return () => {
      stopListing();
      stopFollowing();
      tree.cleanUp();
      this.#tree = null;
    };
  };

  #sync() {
    const state = this.#list.state();
    if (!this.#tree || state.kind !== "loaded") return;
    const next = new Set(state.paths);
    for (const path of next) if (!this.#paths.has(path)) this.#tree.add(path);
    for (const path of this.#paths) if (!next.has(path)) this.#tree.remove(path);
    this.#paths = next;
  }

  /** The open file selected, its folders open, and scrolled to. */
  #reveal() {
    const path = this.#openPath();
    const tree = this.#tree;
    if (!tree || !path || tree.getSelectedPaths()[0] === path) return;
    for (const folder of folders(path)) {
      const item = tree.getItem(folder);
      if (item && "expand" in item && !item.isExpanded()) item.expand();
    }
    for (const selected of tree.getSelectedPaths()) tree.getItem(selected)?.deselect();
    tree.getItem(path)?.select();
    tree.scrollToPath(path, { focus: false });
  }
}

/** The folders a path is in, outermost first, as the tree names them (`tasks/`, `tasks/done/`). */
function folders(path: string) {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, index) => `${parts.slice(0, index + 1).join("/")}/`);
}

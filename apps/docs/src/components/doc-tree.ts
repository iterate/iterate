// The sidebar's file tree: @pierre/trees, through its vanilla model rather than its React hooks, so
// the page needs no effects: the tree is made when its element mounts, follows the page's live list
// of the repo's files, and selects the open file after each navigation. It draws in its own shadow DOM,
// so ⌘K gets the files from the page (routes/_auth/projects.$slug.tsx), not by reading the sidebar.
//
// Right-clicking a row, or the space below the rows, offers "New doc": a row named `untitled.md` in
// that folder (the repo's root below the rows), named in place with the tree's own rename input
// A name with no extension gets `.md`. Enter makes the file, as the
// New doc box does, and opens it; Escape drops the row.
import { FileTree } from "@pierre/trees";
import type { DocList } from "../lib/doc-list.ts";

/** Pierre's colours from the sidebar's (packages/ui globals.css), and light only like the app:
 *  its own defaults follow the OS's scheme with light-dark(). */
const treeTheme: Record<string, string> = {
  // the sidebar's own, not transparent: a truncated name's "…" is painted over in this colour
  "--trees-bg-override": "var(--sidebar)",
  "--trees-fg-override": "var(--sidebar-foreground)",
  "--trees-fg-muted-override": "var(--muted-foreground)",
  "--trees-bg-muted-override": "var(--sidebar-accent)",
  "--trees-selected-bg-override": "var(--sidebar-accent)",
  "--trees-selected-fg-override": "var(--sidebar-accent-foreground)",
  "--trees-selected-focused-border-color-override": "var(--sidebar-ring)",
  "--trees-focus-ring-color-override": "var(--sidebar-ring)",
  "--trees-border-color-override": "var(--sidebar-border)",
  "--trees-indent-guide-bg-override": "var(--sidebar-border)",
  "--trees-input-bg-override": "var(--background)",
  "--trees-accent-override": "var(--primary)",
  "--trees-font-family-override": "inherit",
  "--trees-font-size-override": "14px",
  "--trees-padding-inline-override": "8px",
};

export class DocTree {
  #list: DocList;
  /** The file open in the page now, if any. */
  #openPath: () => string | undefined;
  /** Runs `listener` after each navigation; answers the unsubscribe. */
  #onNavigated: (listener: () => void) => () => void;
  #open: (path: string) => void;
  /** Make the file at `path` (lib/create-doc.ts) and open it. */
  #create: (path: string) => Promise<void>;
  #tree: FileTree | null = null;
  /** The paths the tree holds, to add and remove only what changed (a reset would fold every
   *  folder the reader opened). */
  #paths = new Set<string>();
  /** The row "New doc" added, while its name is being typed. */
  #naming: string | null = null;

  constructor(options: {
    list: DocList;
    openPath: () => string | undefined;
    onNavigated: (listener: () => void) => () => void;
    open: (path: string) => void;
    create: (path: string) => Promise<void>;
  }) {
    this.#list = options.list;
    this.#openPath = options.openPath;
    this.#onNavigated = options.onNavigated;
    this.#open = options.open;
    this.#create = options.create;
  }

  /** The tree's element, as a React ref. */
  mount = (parent: HTMLDivElement | null) => {
    if (!parent) return;
    // custom properties reach into the tree's shadow root
    for (const [name, value] of Object.entries(treeTheme)) parent.style.setProperty(name, value);
    const state = this.#list.state();
    const paths = state.kind === "loaded" ? state.paths : [];
    const open = this.#openPath();
    const tree = new FileTree({
      paths,
      initialExpandedPaths: open ? folders(open) : [],
      initialSelectedPaths: open ? [open] : [],
      onSelectionChange: (selected) => {
        const path = selected[0];
        // a folder opens and closes; a file of the repo opens, unless it's the one open (a row
        // still being named, or renamed but not yet made, isn't the repo's yet)
        if (path && path !== this.#openPath() && this.#paths.has(path)) this.#open(path);
      },
      composition: {
        contextMenu: {
          enabled: true,
          triggerMode: "right-click",
          render: (item, context) =>
            menu(() => {
              context.close({ restoreFocus: false });
              this.#newDoc(item.kind === "directory" ? item.path : folderOf(item.path));
            }),
        },
      },
      // only the row "New doc" added is named in the tree: moving a file waits for comments to move with it
      renaming: {
        canRename: (item) => item.path === this.#naming,
        onRename: (event) => void this.#named(event.sourcePath, event.destinationPath),
      },
      unsafeCSS: ":host { color-scheme: light; }",
    });
    tree.render({ containerWrapper: parent });
    this.#tree = tree;
    this.#paths = new Set(paths);
    // below the rows is the repo's root: "New doc" there makes a file at the top
    const onContextMenu = (event: MouseEvent) => {
      const onRow = event
        .composedPath()
        .some((node) => node instanceof HTMLElement && node.getAttribute("role") === "treeitem");
      if (onRow) return;
      event.preventDefault();
      popUp(event.clientX, event.clientY, () => this.#newDoc(""));
    };
    parent.addEventListener("contextmenu", onContextMenu);
    const stopListing = this.#list.subscribe(() => this.#sync());
    const stopFollowing = this.#onNavigated(() => this.#reveal());
    return () => {
      parent.removeEventListener("contextmenu", onContextMenu);
      stopListing();
      stopFollowing();
      tree.cleanUp();
      this.#tree = null;
    };
  };

  /** A row to name in `folder` (`tasks/`, or "" for the root). */
  #newDoc(folder: string) {
    const tree = this.#tree;
    if (!tree) return;
    const item = folder ? tree.getItem(folder) : null;
    if (item && "expand" in item && !item.isExpanded()) item.expand();
    let path = `${folder}untitled.md`;
    for (let n = 2; this.#paths.has(path); n++) path = `${folder}untitled-${n}.md`;
    this.#naming = path;
    tree.add(path);
    tree.startRenaming(path, { removeIfCanceled: true });
  }

  async #named(from: string, to: string) {
    if (from !== this.#naming) return;
    this.#naming = null;
    const name = to.split("/").at(-1)!;
    const path = name.includes(".") ? to : `${to}.md`;
    // the tree keeps the row it renamed; the file under another name arrives with the list
    if (path === to) this.#paths.add(to);
    else queueMicrotask(() => this.#tree?.remove(to));
    try {
      await this.#create(path);
    } catch (error) {
      this.#tree?.remove(path === to ? to : path);
      this.#paths.delete(to);
      window.alert(
        `Couldn't make ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  #sync() {
    const state = this.#list.state();
    if (!this.#tree || state.kind !== "loaded") return;
    const next = new Set(state.paths);
    for (const path of next) if (!this.#paths.has(path)) this.#tree.add(path);
    for (const path of this.#paths)
      if (!next.has(path) && path !== this.#naming) this.#tree.remove(path);
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

/** The folder a file is in, as the tree names it (`tasks/`), or "" at the root. */
function folderOf(path: string) {
  return folders(path).at(-1) || "";
}

/** The menu: one item, "New doc", in the popover's look. The tree puts a row's in place; the
 *  root's pops up at the pointer (`popUp`). */
function menu(newDoc: () => void) {
  const root = document.createElement("div");
  root.setAttribute("role", "menu");
  // the tree treats a click inside its menu as inside, not as a click away
  root.dataset.fileTreeContextMenuRoot = "true";
  root.className =
    "min-w-36 rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-md";
  const item = document.createElement("button");
  item.type = "button";
  item.setAttribute("role", "menuitem");
  item.textContent = "New doc";
  item.className =
    "flex w-full rounded-sm px-2 py-1.5 text-left outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent";
  item.addEventListener("click", newDoc);
  root.appendChild(item);
  return root;
}

/** The root's menu at the pointer, gone on a choice, a click elsewhere or Escape. */
function popUp(x: number, y: number, newDoc: () => void) {
  const close = () => {
    element.remove();
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
  };
  const element = menu(() => {
    close();
    newDoc();
  });
  element.style.position = "fixed";
  element.style.left = `${x}px`;
  element.style.top = `${y}px`;
  element.style.zIndex = "50";
  const onPointerDown = (event: PointerEvent) => {
    // the event's path, not its target: a click inside the tree is retargeted to its shadow host
    if (!event.composedPath().includes(element)) close();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  };
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.body.appendChild(element);
  element.querySelector("button")?.focus();
}

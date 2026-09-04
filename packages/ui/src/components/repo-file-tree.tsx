import { useEffect, useRef, type ReactNode } from "react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type {
  ContextMenuItem as TreeContextMenuItem,
  ContextMenuOpenContext as TreeContextMenuOpenContext,
} from "@pierre/trees";
import { FilePlusIcon, UploadIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@iterate-com/ui/components/context-menu";
import { cn } from "@iterate-com/ui/lib/utils";
import { untitledPath } from "@iterate-com/ui/lib/repo-file-tree-paths";

/** The vscode-style git-status letter a changed row wears. */
export type RepoFileStatus = "added" | "deleted" | "modified";

/**
 * Everything a tree row's context menu (and the header buttons) can do. The
 * host owns the change store and the backend, so the tree only reports intents.
 */
export interface RepoTreeActions {
  /** Create a brand-new empty text file (already named via inline rename).
   * May return the path it actually created when that differs (an extension
   * appended); the tree then drops the typed row. */
  createFile: (path: string) => string | void;
  /** Delete a file, or every file under a directory. */
  remove: (path: string, isFolder: boolean) => void;
  /** Move a file (or every file under a directory) to a new path. */
  rename: (fromPath: string, toPath: string, isFolder: boolean) => void;
  /** Pick a local file and add it (binary lane) inside a directory. Absent
   * hides the upload affordances. */
  upload?: (directoryPath: string) => void;
  /** Drop the change for one path — back to HEAD. */
  discard: (path: string) => void;
}

/**
 * The pierre file tree over one repo's HEAD plus its changes — the apps/os
 * repo IDE draws it from an in-browser staged working tree, the Docs app from
 * a workspace overlay. Rows carry vscode-style git-status annotations from
 * the change map (a deleted path stays visible, annotated, until committed or
 * discarded); right-click exposes new/rename/delete/discard, and upload when
 * the host supports it. Renames use pierre's inline-rename affordance, which
 * doubles as the "name a new file" input.
 */
export function RepoFileTree({
  headPaths,
  changes,
  selectedPath,
  onSelect,
  actions,
  className,
  header,
  untitledExtension = "txt",
}: {
  headPaths: string[];
  changes: ReadonlyMap<string, RepoFileStatus>;
  selectedPath: string | undefined;
  onSelect: (path: string) => void;
  actions: RepoTreeActions;
  className?: string;
  /** Rendered at the left of the toolbar row (a label, a breadcrumb). */
  header?: ReactNode;
  /** The extension a freshly named file gets before the user types a name. */
  untitledExtension?: string;
}) {
  const mergedPaths = mergePaths(headPaths, changes);
  // The pierre callbacks below were bound at model construction; they reach
  // the latest handlers through refs, written after render (never during).
  const onSelectRef = useRef(onSelect);
  const actionsRef = useRef(actions);
  useEffect(() => {
    onSelectRef.current = onSelect;
    actionsRef.current = actions;
  });
  // The inline-rename affordance doubles as the "name a new file" input:
  // while this holds a path, the next rename event is a file CREATION.
  const pendingNewFileRef = useRef<string | null>(null);

  const { model } = useFileTree({
    paths: mergedPaths,
    initialExpansion: "open",
    ...(selectedPath === undefined ? {} : { initialSelectedPaths: [selectedPath] }),
    onSelectionChange: (paths) => {
      const path = paths[0];
      if (path !== undefined && model.getItem(path)?.isDirectory() === false) {
        onSelectRef.current(path);
      }
    },
    renaming: {
      onRename: (event) => {
        const pendingNewFile = pendingNewFileRef.current;
        if (pendingNewFile !== null && event.sourcePath === pendingNewFile) {
          pendingNewFileRef.current = null;
          // The host may create the file under another name (an extension
          // appended): drop the typed row, the real one arrives with the
          // host's next path set, instead of a phantom beside it. Deferred:
          // pierre moves the row to its typed name only AFTER this callback.
          const created = actionsRef.current.createFile(event.destinationPath);
          if (typeof created === "string" && created !== event.destinationPath) {
            queueMicrotask(() => {
              try {
                model.remove(event.destinationPath);
              } catch {}
            });
          }
          return;
        }
        actionsRef.current.rename(event.sourcePath, event.destinationPath, event.isFolder);
      },
    },
  });

  // The model is imperative and lives for the component lifetime; path-set and
  // git-status changes sync into it. Incremental add/remove (not resetPaths)
  // so a change never collapses the user's expansion state. Tolerant of
  // rows pierre already moved itself (inline renames): a double add/remove of
  // the same path must not blow up the sync.
  const mergedPathsKey = mergedPaths.join("\n");
  // react-doctor-disable-next-line react-doctor/rerender-lazy-ref-init -- empty-container allocation per render is the rule's concern; trivial here, and the ??= lazy idiom trips exhaustive-deps instead
  const knownPathsRef = useRef(new Set(mergedPaths));
  useEffect(() => {
    const next = new Set(mergedPathsKey === "" ? [] : mergedPathsKey.split("\n"));
    const known = knownPathsRef.current;
    for (const path of next) {
      if (!known.has(path))
        try {
          model.add(path);
        } catch {}
    }
    for (const path of known) {
      if (!next.has(path))
        try {
          model.remove(path);
        } catch {}
    }
    knownPathsRef.current = next;
  }, [model, mergedPathsKey]);

  // Keyed on the serialized map so a host rebuilding the map every render
  // does not restyle the tree every render.
  const statusKey = [...changes].map(([path, status]) => `${path}:${status}`).join("\n");
  useEffect(() => {
    model.setGitStatus(
      statusKey === ""
        ? []
        : statusKey.split("\n").map((line) => {
            const at = line.lastIndexOf(":");
            return { path: line.slice(0, at), status: line.slice(at + 1) as RepoFileStatus };
          }),
    );
  }, [model, statusKey]);

  const startNewFile = (directoryPath: string | null) => {
    const placeholder = untitledPath(directoryPath, new Set(mergedPaths), untitledExtension);
    pendingNewFileRef.current = placeholder;
    model.add(placeholder);
    model.startRenaming(placeholder, { removeIfCanceled: true });
  };

  const upload = actions.upload;

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex shrink-0 items-center gap-0.5 border-b px-2 py-1">
        {header === undefined ? null : <div className="min-w-0 flex-1">{header}</div>}
        <Button
          variant="ghost"
          size="icon-sm"
          title="New file"
          aria-label="New file"
          onClick={() => startNewFile(null)}
          className={cn("text-muted-foreground", header === undefined && "ml-auto")}
        >
          <FilePlusIcon className="size-3.5" />
        </Button>
        {upload === undefined ? null : (
          <Button
            variant="ghost"
            size="icon-sm"
            title="Upload file"
            aria-label="Upload file"
            onClick={() => upload("")}
            className="text-muted-foreground"
          >
            <UploadIcon className="size-3.5" />
          </Button>
        )}
      </div>
      {/* The empty area below the rows is part of the tree too: right-click
          there gets a root-level menu. Pierre owns row context menus, so this
          one cancels itself when the click landed on a row (visible through
          the open shadow root via composedPath). */}
      <ContextMenu
        onOpenChange={(open, details) => {
          const onRow = details.event
            .composedPath()
            .some(
              (node) => node instanceof HTMLElement && node.getAttribute("role") === "treeitem",
            );
          if (open && onRow) details.cancel();
        }}
      >
        <ContextMenuTrigger className="flex min-h-0 flex-1 flex-col">
          <FileTree
            model={model}
            className="min-h-0 flex-1 overflow-y-auto"
            // Pierre themes itself with CSS light-dark(); pin the tree to light
            // for now — the CodeMirror pane beside it is light-only too (vsCodeLight),
            // so following the app's dark mode would clash anyway.
            style={{ colorScheme: "light" } as React.CSSProperties}
            renderContextMenu={(item, context) => (
              <RepoTreeContextMenu
                item={item}
                context={context}
                dirty={changes.has(item.path)}
                onNewFile={(directoryPath) => startNewFile(directoryPath)}
                onStartRename={(path) => model.startRenaming(path)}
                actions={actionsRef.current}
              />
            )}
          />
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => startNewFile(null)}>New file</ContextMenuItem>
          {upload === undefined ? null : (
            <ContextMenuItem onClick={() => upload("")}>Upload file…</ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}

function RepoTreeContextMenu({
  item,
  context,
  dirty,
  onNewFile,
  onStartRename,
  actions,
}: {
  item: TreeContextMenuItem;
  context: TreeContextMenuOpenContext;
  dirty: boolean;
  onNewFile: (directoryPath: string) => void;
  onStartRename: (path: string) => void;
  actions: RepoTreeActions;
}) {
  const isFolder = item.kind === "directory";
  const upload = actions.upload;
  return (
    <div className="z-50 flex min-w-36 flex-col gap-0.5 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
      {isFolder
        ? menuEntry("New file", () => {
            // Focus moves into the inline rename input, not back to the row.
            context.close({ restoreFocus: false });
            onNewFile(item.path);
          })
        : null}
      {isFolder && upload !== undefined
        ? menuEntry("Upload file…", () => {
            context.close();
            upload(item.path);
          })
        : null}
      {menuEntry("Rename", () => {
        context.close({ restoreFocus: false });
        onStartRename(item.path);
      })}
      {dirty
        ? menuEntry("Discard changes", () => {
            context.close();
            actions.discard(item.path);
          })
        : null}
      {menuEntry(
        "Delete",
        () => {
          context.close();
          actions.remove(item.path, isFolder);
        },
        true,
      )}
    </div>
  );
}

/** One row of a tree context menu. */
function menuEntry(label: string, onClick: () => void, destructive = false) {
  return (
    <button
      type="button"
      className={cn(
        "w-full rounded-sm px-2 py-1 text-left text-xs hover:bg-accent",
        destructive && "text-destructive",
      )}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/** All visible tree paths: HEAD files plus additions (deletions stay
 * visible, annotated as deleted, until committed or discarded). */
function mergePaths(headPaths: string[], changes: ReadonlyMap<string, RepoFileStatus>): string[] {
  const merged = new Set(headPaths);
  for (const [path, status] of changes) {
    if (status !== "deleted") merged.add(path);
  }
  return [...merged].sort();
}

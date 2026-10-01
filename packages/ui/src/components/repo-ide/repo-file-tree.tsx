import { useEffect, useRef } from "react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type {
  ContextMenuItem as TreeContextMenuItem,
  ContextMenuOpenContext as TreeContextMenuOpenContext,
} from "@pierre/trees";
import { FilePlusIcon } from "lucide-react";
import { cn } from "cn";
import { untitledPath } from "./repo-file-tree-paths.ts";
import { Button } from "#/components/ui/button.tsx";

/** The vscode-style git-status letter a changed row wears. */
export type RepoFileStatus = "added" | "deleted" | "modified";

/** Everything a tree row's context menu (and the header button) can do. The IDE owns the change
 *  store and the repo, so the tree only reports intents. */
export interface RepoTreeActions {
  /** Create a brand-new empty text file, already named through the inline rename. May return the
   *  path it actually created when that differs (an extension appended); the tree then drops the
   *  typed row. */
  createFile: (path: string) => string | void;
  /** Delete a file, or every file under a directory. */
  remove: (path: string, isFolder: boolean) => void;
  /** Move a file (or every file under a directory) to a new path. */
  rename: (fromPath: string, toPath: string, isFolder: boolean) => void;
  /** Drop the change for one path: back to HEAD. */
  discard: (path: string) => void;
}

/** The pierre file tree over one repo's HEAD plus its uncommitted changes. Rows carry vscode-style
 *  git-status annotations from the change map (a deleted path stays visible, annotated, until
 *  committed or discarded); right-click offers new file, rename, delete and discard. Renames use
 *  pierre's inline-rename affordance, which doubles as the "name a new file" input. */
export function RepoFileTree({
  headPaths,
  changes,
  selectedPath,
  onSelect,
  actions,
  className,
}: {
  headPaths: string[];
  changes: ReadonlyMap<string, RepoFileStatus>;
  selectedPath: string | undefined;
  onSelect: (path: string) => void;
  actions: RepoTreeActions;
  className?: string;
}) {
  const mergedPaths = mergePaths(headPaths, changes);
  // The pierre callbacks below were bound when the model was made; they reach the latest handlers
  // through refs, written after render.
  const onSelectRef = useRef(onSelect);
  const actionsRef = useRef(actions);
  useEffect(() => {
    onSelectRef.current = onSelect;
    actionsRef.current = actions;
  });
  // While this holds a path, the next rename event is a file creation
  const pendingNewFileRef = useRef<string | null>(null);
  // Only listed files exist: pierre also selects the temporary rows a rename makes
  // react-doctor-disable-next-line react-doctor/rerender-lazy-ref-init -- an empty-container allocation per render is trivial here, and the ??= idiom trips exhaustive-deps instead
  const knownPathsRef = useRef(new Set(mergedPaths));

  const { model } = useFileTree({
    paths: mergedPaths,
    initialExpansion: "open",
    ...(selectedPath && { initialSelectedPaths: [selectedPath] }),
    onSelectionChange: (paths) => {
      const path = paths[0];
      if (!path) return;
      const item = model.getItem(path);
      if (item?.isDirectory() === false && knownPathsRef.current.has(path))
        onSelectRef.current(path);
    },
    renaming: {
      onRename: (event) => {
        const pendingNewFile = pendingNewFileRef.current;
        if (pendingNewFile && event.sourcePath === pendingNewFile) {
          pendingNewFileRef.current = null;
          // The IDE may create the file under another name (an extension appended): drop the
          // typed row, the real one arrives with the next path set. Deferred: pierre moves the
          // row to its typed name only after this callback.
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

  // Path-set changes sync into the model by adding and removing only what changed (resetPaths
  // would fold every folder the reader opened). Tolerant of rows pierre already moved itself.
  const mergedPathsKey = mergedPaths.join("\n");
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

  // Keyed on the serialized map so a fresh map every render does not restyle the tree every render
  const statusKey = [...changes].map(([path, status]) => `${path}:${status}`).join("\n");
  useEffect(() => {
    model.setGitStatus(
      statusKey === ""
        ? []
        : statusKey.split("\n").map((line) => {
            // the value after the last colon is the status this key was built from; paths may
            // contain colons, a status never does
            const at = line.lastIndexOf(":");
            return { path: line.slice(0, at), status: line.slice(at + 1) as RepoFileStatus };
          }),
    );
  }, [model, statusKey]);

  const startNewFile = (directoryPath: string | null) => {
    const placeholder = untitledPath(directoryPath, new Set(mergedPaths), "txt");
    pendingNewFileRef.current = placeholder;
    model.add(placeholder);
    model.startRenaming(placeholder, { removeIfCanceled: true });
  };

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex shrink-0 items-center gap-0.5 border-b px-2 py-1">
        <span className="px-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Files
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          title="New file"
          aria-label="New file"
          onClick={() => startNewFile(null)}
          className="ml-auto text-muted-foreground"
        >
          <FilePlusIcon className="size-3.5" />
        </Button>
      </div>
      <FileTree
        model={model}
        className="min-h-0 flex-1 overflow-y-auto"
        // Pierre themes itself with CSS light-dark(); the editor beside it is light only
        // (vsCodeLight), so the tree is pinned to light too
        style={{ colorScheme: "light" }}
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
  return (
    <div className="z-50 flex min-w-36 flex-col gap-0.5 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
      {isFolder
        ? menuEntry("New file", () => {
            // focus moves into the inline rename input, not back to the row
            context.close({ restoreFocus: false });
            onNewFile(item.path);
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

/** All visible tree paths: HEAD's files plus additions; a deletion stays visible, annotated, until
 *  committed or discarded. */
function mergePaths(headPaths: string[], changes: ReadonlyMap<string, RepoFileStatus>): string[] {
  const merged = new Set(headPaths);
  for (const [path, status] of changes) {
    if (status !== "deleted") merged.add(path);
  }
  return [...merged].sort();
}

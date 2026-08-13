import { useEffect, useRef } from "react";
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
import { untitledPath } from "./repo-file-tree-paths.ts";
import { effectiveEntry, workingTreeGitStatus, type WorkingTreeChanges } from "./staged-changes.ts";

/**
 * Everything a tree row's context menu (and the header buttons) can do. The
 * IDE owns the staged-changes store and itx, so the tree only reports intents.
 */
export interface RepoTreeActions {
  /** Stage a brand-new empty text file (already named via inline rename). */
  createFile: (path: string) => void;
  /** Stage a delete for a file, or for every file under a directory. */
  remove: (path: string, isFolder: boolean) => void;
  /** Move a file (or every file under a directory) to a new path. */
  rename: (fromPath: string, toPath: string, isFolder: boolean) => void;
  /** Pick a local file and stage it (binary lane) inside a directory. */
  upload: (directoryPath: string) => void;
  /** Drop the staged change for one path. */
  discard: (path: string) => void;
}

/**
 * The pierre file tree over one repo checkout plus its staged changes. Rows
 * carry vscode-style git-status annotations (modified/added/deleted) derived
 * from the staged map; right-click exposes new/rename/delete/upload; renames
 * use pierre's inline-rename affordance.
 */
export function RepoFileTree({
  headPaths,
  changes,
  selectedPath,
  onSelect,
  actions,
  className,
}: {
  headPaths: string[];
  changes: WorkingTreeChanges;
  selectedPath: string | undefined;
  onSelect: (path: string) => void;
  actions: RepoTreeActions;
  className?: string;
}) {
  const mergedPaths = mergePaths(headPaths, changes);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  // The inline-rename affordance doubles as the "name a new file" input:
  // while this holds a path, the next rename event is a file CREATION.
  const pendingNewFileRef = useRef<string | null>(null);

  const { model } = useFileTree({
    paths: mergedPaths,
    initialExpansion: "open",
    ...(!selectedPath ? {} : { initialSelectedPaths: [selectedPath] }),
    onSelectionChange: (paths) => {
      const path = paths[0];
      if (path && model.getItem(path)?.isDirectory() === false) {
        onSelectRef.current(path);
      }
    },
    renaming: {
      onRename: (event) => {
        const pendingNewFile = pendingNewFileRef.current;
        if (pendingNewFile && event.sourcePath === pendingNewFile) {
          pendingNewFileRef.current = null;
          actionsRef.current.createFile(event.destinationPath);
          return;
        }
        actionsRef.current.rename(event.sourcePath, event.destinationPath, event.isFolder);
      },
    },
  });

  // The model is imperative and lives for the component lifetime; path-set and
  // git-status changes sync into it. Incremental add/remove (not resetPaths)
  // so a staged change never collapses the user's expansion state. Tolerant of
  // rows pierre already moved itself (inline renames): a double add/remove of
  // the same path must not blow up the sync.
  const mergedPathsKey = mergedPaths.join("\n");
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

  useEffect(() => {
    model.setGitStatus(workingTreeGitStatus(changes, new Set(headPaths)));
  }, [model, changes, headPaths]);

  const startNewFile = (directoryPath: string | null) => {
    const placeholder = untitledPath(directoryPath, new Set(mergedPaths));
    pendingNewFileRef.current = placeholder;
    model.add(placeholder);
    model.startRenaming(placeholder, { removeIfCanceled: true });
  };

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex shrink-0 items-center justify-end gap-0.5 border-b px-2 py-1">
        <Button
          variant="ghost"
          size="icon-sm"
          title="New file"
          onClick={() => startNewFile(null)}
          className="text-muted-foreground"
        >
          <FilePlusIcon className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title="Upload file"
          onClick={() => actions.upload("")}
          className="text-muted-foreground"
        >
          <UploadIcon className="size-3.5" />
        </Button>
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
          <ContextMenuItem onClick={() => actionsRef.current.upload("")}>
            Upload file…
          </ContextMenuItem>
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
  const entry = (label: string, onClick: () => void, destructive = false) => (
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

  return (
    <div className="z-50 flex min-w-36 flex-col gap-0.5 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
      {isFolder
        ? entry("New file", () => {
            // Focus moves into the inline rename input, not back to the row.
            context.close({ restoreFocus: false });
            onNewFile(item.path);
          })
        : null}
      {isFolder
        ? entry("Upload file…", () => {
            context.close();
            actions.upload(item.path);
          })
        : null}
      {entry("Rename", () => {
        context.close({ restoreFocus: false });
        onStartRename(item.path);
      })}
      {dirty
        ? entry("Discard changes", () => {
            context.close();
            actions.discard(item.path);
          })
        : null}
      {entry(
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

/** All visible tree paths: HEAD files plus staged additions (staged deletes
 * stay visible, annotated as deleted, until committed or discarded). */
function mergePaths(headPaths: string[], changes: WorkingTreeChanges): string[] {
  const merged = new Set(headPaths);
  for (const [path, change] of changes) {
    if (effectiveEntry(change)?.type !== "delete") merged.add(path);
  }
  return [...merged].sort();
}

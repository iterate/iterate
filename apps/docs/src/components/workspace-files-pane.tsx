import { lazy, Suspense, useCallback } from "react";
import type { RepoTreeActions } from "@iterate-com/ui/components/repo-file-tree";
import { withDocumentExtension } from "../lib/jam.ts";
import type { useWorkspaceFiles } from "../lib/use-workspace-files.ts";

/** A tree row id back to the fully qualified workspace path. */
function qualified(treePath: string): string {
  return `/${treePath}`;
}

// The tree is a web component (shadow DOM): browser-only, so it stays out
// of the SSR pass and the shell bundle.
const RepoFileTree = lazy(async () => {
  const module = await import("@iterate-com/ui/components/repo-file-tree");
  return { default: module.RepoFileTree };
});

/**
 * The file column beside a document: the shared repo tree over the WHOLE
 * workspace — every mounted repo under repos/, the workspace's own directory
 * under workspaces/ — with git-status badges from the overlay and
 * new/rename/delete/discard. Listings load per root: a mount opens (and
 * lists) when its row is clicked, so a big repo costs nothing until then.
 * The tree speaks paths without their leading slash (its row ids);
 * everything else here is fully qualified.
 */
export function WorkspaceFilesPane({
  files,
  workspacePath,
  selectedPath,
  onSelect,
  onDocumentRevised,
  className,
}: {
  files: ReturnType<typeof useWorkspaceFiles>;
  workspacePath: string;
  /** The open file's fully qualified path, if any. */
  selectedPath: string | undefined;
  /** A fully qualified path to open, or null to close the open one. */
  onSelect: (path: string | null) => void;
  /** The open document's content was replaced under the editor (a discard):
   * its collab session ended, the route must remount it. */
  onDocumentRevised: () => void;
  className?: string;
}) {
  const selected = selectedPath?.replace(/^\//, "");
  const select = useCallback(
    (path: string | undefined) => onSelect(path === undefined ? null : qualified(path)),
    [onSelect],
  );

  const actions: RepoTreeActions = {
    createFile: (treePath) => {
      // A file typed at the tree's root has no mount to live in: it lands in
      // the workspace's own directory instead (the only unmounted place the
      // platform writes). `.md` is implied when no extension was typed.
      const named = withDocumentExtension(treePath);
      const path = named.includes("/") ? qualified(named) : `${workspacePath}/${named}`;
      void files.createFile(path).then((ok) => {
        if (ok) onSelect(path);
      });
      return path.slice(1);
    },
    rename: (from, to, isFolder) => {
      const target = isFolder ? to : withDocumentExtension(to);
      void files.rename(qualified(from), qualified(target), isFolder).then((ok) => {
        if (ok && selected === from) select(target);
      });
    },
    remove: (treePath, isFolder) => {
      void files.remove(qualified(treePath), isFolder).then((ok) => {
        const gone =
          selected === treePath || (isFolder && selected?.startsWith(`${treePath}/`) === true);
        if (ok && gone) select(undefined);
      });
    },
    discard: (treePath) => {
      // Discarding an addition removes the file; discarding anything else
      // puts HEAD's content back under the editor.
      const path = qualified(treePath);
      const wasAddition = files.changes.get(path) === "added";
      void files.discard(path).then((ok) => {
        if (!ok || selected !== treePath) return;
        if (wasAddition) select(undefined);
        else onDocumentRevised();
      });
    },
  };

  return (
    <div className={className}>
      <Suspense fallback={<div className="h-14 border-b" />}>
        <RepoFileTree
          className="min-h-0 flex-1"
          headerClassName="h-14"
          header={
            <span
              className="block truncate font-mono text-xs text-muted-foreground"
              title={workspacePath}
            >
              {workspacePath}
            </span>
          }
          headPaths={(files.headPaths ?? []).map((path) => path.slice(1))}
          directories={files.directories.map((path) => path.slice(1))}
          changes={new Map([...files.changes].map(([path, status]) => [path.slice(1), status]))}
          selectedPath={selected}
          onSelect={select}
          onOpenDirectory={(treePath) => files.ensureLoaded(qualified(treePath))}
          actions={actions}
          untitledExtension="md"
          flattenEmptyDirectories
        />
      </Suspense>
      {files.error === null ? null : (
        <p className="shrink-0 border-t px-3 py-2 text-xs text-red-700">{files.error}</p>
      )}
    </div>
  );
}

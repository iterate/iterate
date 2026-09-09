import { lazy, Suspense, useCallback } from "react";
import type { RepoTreeActions } from "@iterate-com/ui/components/repo-file-tree";
import { withDocumentExtension } from "../lib/jam.ts";
import type { useWorkspaceFiles } from "../lib/use-workspace-files.ts";

// The tree is a web component (shadow DOM): browser-only, so it stays out
// of the SSR pass and the shell bundle.
const RepoFileTree = lazy(async () => {
  const module = await import("@iterate-com/ui/components/repo-file-tree");
  return { default: module.RepoFileTree };
});

/**
 * The file column beside a document: the shared repo tree over the
 * workspace's config-repo documents (git-status badges, new/rename/delete/
 * discard). Paths cross this component
 * repo-relative; the route speaks fully qualified ones.
 */
export function WorkspaceFilesPane({
  files,
  repoPath,
  selectedPath,
  onSelect,
  onDocumentRevised,
  className,
}: {
  files: ReturnType<typeof useWorkspaceFiles>;
  /** The /repos/** mount the tree shows. */
  repoPath: string;
  /** The open document's fully qualified path, if any. */
  selectedPath: string | undefined;
  /** A fully qualified document path to open, or null to close the open one. */
  onSelect: (path: string | null) => void;
  /** The open document's content was replaced under the editor (a discard):
   * its collab session ended, the route must remount it. */
  onDocumentRevised: () => void;
  className?: string;
}) {
  const prefix = `${repoPath}/`;
  const selected =
    selectedPath !== undefined && selectedPath.startsWith(prefix)
      ? selectedPath.slice(prefix.length)
      : undefined;
  const select = useCallback(
    (path: string | undefined) => onSelect(path === undefined ? null : `${prefix}${path}`),
    [onSelect, prefix],
  );

  const actions: RepoTreeActions = {
    createFile: (path) => {
      const named = withDocumentExtension(path);
      void files.createFile(named).then((ok) => {
        if (ok) select(named);
      });
      return named;
    },
    rename: (from, to, isFolder) => {
      const target = isFolder ? to : withDocumentExtension(to);
      void files.rename(from, target, isFolder).then((ok) => {
        if (ok && selected === from) select(target);
      });
    },
    remove: (path, isFolder) => {
      void files.remove(path, isFolder).then((ok) => {
        const gone = selected === path || (isFolder && selected?.startsWith(`${path}/`) === true);
        if (ok && gone) select(undefined);
      });
    },
    discard: (path) => {
      // Discarding an addition removes the file; discarding anything else
      // puts HEAD's content back under the editor.
      const wasAddition = files.changes.get(path) === "added";
      void files.discard(path).then((ok) => {
        if (!ok || selected !== path) return;
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
              title={repoPath}
            >
              {repoPath}
            </span>
          }
          headPaths={files.headPaths ?? []}
          changes={files.changes}
          selectedPath={selected}
          onSelect={select}
          actions={actions}
          untitledExtension="md"
        />
      </Suspense>
      {files.error === null ? null : (
        <p className="shrink-0 border-t px-3 py-2 text-xs text-red-700">{files.error}</p>
      )}
    </div>
  );
}

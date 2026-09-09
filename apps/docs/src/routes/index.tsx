import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { SidebarTrigger } from "@iterate-com/ui/components/sidebar";
import { cn } from "@iterate-com/ui/lib/utils";
import { workspaceFileKind } from "@iterate-com/workspace-documents/file-kinds";
import {
  DiffToggle,
  WorkspaceFileDiff,
} from "@iterate-com/workspace-documents/workspace-file-diff";
import { WorkspaceFileView } from "@iterate-com/workspace-documents/workspace-file-view";
import { useWorkspaceFiles } from "@iterate-com/workspace-documents/workspace-files";
import { WorkspaceTree } from "@iterate-com/workspace-documents/workspace-tree";
import { DeepLinkEmptyState } from "../components/deep-link-empty-state.tsx";
import { WorkspaceDocumentPage } from "../components/workspace-document-page.tsx";
import { WorkspaceActions } from "../components/workspace-actions.tsx";
import { DEFAULT_REPO_PATH } from "../lib/board-shared.ts";
import { workspaceTransport } from "../lib/project-rpc.ts";

export const Route = createFileRoute("/")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { diff?: boolean; path?: string; repo?: string; workspace?: string } => ({
    diff: search.diff === true || search.diff === "true" ? true : undefined,
    path: typeof search.path === "string" ? search.path : undefined,
    // The docs view ignores repo; it rides along so switching back to the
    // tasks view lands on the same board mount instead of the default.
    repo: typeof search.repo === "string" ? search.repo : undefined,
    workspace: typeof search.workspace === "string" ? search.workspace : undefined,
  }),
  component: DocumentPage,
});

function DocumentPage() {
  const search = Route.useSearch();
  if (search.workspace === undefined) return <DeepLinkEmptyState />;
  return (
    <WorkspaceFiles
      key={search.workspace}
      workspacePath={search.workspace}
      path={search.path}
      diff={search.diff === true}
    />
  );
}

/**
 * One workspace: the tree over every mounted repo and the workspace's own
 * directory, and beside it the open file — a document in the collaborative
 * editor, anything else read-only. `?path=` is fully qualified, or relative
 * to the workspace's own directory (the form agents mint in review links).
 */
function WorkspaceFiles({
  workspacePath,
  path,
  diff,
}: {
  workspacePath: string;
  path: string | undefined;
  /** Show the open file's diff against HEAD instead of the file. */
  diff: boolean;
}) {
  const transport = useMemo(() => workspaceTransport(workspacePath), [workspacePath]);
  const files = useWorkspaceFiles({ transport, listAtOnce: [DEFAULT_REPO_PATH] });
  const navigate = useNavigate({ from: Route.fullPath });
  const onSelect = useCallback(
    (path: string | null) =>
      void navigate({
        search: (current) => ({ ...current, path: path ?? undefined, diff: undefined }),
      }),
    [navigate],
  );
  const toggleDiff = useCallback(
    () => void navigate({ search: (current) => ({ ...current, diff: diff ? undefined : true }) }),
    [diff, navigate],
  );
  // Bumped when the open document was replaced under its editor (a discard
  // ended the collab session): the page remounts and attaches afresh.
  const [revision, setRevision] = useState(0);
  const onDocumentRevised = useCallback(() => setRevision((current) => current + 1), []);
  const selectedPath =
    path === undefined ? undefined : path.startsWith("/") ? path : `/workspace/${path}`;
  // The diff exists only while the file differs from HEAD: once a commit or
  // discard clears it, the file shows again even though ?diff=1 lingers.
  const dirty = selectedPath !== undefined && files.changes.has(selectedPath);
  const showDiff = diff && dirty;
  // A deep link into a mount that is not open yet: list that root so the
  // tree can show (and select) the file.
  const { ensureLoaded } = files;
  useEffect(() => {
    if (selectedPath !== undefined) ensureLoaded(selectedPath);
  }, [ensureLoaded, selectedPath]);
  // A deep link owns one collab session. Switching either address must tear
  // down its live editor, refs, and attach gate before the next snapshot shows.
  const documentKey = JSON.stringify([workspacePath, path, revision]);
  const actions = (
    <>
      {dirty ? <DiffToggle active={showDiff} onToggle={toggleDiff} /> : null}
      <WorkspaceActions
        files={files}
        workspacePath={workspacePath}
        selectedPath={selectedPath}
        onDiscarded={(scope) => {
          // The open file was under the discarded mount: an addition is gone
          // (close it), anything else was replaced under its editor (remount).
          if (selectedPath === undefined) return;
          const underScope =
            scope === null
              ? selectedPath.startsWith("/workspace/")
              : selectedPath.startsWith(`${scope}/`);
          if (!underScope) return;
          if (files.changes.get(selectedPath) === "added") onSelect(null);
          else onDocumentRevised();
        }}
      />
    </>
  );
  return (
    <div className="flex min-h-svh flex-col lg:h-svh lg:flex-row">
      {/* The tree is the whole page until a file is open; beside it on large
          screens after that (a phone shows one pane at a time). */}
      <WorkspaceTree
        key={workspacePath}
        files={files}
        workspacePath={workspacePath}
        selectedPath={selectedPath}
        onSelect={onSelect}
        onDocumentRevised={onDocumentRevised}
        // A bounded height on every viewport: the whole screen on a phone
        // (where the tree IS the page until a file opens), the row's height
        // beside the file on large screens.
        className={cn(
          "h-svh w-full shrink-0 border-r bg-background lg:h-auto lg:w-72",
          selectedPath === undefined ? "flex" : "hidden lg:flex",
        )}
      />
      <div
        className={cn(
          "flex min-w-0 flex-col lg:order-none lg:flex-1",
          selectedPath === undefined ? "order-first" : "flex-1",
        )}
      >
        {selectedPath === undefined ? (
          <>
            <header className="flex h-14 shrink-0 items-center justify-end gap-2 border-b px-3">
              <SidebarTrigger className="mr-auto md:hidden" />
              {actions}
            </header>
            <div className="hidden min-h-0 flex-1 place-items-center text-sm text-muted-foreground lg:grid">
              Pick a file, or add one.
            </div>
          </>
        ) : showDiff ? (
          <div key={documentKey} className="flex min-h-svh flex-col lg:h-svh lg:overflow-hidden">
            <WorkspaceFileDiff
              transport={transport}
              path={selectedPath}
              leading={<SidebarTrigger className="-ml-1 md:hidden" />}
              actions={actions}
            />
          </div>
        ) : workspaceFileKind(selectedPath).kind === "document" ? (
          <WorkspaceDocumentPage
            key={documentKey}
            workspacePath={workspacePath}
            path={selectedPath}
            actions={actions}
          />
        ) : (
          <div key={documentKey} className="flex min-h-svh flex-col lg:h-svh lg:overflow-hidden">
            <WorkspaceFileView
              transport={transport}
              path={selectedPath}
              leading={<SidebarTrigger className="-ml-1 md:hidden" />}
              actions={actions}
            />
          </div>
        )}
      </div>
    </div>
  );
}

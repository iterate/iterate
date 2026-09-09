import { useCallback, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { SidebarTrigger } from "@iterate-com/ui/components/sidebar";
import { cn } from "@iterate-com/ui/lib/utils";
import { DeepLinkEmptyState } from "../components/deep-link-empty-state.tsx";
import { WorkspaceDocumentPage } from "../components/workspace-document-page.tsx";
import { WorkspaceFilesPane } from "../components/workspace-files-pane.tsx";
import { WorkspaceActions } from "../components/workspace-actions.tsx";
import { useWorkspaceCommit } from "../lib/use-workspace-commit.ts";
import { useWorkspaceFiles } from "../lib/use-workspace-files.ts";
import { JAM_REPO_PATH } from "../lib/jam.ts";

export const Route = createFileRoute("/")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { path?: string; repo?: string; workspace?: string } => ({
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
    <WorkspaceDocuments
      key={search.workspace}
      workspacePath={search.workspace}
      path={search.path}
    />
  );
}

function WorkspaceDocuments({
  workspacePath,
  path,
}: {
  workspacePath: string;
  path: string | undefined;
}) {
  const files = useWorkspaceFiles({ workspacePath, repoPath: JAM_REPO_PATH });
  const commit = useWorkspaceCommit({ files, workspacePath });
  const navigate = useNavigate({ from: Route.fullPath });
  const onSelect = useCallback(
    (path: string | null) =>
      void navigate({ search: (current) => ({ ...current, path: path ?? undefined }) }),
    [navigate],
  );
  // Bumped when the open document was replaced under its editor (a discard
  // ended the collab session): the page remounts and attaches afresh.
  const [revision, setRevision] = useState(0);
  const onDocumentRevised = useCallback(() => setRevision((current) => current + 1), []);
  // A deep link owns one collab session. Switching either address must tear
  // down its live editor, refs, and attach gate before the next snapshot shows.
  const documentKey = JSON.stringify([workspacePath, path, revision]);
  const actions = (
    <WorkspaceActions
      commit={commit}
      workspacePath={workspacePath}
      selectedPath={path}
      onDiscardAll={() =>
        void files.discardAll().then((ok) => {
          if (!ok) return;
          const selected = path?.slice(JAM_REPO_PATH.length + 1);
          if (selected && files.changes.get(selected) === "added") onSelect(null);
          else onDocumentRevised();
        })
      }
    />
  );
  return (
    <div className="flex min-h-svh flex-col lg:h-svh lg:flex-row">
      {/* The files pane is the whole page until a document is open; beside it
          on large screens after that (a phone shows one pane at a time). */}
      <WorkspaceFilesPane
        key={workspacePath}
        files={files}
        repoPath={JAM_REPO_PATH}
        selectedPath={path}
        onSelect={onSelect}
        onDocumentRevised={onDocumentRevised}
        className={cn(
          "w-full shrink-0 flex-col border-r bg-background lg:flex lg:w-72",
          path === undefined ? "flex" : "hidden",
        )}
      />
      <div
        className={cn(
          "flex min-w-0 flex-col lg:order-none lg:flex-1",
          path === undefined ? "order-first" : "flex-1",
        )}
      >
        {path === undefined ? (
          <>
            <header className="flex h-14 shrink-0 items-center justify-end gap-2 border-b px-3">
              <SidebarTrigger className="mr-auto md:hidden" />
              {actions}
            </header>
            <div className="hidden min-h-0 flex-1 place-items-center text-sm text-muted-foreground lg:grid">
              Pick a file, or add one.
            </div>
          </>
        ) : (
          <WorkspaceDocumentPage
            key={documentKey}
            workspacePath={workspacePath}
            path={path}
            actions={actions}
          />
        )}
      </div>
    </div>
  );
}

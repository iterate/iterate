import { useCallback, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { SidebarTrigger } from "@iterate-com/ui/components/sidebar";
import { cn } from "@iterate-com/ui/lib/utils";
import { DeepLinkEmptyState } from "../components/deep-link-empty-state.tsx";
import { WorkspaceDocumentPage } from "../components/workspace-document-page.tsx";
import { WorkspaceFilesPane } from "../components/workspace-files-pane.tsx";
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
  if (search.workspace === undefined) {
    // No workspace addressed: the picker.
    return <DeepLinkEmptyState />;
  }
  const workspacePath = search.workspace;
  // A deep link owns one collab session. Switching either address must tear
  // down its live editor, refs, and attach gate before the next snapshot shows.
  const documentKey = JSON.stringify([workspacePath, search.path, revision]);
  return (
    <div className="flex min-h-svh lg:h-svh">
      {/* The files pane is the whole page until a document is open; beside it
          on large screens after that (a phone shows one pane at a time). */}
      <WorkspaceFilesPane
        key={workspacePath}
        workspacePath={workspacePath}
        repoPath={JAM_REPO_PATH}
        selectedPath={search.path}
        onSelect={onSelect}
        onDocumentRevised={onDocumentRevised}
        className={cn(
          "w-full shrink-0 flex-col border-r bg-background lg:flex lg:w-72",
          search.path === undefined ? "flex" : "hidden",
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {search.path === undefined ? (
          <div className="relative hidden min-h-0 flex-1 place-items-center text-sm text-muted-foreground lg:grid">
            <SidebarTrigger className="absolute top-3 left-3 md:hidden" />
            Pick a file, or add one.
          </div>
        ) : (
          <WorkspaceDocumentPage
            key={documentKey}
            workspacePath={workspacePath}
            path={search.path}
          />
        )}
      </div>
    </div>
  );
}

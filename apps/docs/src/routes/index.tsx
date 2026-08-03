import { createFileRoute } from "@tanstack/react-router";
import { DeepLinkEmptyState } from "../components/deep-link-empty-state.tsx";
import { WorkspaceDocumentPage } from "../components/workspace-document-page.tsx";

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): { path?: string; workspace?: string } => ({
    path: typeof search.path === "string" ? search.path : undefined,
    workspace: typeof search.workspace === "string" ? search.workspace : undefined,
  }),
  component: DocumentPage,
});

function DocumentPage() {
  const search = Route.useSearch();
  if (search.workspace === undefined || search.path === undefined) {
    // Workspace without document: the sidebar switcher lands here — the
    // picker opens scoped to that workspace, choosing a document is next.
    return <DeepLinkEmptyState workspacePath={search.workspace} />;
  }
  // A deep link owns one collab session. Switching either address must tear
  // down its live editor, refs, and attach gate before the next snapshot shows.
  const documentKey = JSON.stringify([search.workspace, search.path]);
  return (
    <WorkspaceDocumentPage key={documentKey} workspacePath={search.workspace} path={search.path} />
  );
}

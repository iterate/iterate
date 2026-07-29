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
    return <DeepLinkEmptyState />;
  }
  return <WorkspaceDocumentPage workspacePath={search.workspace} path={search.path} />;
}

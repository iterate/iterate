import { useCallback } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { WorkspaceBoardPage, type BoardSearch } from "../components/workspace-board-page.tsx";
import { DEFAULT_REPO_PATH, normalizeRepoPath } from "../lib/checkout-shared.ts";

/**
 * The board as a LENS on an existing workspace, addressed purely by its
 * platform path — the deep-link form `tasks.link` mints and agents share.
 * Plain get: nothing is created; outside the app's own /workspaces/tasks/
 * namespace the board is a guest (read, comment, edit — never Commit or
 * Discard all).
 *   /w?workspace=/workspaces/agents/you&repo=/repos/config&task=<path>
 */
export const Route = createFileRoute("/w/")({
  validateSearch: (search: Record<string, unknown>) => ({
    group:
      search.group === "none" || search.group === "label"
        ? (search.group as "none" | "label")
        : ("folder" as const),
    q: typeof search.q === "string" ? search.q : "",
    repo: typeof search.repo === "string" ? search.repo : DEFAULT_REPO_PATH,
    task: typeof search.task === "string" ? search.task : "",
    workspace: typeof search.workspace === "string" ? search.workspace : "",
  }),
  component: BoardLensPage,
});

function BoardLensPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const repoPath = normalizeRepoPath(search.repo) ?? DEFAULT_REPO_PATH;
  const patchSearch = useCallback(
    (patch: Partial<BoardSearch>) =>
      void navigate({ replace: true, search: (current) => ({ ...current, ...patch }) }),
    [navigate],
  );
  if (!search.workspace.startsWith("/workspaces/")) {
    return (
      <main className="mx-auto max-w-md p-8 text-sm text-muted-foreground">
        <h1 className="mb-2 text-base font-semibold text-foreground">No workspace addressed</h1>
        <p>
          This form of the board needs a <code>?workspace=/workspaces/…</code> deep link (the kind
          agents mint via <code>tasks.link</code>).{" "}
          <Link className="underline underline-offset-2" to="/">
            Pick a workspace
          </Link>{" "}
          instead.
        </p>
      </main>
    );
  }
  return (
    <WorkspaceBoardPage
      key={`${search.workspace}:${repoPath}`}
      address={{ checkoutId: null, repoPath, workspacePath: search.workspace }}
      search={{ group: search.group, q: search.q, task: search.task }}
      patchSearch={patchSearch}
    />
  );
}

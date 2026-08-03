import { useCallback } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { BoardHome } from "../components/board-home.tsx";
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
  // No silent fallback here: a deep link with a repo the board rejects must
  // say so, not quietly land the visitor on the default mount.
  const repoPath = normalizeRepoPath(search.repo);
  const patchSearch = useCallback(
    (patch: Partial<BoardSearch>) =>
      void navigate({ replace: true, search: (current) => ({ ...current, ...patch }) }),
    [navigate],
  );
  if (repoPath === null) {
    return (
      <div className="mx-auto max-w-md p-8 text-sm text-muted-foreground">
        <h1 className="mb-2 text-base font-semibold text-foreground">Bad repo in this link</h1>
        <p>
          The board needs a valid <code>?repo=/repos/…</code> (the kind agents mint via{" "}
          <code>tasks.link</code>).{" "}
          <Link
            className="underline underline-offset-2"
            to="/w"
            search={{ group: "folder", q: "", repo: "", task: "", workspace: "" }}
          >
            Pick a workspace
          </Link>{" "}
          instead.
        </p>
      </div>
    );
  }
  // No workspace addressed: /w is the tasks view's HOME, not an error.
  if (!search.workspace.startsWith("/workspaces/")) {
    return <BoardHome />;
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

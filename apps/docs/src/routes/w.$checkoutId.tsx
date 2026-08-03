import { useCallback } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { WorkspaceBoardPage, type BoardSearch } from "../components/workspace-board-page.tsx";
import {
  DEFAULT_REPO_PATH,
  checkoutWorkspacePath,
  normalizeRepoPath,
} from "../lib/checkout-shared.ts";

/**
 * A board on the tasks app's own workspace naming: the id in the path plus
 * `?repo=` derive the workspace path, and the workspace is lazily created on
 * first use — opening a fresh id IS how a new board is born.
 *   /w/<checkoutId>?repo=/repos/config&task=<path>&q=<filter>&group=none
 */
export const Route = createFileRoute("/w/$checkoutId")({
  validateSearch: (search: Record<string, unknown>) => ({
    group:
      search.group === "none" || search.group === "label"
        ? (search.group as "none" | "label")
        : ("folder" as const),
    q: typeof search.q === "string" ? search.q : "",
    repo: typeof search.repo === "string" ? search.repo : DEFAULT_REPO_PATH,
    task: typeof search.task === "string" ? search.task : "",
  }),
  component: BoardByIdPage,
});

function BoardByIdPage() {
  const { checkoutId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const repoPath = normalizeRepoPath(search.repo) ?? DEFAULT_REPO_PATH;
  const patchSearch = useCallback(
    (patch: Partial<BoardSearch>) =>
      void navigate({ replace: true, search: (current) => ({ ...current, ...patch }) }),
    [navigate],
  );
  return (
    <WorkspaceBoardPage
      address={{
        checkoutId,
        repoPath,
        workspacePath: checkoutWorkspacePath(checkoutId, repoPath),
      }}
      search={{ group: search.group, q: search.q, task: search.task }}
      patchSearch={patchSearch}
    />
  );
}

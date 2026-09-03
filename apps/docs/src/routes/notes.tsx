import { useCallback } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { NotesPage } from "../components/notes-page.tsx";
import { normalizeRepoPath } from "../lib/board-shared.ts";
import { DEFAULT_NOTE } from "../lib/notes-model.ts";

/**
 * Notes — the third view of the app, scoped to a REPO rather than a
 * workspace (it lives in the app's own notes workspace for that repo, so it
 * can commit by itself). `note` is the open file, repo-relative; empty means
 * the long-running log.
 *   /notes?repo=/repos/config&note=notes/ideas.md
 */
export const Route = createFileRoute("/notes")({
  validateSearch: (search: Record<string, unknown>) => ({
    note: typeof search.note === "string" ? search.note : "",
    repo: typeof search.repo === "string" ? search.repo : "",
  }),
  component: NotesRoutePage,
});

function NotesRoutePage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const repoPath = normalizeRepoPath(search.repo);
  const setNote = useCallback(
    (note: string) =>
      void navigate({
        replace: true,
        search: (current) => ({ ...current, note: note === DEFAULT_NOTE ? "" : note }),
      }),
    [navigate],
  );
  if (repoPath === null) {
    return (
      <div className="mx-auto max-w-md p-8 text-sm text-muted-foreground">
        <h1 className="mb-2 text-base font-semibold text-foreground">Bad repo in this link</h1>
        <p>
          Notes need a valid <code>?repo=/repos/…</code>.{" "}
          <Link
            className="underline underline-offset-2"
            to="/notes"
            search={{ note: "", repo: "" }}
          >
            Open the config repo&rsquo;s notes
          </Link>{" "}
          instead.
        </p>
      </div>
    );
  }
  return (
    <NotesPage
      key={repoPath}
      repoPath={repoPath}
      note={search.note === "" ? DEFAULT_NOTE : search.note}
      onSelectNote={setNote}
    />
  );
}

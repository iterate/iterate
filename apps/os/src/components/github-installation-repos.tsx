import { useMemo, useState } from "react";
import { Input } from "@iterate-com/ui/components/input";
import {
  listInstallationRepos,
  type InstallationRepo,
} from "~/components/github-installation-repos.ts";
import { useItxQuery } from "~/itx/itx-react.tsx";

/**
 * Filterable list of installation repos for a connection. Suspends on the
 * Octokit list — mount under `<Suspense>`. Compact density for the repo IDE
 * sidebar; the repos-page dialog uses the same component.
 */
export function InstallationRepoList({
  connection,
  projectId,
  filter,
  selected,
  onSelect,
  dense = false,
}: {
  connection: string;
  projectId: string;
  filter: string;
  selected: InstallationRepo | null;
  onSelect: (repo: InstallationRepo) => void;
  /** Tighter row chrome for the narrow GitHub IDE sidebar. */
  dense?: boolean;
}) {
  const { error, repos, totalCount } = useItxQuery({
    // Keyed by project AND connection: the query cache is app-wide, and two
    // projects can hold same-named connections to different installations.
    key: ["github-installation-repos", projectId, connection],
    query: (itx) => listInstallationRepos(itx, connection),
  });
  const visible = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (query === "") return repos;
    return repos.filter((repo) => repo.fullName.toLowerCase().includes(query));
  }, [filter, repos]);

  const text = dense ? "text-xs" : "text-sm";
  const listMax = dense ? "max-h-40" : "max-h-56";

  if (error !== null && repos.length === 0) {
    return (
      <div className={`break-words rounded-md border p-3 ${text} text-red-600`}>
        Could not list repositories through connection "{connection}": {error}
      </div>
    );
  }

  if (repos.length === 0) {
    return (
      <div className={`rounded-md border p-3 ${text} text-muted-foreground`}>
        The GitHub App installation on "{connection}" has access to no repositories. Grant it
        repository access on GitHub, then try again.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className={`${listMax} overflow-y-auto rounded-md border p-1`}>
        {visible.length === 0 ? (
          <div className={`p-3 ${text} text-muted-foreground`}>No repositories match.</div>
        ) : (
          visible.map((repo) => {
            const isSelected = selected?.fullName === repo.fullName;
            return (
              <button
                key={repo.fullName}
                type="button"
                className={`flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left ${text} hover:bg-accent ${isSelected ? "bg-accent" : ""}`}
                aria-pressed={isSelected}
                onClick={() => onSelect(repo)}
              >
                <span className="min-w-0 truncate font-mono text-xs">{repo.fullName}</span>
                {repo.defaultBranch !== "main" ? (
                  <span
                    className="shrink-0 text-xs text-muted-foreground"
                    title={`This repository's default branch is "${repo.defaultBranch}"; iterate pulls and mirrors "main".`}
                  >
                    default: {repo.defaultBranch}
                  </span>
                ) : null}
              </button>
            );
          })
        )}
      </div>
      {error !== null ? (
        <p className="break-words text-xs text-red-600">
          Listing stopped early — showing the {repos.length} repositories fetched so far: {error}
        </p>
      ) : repos.length < totalCount ? (
        <p className="text-xs text-muted-foreground">
          Showing {repos.length} of {totalCount} repositories the installation can see.
        </p>
      ) : null}
    </div>
  );
}

/** Filter field + installation list for pickers that own their own filter state. */
export function InstallationRepoPicker({
  connection,
  projectId,
  selected,
  onSelect,
  dense = false,
  filterId,
  filterPlaceholder = "Filter repositories…",
}: {
  connection: string;
  projectId: string;
  selected: InstallationRepo | null;
  onSelect: (repo: InstallationRepo) => void;
  dense?: boolean;
  filterId?: string;
  filterPlaceholder?: string;
}) {
  const [filter, setFilter] = useState("");
  return (
    <div className="flex flex-col gap-1.5">
      <Input
        id={filterId}
        placeholder={filterPlaceholder}
        className={dense ? "h-8 text-xs" : undefined}
        value={filter}
        onChange={(event) => setFilter(event.currentTarget.value)}
      />
      <InstallationRepoList
        connection={connection}
        projectId={projectId}
        filter={filter}
        selected={selected}
        onSelect={onSelect}
        dense={dense}
      />
    </div>
  );
}

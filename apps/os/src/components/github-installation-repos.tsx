import { useMemo, useState } from "react";
import { Input } from "@iterate-com/ui/components/input";
import { useItxQuery } from "iterate/sdk/itx/react";
import {
  listInstallationRepos,
  type InstallationRepo,
} from "~/components/github-installation-repos.ts";

/** Filter + pick an installation repo. Suspends on the Octokit list. */
export function InstallationRepoPicker({
  connection,
  projectId,
  selected,
  onSelect,
}: {
  connection: string;
  projectId: string;
  selected: InstallationRepo | null;
  onSelect: (repo: InstallationRepo) => void;
}) {
  const [filter, setFilter] = useState("");
  const { error, repos, totalCount } = useItxQuery({
    key: ["github-installation-repos", projectId, connection],
    query: (itx) => listInstallationRepos(itx, connection),
  });
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q === "" ? repos : repos.filter((r) => r.fullName.toLowerCase().includes(q));
  }, [filter, repos]);

  return (
    <div className="flex flex-col gap-1.5">
      <Input
        placeholder="Filter repositories…"
        className="h-8 text-xs"
        value={filter}
        onChange={(e) => setFilter(e.currentTarget.value)}
      />
      {error && !repos.length ? (
        <p className="break-words text-xs text-red-600">{error}</p>
      ) : !repos.length ? (
        <p className="text-xs text-muted-foreground">No repositories on this installation.</p>
      ) : (
        <div className="max-h-40 overflow-y-auto rounded-md border p-1">
          {!visible.length ? (
            <p className="p-2 text-xs text-muted-foreground">No match.</p>
          ) : (
            visible.map((repo) => (
              <button
                key={repo.fullName}
                type="button"
                className={`flex w-full truncate rounded-sm px-2 py-1.5 text-left font-mono text-xs hover:bg-accent ${selected?.fullName === repo.fullName ? "bg-accent" : ""}`}
                onClick={() => onSelect(repo)}
              >
                {repo.fullName}
              </button>
            ))
          )}
        </div>
      )}
      {error && repos.length ? (
        <p className="text-xs text-red-600">Partial list: {error}</p>
      ) : repos.length < totalCount ? (
        <p className="text-xs text-muted-foreground">
          Showing {repos.length} of {totalCount}
        </p>
      ) : null}
    </div>
  );
}

/** Same list with external filter control (repos-page dialog). */
export function InstallationRepoList({
  connection,
  projectId,
  filter,
  selected,
  onSelect,
}: {
  connection: string;
  projectId: string;
  filter: string;
  selected: InstallationRepo | null;
  onSelect: (repo: InstallationRepo) => void;
}) {
  const { error, repos, totalCount } = useItxQuery({
    key: ["github-installation-repos", projectId, connection],
    query: (itx) => listInstallationRepos(itx, connection),
  });
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q === "" ? repos : repos.filter((r) => r.fullName.toLowerCase().includes(q));
  }, [filter, repos]);

  if (error && !repos.length) {
    return <div className="break-words rounded-md border p-3 text-sm text-red-600">{error}</div>;
  }
  if (!repos.length) {
    return (
      <div className="rounded-md border p-3 text-sm text-muted-foreground">
        No repositories on this installation.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="max-h-56 overflow-y-auto rounded-md border p-1">
        {!visible.length ? (
          <div className="p-3 text-sm text-muted-foreground">No repositories match.</div>
        ) : (
          visible.map((repo) => (
            <button
              key={repo.fullName}
              type="button"
              className={`flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent ${selected?.fullName === repo.fullName ? "bg-accent" : ""}`}
              onClick={() => onSelect(repo)}
            >
              <span className="min-w-0 truncate font-mono text-xs">{repo.fullName}</span>
              {repo.defaultBranch !== "main" ? (
                <span className="shrink-0 text-xs text-muted-foreground">
                  default: {repo.defaultBranch}
                </span>
              ) : null}
            </button>
          ))
        )}
      </div>
      {error ? (
        <p className="break-words text-xs text-red-600">Partial list: {error}</p>
      ) : repos.length < totalCount ? (
        <p className="text-xs text-muted-foreground">
          Showing {repos.length} of {totalCount}
        </p>
      ) : null}
    </div>
  );
}

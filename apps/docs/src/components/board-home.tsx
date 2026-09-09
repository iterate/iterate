import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ClockIcon, FolderGit2Icon, Loader2Icon, PlusIcon, TelescopeIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { SidebarTrigger } from "@iterate-com/ui/components/sidebar";
import { listRepos, listWorkspaces, withProject } from "../lib/project-rpc.ts";
import type { WorkspaceListEntry } from "../lib/docs-api.ts";

/**
 * The tasks view's home — /w without a workspace addressed. One flat list of
 * every workspace of the project (any path opens as a board: this app's
 * scratch ones, agents' own as guest views), then one button per repo that
 * mints a fresh scratch workspace and opens it on that repo's task files.
 * Nothing actionable renders until the lists are actually known — a spinner,
 * never a premature empty state.
 */
export function BoardHome() {
  const navigate = useNavigate();
  const [repos, setRepos] = useState<string[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceListEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([listRepos(), listWorkspaces()]).then(([repoResult, listResult]) => {
      if (cancelled) return;
      if (repoResult.status === "fulfilled") setRepos(repoResult.value);
      if (listResult.status === "fulfilled") setWorkspaces(listResult.value);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // A workspace is CREATED here, explicitly, then opened by path — the
  // route itself never creates (plain get), so a shared link to a workspace
  // that does not exist says so instead of minting one.
  const openNewBoard = (repoPath: string) => {
    setCreating(repoPath);
    setCreateError(null);
    void withProject((project) => project.createWorkspace())
      .then(({ workspacePath }) =>
        navigate({
          to: "/w",
          search: { group: "folder", q: "", repo: repoPath, task: "", workspace: workspacePath },
        }),
      )
      .catch((error: unknown) => {
        setCreateError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setCreating(null));
  };

  return (
    <div className="relative min-h-svh overflow-auto bg-muted/30">
      <SidebarTrigger className="absolute top-3 left-3 md:hidden" />
      {!loaded ? (
        <div className="flex min-h-svh flex-col items-center justify-center gap-3 text-muted-foreground">
          <Loader2Icon aria-hidden className="size-6 animate-spin" />
          <p className="text-sm">Loading repos…</p>
        </div>
      ) : (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Task boards</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Pick a workspace — every repo is mounted inside it, and the board is a view over one
              repo&rsquo;s task files. Your own scratch workspaces commit to the repo&rsquo;s main;
              agents&rsquo; workspaces open as guest views (read, comment, edit — publishing stays
              the owner&rsquo;s act).
            </p>
          </div>
          {workspaces.length === 0 ? null : (
            <section className="rounded-xl border bg-background shadow-xs">
              <div className="flex items-center gap-2.5 border-b px-5 py-4">
                <TelescopeIcon aria-hidden className="size-5 text-muted-foreground" />
                <h2 className="truncate text-sm font-semibold">All workspaces</h2>
              </div>
              <ul className="divide-y">
                {workspaces.map((entry) => (
                  <li key={entry.path}>
                    <Link
                      to="/w"
                      search={{
                        group: "folder",
                        q: "",
                        repo: "",
                        task: "",
                        workspace: entry.path,
                      }}
                      className="flex items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-muted/50"
                    >
                      <span className="truncate font-mono text-sm">{entry.path}</span>
                      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                        <ClockIcon aria-hidden className="size-3.5" />
                        {relativeTimeLong(entry.createdAt)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="rounded-xl border bg-background shadow-xs">
            <div className="border-b px-5 py-4">
              <h2 className="text-sm font-semibold">New workspace as a board</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Mints a scratch workspace — every repo is mounted in it — and opens it on this
                repo&rsquo;s task files.
              </p>
            </div>
            <ul className="divide-y">
              {repos.map((repoPath) => (
                <li key={repoPath} className="flex items-center justify-between gap-3 px-5 py-3">
                  <span className="flex min-w-0 items-center gap-2.5">
                    <FolderGit2Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate font-mono text-sm">{repoPath}</span>
                  </span>
                  <Button
                    size="sm"
                    disabled={creating !== null}
                    onClick={() => openNewBoard(repoPath)}
                  >
                    <PlusIcon aria-hidden className="size-4" />
                    {creating === repoPath ? "Creating…" : "New workspace"}
                  </Button>
                </li>
              ))}
            </ul>
            {createError !== null && (
              <p className="border-t px-5 py-2 text-xs text-red-700">{createError}</p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function relativeTimeLong(createdAt: string): string {
  const timestamp = Date.parse(createdAt);
  if (Number.isNaN(timestamp) || timestamp <= 0) return "just now";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

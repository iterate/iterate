import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ClockIcon, FolderGit2Icon, Loader2Icon, PlusIcon, TelescopeIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { SidebarTrigger } from "@iterate-com/ui/components/sidebar";
import { newBoardId } from "../lib/board-shared.ts";
import { listRepos, listWorkspaces } from "../lib/project-rpc.ts";
import type { WorkspaceListEntry } from "../lib/tasks-api.ts";

/**
 * The tasks view's home — /w without a workspace addressed. One flat list of
 * every workspace (the app's own boards with their repo scope, agents'
 * workspaces as guest lenses), then per-repo cards for starting a new board
 * workspace. Nothing actionable renders until the lists are actually known —
 * a spinner, never a premature empty state.
 */
export function BoardHome() {
  const navigate = useNavigate();
  const [repos, setRepos] = useState<string[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceListEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

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

  const openNewBoard = (repoPath: string) => {
    void navigate({
      to: "/w/$boardId",
      params: { boardId: newBoardId() },
      search: { group: "folder", q: "", repo: repoPath, task: "" },
    });
  };

  return (
    <div className="relative min-h-svh overflow-auto bg-muted/30">
      <SidebarTrigger className="absolute top-3 left-3 md:hidden" />
      {loaded ? (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Task boards</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Pick a workspace first — every repo is mounted inside it, and the tasks view is a lens
              over one repo&rsquo;s task files. Your own board workspaces commit to the repo&rsquo;s
              main; agents&rsquo; workspaces open as guest lenses (read, comment, edit — publishing
              stays the owner&rsquo;s act).
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
                    {entry.board ? (
                      <Link
                        to="/w/$boardId"
                        params={{ boardId: entry.board.boardId }}
                        search={{
                          group: "folder",
                          q: "",
                          repo: entry.board.repoPath,
                          task: "",
                        }}
                        className="flex items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-muted/50"
                      >
                        <span className="truncate font-mono text-sm">
                          /workspaces/tasks/{entry.board.boardId}
                        </span>
                        <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
                          <span className="font-mono">{entry.board.repoPath}</span>
                          <span className="flex items-center gap-1.5">
                            <ClockIcon aria-hidden className="size-3.5" />
                            {relativeTimeLong(entry.createdAt)}
                          </span>
                        </span>
                      </Link>
                    ) : (
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
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <h2 className="mt-2 text-sm font-semibold text-muted-foreground">
            Start a new board workspace
          </h2>
          {repos.map((repoPath) => {
            const entries = workspaces.filter((entry) => entry.board?.repoPath === repoPath);
            return (
              <section key={repoPath} className="rounded-xl border bg-background shadow-xs">
                <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <FolderGit2Icon aria-hidden className="size-5 text-muted-foreground" />
                    <div className="min-w-0">
                      <h2 className="truncate font-mono text-sm font-semibold">{repoPath}</h2>
                      <p className="text-xs text-muted-foreground">
                        {entries.length === 0
                          ? "No boards yet"
                          : `${entries.length} board${entries.length === 1 ? "" : "s"}`}
                      </p>
                    </div>
                  </div>
                  <Button onClick={() => openNewBoard(repoPath)}>
                    <PlusIcon aria-hidden className="size-4" />
                    New board
                  </Button>
                </div>
                {entries.length === 0 ? null : (
                  <ul className="divide-y">
                    {entries.map((entry) => (
                      <li key={entry.path}>
                        <Link
                          to="/w/$boardId"
                          params={{ boardId: entry.board!.boardId }}
                          search={{ group: "folder", q: "", repo: repoPath, task: "" }}
                          className="flex items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-muted/50"
                        >
                          <span className="truncate font-mono text-sm">{entry.board!.boardId}</span>
                          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                            <ClockIcon aria-hidden className="size-3.5" />
                            {relativeTimeLong(entry.createdAt)}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      ) : (
        <div className="flex min-h-svh flex-col items-center justify-center gap-3 text-muted-foreground">
          <Loader2Icon aria-hidden className="size-6 animate-spin" />
          <p className="text-sm">Loading repos…</p>
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

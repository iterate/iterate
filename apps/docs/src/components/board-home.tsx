import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ClockIcon, Loader2Icon, TelescopeIcon } from "lucide-react";
import { SidebarTrigger } from "@iterate-com/ui/components/sidebar";
import { DEFAULT_REPO_PATH } from "../lib/board-shared.ts";
import { listWorkspaces } from "../lib/project-rpc.ts";
import type { WorkspaceListEntry } from "../lib/docs-api.ts";
import { NewWorkspaceForm } from "./new-workspace-form.tsx";

/**
 * The tasks view's home — /w without a workspace addressed. Every workspace
 * of the project (any path opens as a board), and a new one by name. Nothing
 * actionable renders until the list is actually known — a spinner, never a
 * premature empty state.
 */
export function BoardHome() {
  const navigate = useNavigate();
  const [workspaces, setWorkspaces] = useState<WorkspaceListEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void listWorkspaces()
      .then((list) => {
        if (!cancelled) setWorkspaces(list);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="relative min-h-svh overflow-auto bg-muted/30">
      <SidebarTrigger className="absolute top-3 left-3 md:hidden" />
      {!loaded ? (
        <div className="flex min-h-svh flex-col items-center justify-center gap-3 text-muted-foreground">
          <Loader2Icon aria-hidden className="size-6 animate-spin" />
          <p className="text-sm">Loading workspaces…</p>
        </div>
      ) : (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Task boards</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Pick a workspace — every repo is mounted inside it, and the board is a view over one
              repo&rsquo;s task files. Commit publishes that repo&rsquo;s changes to its main.
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
          <section className="rounded-xl border bg-background p-5 shadow-xs">
            <h2 className="text-sm font-semibold">New workspace</h2>
            <p className="mt-1 mb-3 text-xs text-muted-foreground">
              Every project repo is mounted in it; the board opens on the config repo&rsquo;s task
              files.
            </p>
            <NewWorkspaceForm
              className="max-w-md"
              onCreated={(workspace) =>
                void navigate({
                  to: "/w",
                  search: { group: "folder", q: "", repo: DEFAULT_REPO_PATH, task: "", workspace },
                })
              }
            />
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

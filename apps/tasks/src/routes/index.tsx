import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ClockIcon, FolderGit2Icon, Loader2Icon, PlusIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { SidebarTrigger } from "@iterate-com/ui/components/sidebar";
import { newCheckoutId } from "../lib/checkout-shared.ts";
import { listCheckouts, listRepos } from "../lib/use-checkout.ts";
import type { CheckoutIndexEntry } from "../lib/tasks-api.ts";
import { CheckoutBreadcrumbs } from "../components/checkout-header.tsx";

export const Route = createFileRoute("/")({ component: Home });

/**
 * Home is the real navigation surface: repos as cards, each listing its
 * checkouts newest-activity-first with relative timestamps, each carrying a
 * prominent "New checkout" call to action. Nothing actionable renders until
 * the lists are actually known — a spinner, never a premature empty state.
 */
function Home() {
  const navigate = useNavigate();
  const [repos, setRepos] = useState<string[]>([]);
  const [checkouts, setCheckouts] = useState<CheckoutIndexEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([listRepos(), listCheckouts()]).then(([repoResult, indexResult]) => {
      if (cancelled) return;
      if (repoResult.status === "fulfilled") setRepos(repoResult.value);
      if (indexResult.status === "fulfilled") setCheckouts(indexResult.value);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const openNewCheckout = (repoPath: string) => {
    void navigate({
      to: "/w/$checkoutId",
      params: { checkoutId: newCheckoutId() },
      search: { group: "folder", q: "", repo: repoPath, task: "" },
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b bg-background px-3">
        <SidebarTrigger className="-ml-1" />
        <CheckoutBreadcrumbs />
      </header>
      {!loaded ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-muted/30 text-muted-foreground">
          <Loader2Icon aria-hidden className="size-6 animate-spin" />
          <p className="text-sm">Loading repos…</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto bg-muted/30">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Task boards</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                A checkout is a shared working copy of a repo&rsquo;s tasks — everyone on its link
                edits together, live. Committing flushes the changes to git.
              </p>
            </div>
            {repos.map((repoPath) => {
              const entries = checkouts.filter((entry) => entry.repoPath === repoPath);
              return (
                <section key={repoPath} className="rounded-xl border bg-background shadow-xs">
                  <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <FolderGit2Icon aria-hidden className="size-5 text-muted-foreground" />
                      <div className="min-w-0">
                        <h2 className="truncate font-mono text-sm font-semibold">
                          {repoPath.replace(/^\/repos\//, "")}
                        </h2>
                        <p className="text-xs text-muted-foreground">
                          {entries.length === 0
                            ? "No checkouts yet"
                            : `${entries.length} checkout${entries.length === 1 ? "" : "s"}`}
                        </p>
                      </div>
                    </div>
                    <Button onClick={() => openNewCheckout(repoPath)}>
                      <PlusIcon aria-hidden className="size-4" />
                      Create new checkout
                    </Button>
                  </div>
                  {entries.length === 0 ? null : (
                    <ul className="divide-y">
                      {entries.map((entry) => (
                        <li key={entry.checkoutId}>
                          <Link
                            to="/w/$checkoutId"
                            params={{ checkoutId: entry.checkoutId }}
                            search={{ group: "folder", q: "", repo: repoPath, task: "" }}
                            className="flex items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-muted/50"
                          >
                            <span className="truncate font-mono text-sm">{entry.checkoutId}</span>
                            <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                              <ClockIcon aria-hidden className="size-3.5" />
                              {relativeTimeLong(entry.lastSeenAt)}
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
        </div>
      )}
    </div>
  );
}

function relativeTimeLong(timestamp: number): string {
  if (timestamp <= 0) return "just now";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { FolderGit2Icon, PlusIcon } from "lucide-react";
import { IterateLogo } from "@iterate-com/ui/components/iterate-logo";
import {
  Sidebar,
  SidebarContent,
  SidebarRail,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@iterate-com/ui/components/sidebar";
import { DEFAULT_REPO_PATH, newCheckoutId } from "../lib/checkout-shared.ts";
import { listCheckouts, listRepos } from "../lib/use-checkout.ts";
import type { CheckoutIndexEntry } from "../lib/tasks-api.ts";

/**
 * The two-stage navigation: repos are the top-level hierarchy, checkouts the
 * second. Repos come from the project's catalog; checkouts from the index
 * DO (every checkout anyone ever opened, newest activity first). The
 * currently open checkout is merged in optimistically so a brand-new one
 * appears before the index has heard about it. Composition follows the
 * apps/os AppSidebar (shadcn sidebar blocks 07/08): logo header, icon
 * collapse, footer collapse button, rail.
 */
export function AppSidebar() {
  const navigate = useNavigate();
  const location = useRouterState({ select: (state) => state.location });
  const activeCheckoutId = decodeURIComponent(
    /^\/(?:c|w)\/([^/]+)/.exec(location.pathname)?.[1] ?? "",
  );
  const search = location.search as { repo?: string; repoPath?: string };
  const activeRepoPath = (search.repo ?? search.repoPath ?? "") || DEFAULT_REPO_PATH;

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
    // Re-ask on navigation so fresh checkouts and commits show up.
  }, [location.pathname]);

  const groups = useMemo(() => {
    const byRepo = new Map<string, CheckoutIndexEntry[]>();
    for (const repo of repos) byRepo.set(repo, []);
    for (const entry of checkouts) {
      const list = byRepo.get(entry.repoPath) ?? [];
      list.push(entry);
      byRepo.set(entry.repoPath, list);
    }
    // The open checkout may be seconds old — show it even before the index
    // catches up.
    if (activeCheckoutId !== "") {
      const list = byRepo.get(activeRepoPath) ?? [];
      if (!list.some((entry) => entry.checkoutId === activeCheckoutId)) {
        list.unshift({
          repoPath: activeRepoPath,
          checkoutId: activeCheckoutId,
          createdAt: 0,
          lastSeenAt: 0,
          lastCommit: null,
        });
      }
      byRepo.set(activeRepoPath, list);
    }
    return [...byRepo.entries()].sort(([left], [right]) => {
      if (left === DEFAULT_REPO_PATH) return -1;
      if (right === DEFAULT_REPO_PATH) return 1;
      return left.localeCompare(right);
    });
  }, [repos, checkouts, activeCheckoutId, activeRepoPath]);

  const openNewCheckout = (repoPath: string) => {
    void navigate({
      to: "/w/$checkoutId",
      params: { checkoutId: newCheckoutId() },
      search: { group: "folder", q: "", repo: repoPath, task: "" },
    });
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link to="/" />} tooltip="Tasks home">
              <span className="flex aspect-square size-8 items-center justify-center rounded-md bg-black">
                <IterateLogo className="size-6 rounded-sm" />
              </span>
              <span className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">iterate</span>
                <span className="truncate text-xs text-muted-foreground">tasks</span>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {groups.map(([repoPath, entries]) => (
          <SidebarGroup key={repoPath} className="group-data-[collapsible=icon]:hidden">
            <SidebarGroupLabel className="gap-1.5">
              <FolderGit2Icon className="size-3.5" aria-hidden />
              <span className="truncate font-mono">{repoPath.replace(/^\/repos\//, "")}</span>
            </SidebarGroupLabel>
            <SidebarGroupAction
              title={`New checkout of ${repoPath}`}
              onClick={() => openNewCheckout(repoPath)}
            >
              <PlusIcon aria-hidden />
              <span className="sr-only">New checkout</span>
            </SidebarGroupAction>
            <SidebarGroupContent>
              <SidebarMenu>
                {entries.length === 0 ? (
                  <SidebarMenuItem>
                    <span className="block px-2 py-1 text-xs text-sidebar-foreground/50 group-data-[collapsible=icon]:hidden">
                      {loaded ? "no checkouts yet" : "loading…"}
                    </span>
                  </SidebarMenuItem>
                ) : (
                  entries.map((entry) => (
                    <SidebarMenuItem key={entry.checkoutId}>
                      <SidebarMenuButton
                        isActive={
                          entry.checkoutId === activeCheckoutId && repoPath === activeRepoPath
                        }
                        tooltip={entry.checkoutId}
                        render={
                          <Link
                            to="/w/$checkoutId"
                            params={{ checkoutId: entry.checkoutId }}
                            search={{ group: "folder", q: "", repo: repoPath, task: "" }}
                          />
                        }
                      >
                        <span className="truncate font-mono text-xs">{entry.checkoutId}</span>
                        {entry.lastSeenAt > 0 ? (
                          <span className="ml-auto shrink-0 text-[10px] tabular-nums text-sidebar-foreground/50">
                            {relativeTime(entry.lastSeenAt)}
                          </span>
                        ) : null}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

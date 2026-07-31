import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ChevronsLeft, PlusIcon, TelescopeIcon } from "lucide-react";
import { IterateLogo } from "@iterate-com/ui/components/iterate-logo";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarRail,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@iterate-com/ui/components/sidebar";
import { DEFAULT_REPO_PATH, newCheckoutId } from "../lib/checkout-shared.ts";
import { listWorkspaces } from "../lib/project-rpc.ts";
import type { WorkspaceListEntry } from "../lib/tasks-api.ts";
import { CloseMobileSidebarOnNavigate } from "~/components/close-mobile-sidebar-on-navigate.tsx";

/**
 * WORKSPACE-FIRST navigation: the workspace is the first level of the
 * hierarchy (repos are mounts inside every workspace), so the sidebar is one
 * flat workspace list from the platform's stream catalog — the app's own
 * boards labeled by their /workspaces/tasks/ naming with their repo scope as
 * a trailing chip, agents' workspaces openable as guest lenses. The
 * currently open board is merged in optimistically so a brand-new one
 * appears before its workspace exists. Composition follows the apps/os
 * AppSidebar (shadcn sidebar blocks 07/08): logo header, icon collapse,
 * footer collapse button, rail.
 */
export function AppSidebar() {
  const navigate = useNavigate();
  const location = useRouterState({ select: (state) => state.location });
  const activeCheckoutId = decodeURIComponent(/^\/w\/([^/]+)/.exec(location.pathname)?.[1] ?? "");
  const search = location.search as { repo?: string; workspace?: string };
  const activeRepoPath = (search.repo ?? "") || DEFAULT_REPO_PATH;
  const activeWorkspacePath = search.workspace ?? "";

  const [workspaces, setWorkspaces] = useState<WorkspaceListEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void listWorkspaces().then(
      (list) => {
        if (cancelled) return;
        setWorkspaces(list);
        setLoaded(true);
      },
      () => {
        if (!cancelled) setLoaded(true);
      },
    );
    return () => {
      cancelled = true;
    };
    // Re-ask on navigation so fresh boards and workspaces show up.
  }, [location.pathname]);

  // WORKSPACE-FIRST: one flat list — the workspace is the first level of the
  // hierarchy; a board's repo is the base path its tasks view is scoped to.
  const entries = useMemo(() => {
    const list = workspaces.map((entry) => ({
      key: entry.path,
      label: entry.board === null ? entry.path : `/workspaces/tasks/${entry.board.checkoutId}`,
      board: entry.board,
      createdAt: entry.createdAt,
    }));
    // The open board may be seconds old — show it even before its workspace
    // was created server-side.
    if (
      activeCheckoutId !== "" &&
      !list.some((entry) => entry.board?.checkoutId === activeCheckoutId)
    ) {
      list.unshift({
        key: `active:${activeCheckoutId}`,
        label: `/workspaces/tasks/${activeCheckoutId}`,
        board: { checkoutId: activeCheckoutId, repoPath: activeRepoPath },
        createdAt: "",
      });
    }
    return list;
  }, [workspaces, activeCheckoutId, activeRepoPath]);

  const openNewBoard = (repoPath: string) => {
    void navigate({
      to: "/w/$checkoutId",
      params: { checkoutId: newCheckoutId() },
      search: { group: "folder", q: "", repo: repoPath, task: "" },
    });
  };

  return (
    <>
      {/* Outside <Sidebar>: on mobile the children live in a Sheet that
          remounts when opened (see the os AppSidebar). */}
      <CloseMobileSidebarOnNavigate />
      <Sidebar collapsible="icon">
        {/* Collapsed: nudge the logo down so its center lines up with the h-11
            page header row — the same transition the os sidebar uses so the
            padding offset and the button's height change move together. */}
        <SidebarHeader className="transition-[padding] group-data-[collapsible=icon]:pt-3">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" render={<Link to="/" />} tooltip="Tasks home">
                <span className="flex aspect-square size-8 items-center justify-center rounded-md bg-black">
                  <IterateLogo className="size-6" />
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
          <SidebarGroup className="group-data-[collapsible=icon]:hidden">
            <SidebarGroupLabel className="gap-1.5">
              <TelescopeIcon className="size-3.5" aria-hidden />
              <span className="truncate">workspaces</span>
            </SidebarGroupLabel>
            <SidebarGroupAction
              title={`New board workspace on ${DEFAULT_REPO_PATH}`}
              onClick={() => openNewBoard(DEFAULT_REPO_PATH)}
            >
              <PlusIcon aria-hidden />
              <span className="sr-only">New board workspace</span>
            </SidebarGroupAction>
            <SidebarGroupContent>
              <SidebarMenu>
                {entries.length === 0 ? (
                  <SidebarMenuItem>
                    <span className="block px-2 py-1 text-xs text-sidebar-foreground/50 group-data-[collapsible=icon]:hidden">
                      {loaded ? "no workspaces yet" : "loading…"}
                    </span>
                  </SidebarMenuItem>
                ) : (
                  entries.map((entry) => (
                    <SidebarMenuItem key={entry.key}>
                      <SidebarMenuButton
                        isActive={
                          entry.board === null
                            ? entry.label === activeWorkspacePath
                            : entry.board.checkoutId === activeCheckoutId
                        }
                        tooltip={entry.label}
                        render={
                          entry.board === null ? (
                            <Link
                              to="/w"
                              search={{
                                group: "folder",
                                q: "",
                                repo: "",
                                task: "",
                                workspace: entry.label,
                              }}
                            />
                          ) : (
                            <Link
                              to="/w/$checkoutId"
                              params={{ checkoutId: entry.board.checkoutId }}
                              search={{
                                group: "folder",
                                q: "",
                                repo: entry.board.repoPath,
                                task: "",
                              }}
                            />
                          )
                        }
                      >
                        <span className="truncate font-mono text-xs">{entry.label}</span>
                        {entry.board !== null ? (
                          <span className="ml-auto shrink-0 font-mono text-[10px] text-sidebar-foreground/50">
                            {entry.board.repoPath.replace(/^\/repos\//, "")}
                          </span>
                        ) : entry.createdAt !== "" ? (
                          <span className="ml-auto shrink-0 text-[10px] tabular-nums text-sidebar-foreground/50">
                            {relativeTime(entry.createdAt)}
                          </span>
                        ) : null}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <AppSidebarCollapseButton />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
    </>
  );
}

function AppSidebarCollapseButton() {
  const { state, toggleSidebar } = useSidebar();
  const isCollapsed = state === "collapsed";

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          type="button"
          size="sm"
          className="text-sidebar-foreground/70"
          tooltip={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={toggleSidebar}
        >
          <ChevronsLeft className={isCollapsed ? "rotate-180" : undefined} />
          <span>Collapse sidebar</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function relativeTime(createdAt: string): string {
  const timestamp = Date.parse(createdAt);
  if (Number.isNaN(timestamp)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

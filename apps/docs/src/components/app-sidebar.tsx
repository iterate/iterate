import { useEffect, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { ChevronsLeft, FileTextIcon, SquareKanbanIcon } from "lucide-react";
import { IterateLogo } from "@iterate-com/ui/components/iterate-logo";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@iterate-com/ui/components/sidebar";

/**
 * The VIEWS a workspace can be seen through — the docs and tasks apps are
 * sibling lenses over the same workspace, so the sidebar switches between
 * them. Docs is this app; Tasks lives on the sibling project host
 * (`docs--<slug>` ↔ `tasks--<slug>`), carrying the current workspace along.
 * Composition follows the apps/os AppSidebar (shadcn sidebar blocks 07/08):
 * logo header, icon collapse, footer collapse button, rail.
 */
export function AppSidebar() {
  // The sidebar renders OUTSIDE any one route, so the router cannot type
  // this search value; the loose view is safe because `workspace` is read
  // as optional and only seeds the tasks-view link — absent (or any other
  // shape), the link simply targets the tasks app's home.
  const location = useRouterState({ select: (state) => state.location });
  const workspacePath = (location.search as { workspace?: string }).workspace;
  // The sibling tasks host exists only on project hosts, and only the
  // BROWSER knows that host (the config-worker proxy rewrites Host before
  // the vessel sees it) — so the link resolves after mount, never in SSR.
  const [tasksHref, setTasksHref] = useState<string | null>(null);
  useEffect(() => {
    const sibling = siblingTasksOrigin(window.location.hostname);
    if (sibling === null) {
      setTasksHref(null);
      return;
    }
    const url = new URL(`${window.location.protocol}//${sibling}/w`);
    if (workspacePath !== undefined) {
      url.searchParams.set("workspace", workspacePath);
      url.searchParams.set("repo", "/repos/config");
    }
    setTasksHref(workspacePath === undefined ? `${url.origin}/` : url.href);
  }, [workspacePath]);

  return (
    <Sidebar collapsible="icon">
      {/* Collapsed: nudge the logo down so its center lines up with the page
          header row — the same transition the os and tasks sidebars use. */}
      <SidebarHeader className="transition-[padding] group-data-[collapsible=icon]:pt-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" tooltip="Docs">
              <span className="flex aspect-square size-8 items-center justify-center rounded-md bg-black">
                <IterateLogo className="size-6" />
              </span>
              <span className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">iterate</span>
                <span className="truncate text-xs text-muted-foreground">docs</span>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>views</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive tooltip="Docs — this document">
                  <FileTextIcon aria-hidden />
                  <span>Docs</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                {tasksHref === null ? (
                  <SidebarMenuButton
                    disabled
                    tooltip="Tasks — available on the project's own host"
                    className="opacity-50"
                  >
                    <SquareKanbanIcon aria-hidden />
                    <span>Tasks</span>
                  </SidebarMenuButton>
                ) : (
                  <SidebarMenuButton
                    tooltip="Tasks — the board view of this workspace"
                    render={<a href={tasksHref} aria-label="Tasks" />}
                  >
                    <SquareKanbanIcon aria-hidden />
                    <span>Tasks</span>
                  </SidebarMenuButton>
                )}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <AppSidebarCollapseButton />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

/** `docs--<slug>.<base>` proxy hosts and `docs.<name>.<base>` custom domains
 * both have a tasks sibling; anything else (a dev tunnel, a direct vessel
 * hit) has none. */
function siblingTasksOrigin(hostname: string): string | null {
  if (/^docs--[^.]+\./.test(hostname)) return hostname.replace(/^docs--/, "tasks--");
  if (/^docs\.[^.]+\./.test(hostname)) return hostname.replace(/^docs\./, "tasks.");
  return null;
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

import { useEffect, useState } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  ChevronsLeft,
  ChevronsUpDown,
  FileTextIcon,
  Plus,
  SquareKanbanIcon,
} from "lucide-react";
import { IterateLogo } from "@iterate-com/ui/components/iterate-logo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@iterate-com/ui/components/dropdown-menu";
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
import { withDocsProject } from "../lib/docs-client.ts";

/**
 * The VIEWS a workspace can be seen through — the docs and tasks apps are
 * sibling lenses over the same workspace, so the sidebar switches between
 * them. Docs is this app; Tasks lives on the sibling project host
 * (`docs--<slug>` ↔ `tasks--<slug>`), carrying the current workspace along.
 * Composition follows the apps/os AppSidebar (shadcn sidebar blocks 07/08):
 * workspace-switcher dropdown in the header (the os project switcher, with
 * workspaces for projects), icon collapse, footer collapse button, rail.
 */
export function AppSidebar() {
  // The sidebar renders OUTSIDE any one route, so the router cannot type
  // this search value; the loose view is safe because `workspace` is read
  // as optional and only seeds the switcher + tasks-view link — absent (or
  // any other shape), both fall back to their home targets.
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
        <WorkspaceSwitcher workspacePath={workspacePath} />
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

/**
 * The os project switcher, one level down: the header dropdown names the
 * current workspace and switches between them. Workspace items land on the
 * home picker scoped to that workspace (picking a document is the next
 * step); New workspace mints an ephemeral scratch one and jumps straight
 * into its starter document.
 */
function WorkspaceSwitcher({ workspacePath }: { workspacePath: string | undefined }) {
  const navigate = useNavigate();
  const { isMobile } = useSidebar();
  const [workspaces, setWorkspaces] = useState<{ path: string; createdAt: string }[] | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void withDocsProject((project) => project.workspaces())
      .then((list) => {
        if (!cancelled) setWorkspaces(list);
      })
      // The header stays useful without the list (the home picker surfaces
      // the error); the dropdown just shows its loading row.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const createScratch = () => {
    setCreating(true);
    void withDocsProject((project) => project.createWorkspace())
      .then(({ workspacePath: created, path }) =>
        navigate({ to: "/", search: { workspace: created, path } }),
      )
      .finally(() => setCreating(false));
  };

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground"
              >
                <span className="flex aspect-square size-8 items-center justify-center rounded-md bg-black">
                  <IterateLogo className="size-6" />
                </span>
                <span className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">docs</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {workspacePath ?? "(select workspace)"}
                  </span>
                </span>
                <ChevronsUpDown className="ml-auto" />
              </SidebarMenuButton>
            }
          />
          <DropdownMenuContent
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
            className="min-w-56 rounded-lg"
          >
            <DropdownMenuGroup className="max-h-80 overflow-y-auto">
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Workspaces
              </DropdownMenuLabel>
              {workspaces === null ? (
                <DropdownMenuItem disabled className="p-2">
                  <span className="truncate">Loading…</span>
                </DropdownMenuItem>
              ) : workspaces.length === 0 ? (
                <DropdownMenuItem disabled className="p-2">
                  <span className="truncate">No workspaces yet</span>
                </DropdownMenuItem>
              ) : (
                workspaces.map((entry) => (
                  <DropdownMenuItem
                    key={entry.path}
                    className="gap-2 p-2"
                    render={<Link to="/" search={{ workspace: entry.path }} />}
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-md border text-xs font-medium text-muted-foreground">
                      {(entry.path.split("/").filter(Boolean).at(-1) ?? "?").slice(0, 1)}
                    </span>
                    <span className="truncate font-mono text-xs">{entry.path}</span>
                    {entry.path === workspacePath ? <Check className="ml-auto" /> : null}
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem disabled={creating} onClick={createScratch}>
                <Plus />
                <span>{creating ? "Creating…" : "New workspace"}</span>
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link to="/" search={{}} />}>
                <ArrowLeft />
                <span>View all workspaces</span>
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/** `docs--<slug>.<base>` proxy hosts and `docs.<name>.<base>` custom domains
 * both have a tasks sibling; anything else (a dev tunnel, a direct vessel
 * hit) has none. */
function siblingTasksOrigin(hostname: string): string | null {
  // The shared vessel host (docs.iterate.workers.dev) is NOT a project
  // custom domain — its tasks twin serves only a landing page.
  if (hostname.endsWith(".workers.dev")) return null;
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

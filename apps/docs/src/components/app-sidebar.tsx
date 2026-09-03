import { useRef, useState } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  ChevronsLeft,
  ChevronsUpDown,
  FileTextIcon,
  NotebookPenIcon,
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
import {
  DEFAULT_REPO_PATH,
  boardWorkspacePath,
  isBoardId,
  normalizeRepoPath,
} from "../lib/board-shared.ts";
import { CloseMobileSidebarOnNavigate } from "./close-mobile-sidebar-on-navigate.tsx";

/**
 * The VIEWS a workspace can be seen through — documents and the task board
 * are two lenses of THIS one app (the board is the /w route), so switching
 * views is plain navigation carrying the workspace along. Notes (/notes) is
 * the odd one out: scoped to a repo, not a workspace, so it carries only
 * the repo.
 * Composition follows the apps/os AppSidebar (shadcn sidebar blocks 07/08):
 * workspace-switcher dropdown in the header (the os project switcher, with
 * workspaces for projects), icon collapse, footer collapse button, rail.
 */
export function AppSidebar() {
  // The sidebar renders OUTSIDE any one route, so the router cannot type
  // this search value; the loose view is safe because both fields are read
  // as optional and only seed the switcher + view links — absent (or any
  // other shape), everything falls back to its home target.
  const location = useRouterState({ select: (state) => state.location });
  const search = location.search as { repo?: string; workspace?: string };
  const boardView = location.pathname.startsWith("/w");
  const notesView = location.pathname.startsWith("/notes");
  // An owned board (/w/<boardId>) carries no ?workspace= — its workspace
  // path is DERIVED from the id + repo, so derive it here too or the
  // switcher (and the Docs view link) would lose the workspace on the
  // board's main route.
  const boardId = decodeURIComponent(/^\/w\/([^/]+)/.exec(location.pathname)?.[1] ?? "");
  // /w's validated search supplies workspace as a STRING ("" on the board
  // home) — empty means unset here, or the switcher would wear a blank
  // label and the Docs link a dangling workspace=.
  const workspacePath =
    (search.workspace === "" ? undefined : search.workspace) ??
    (isBoardId(boardId)
      ? boardWorkspacePath(boardId, normalizeRepoPath(search.repo) ?? DEFAULT_REPO_PATH)
      : undefined);

  return (
    <>
      {/* Outside <Sidebar>: on mobile its children live inside a Sheet that
          remounts when opened — the same placement as apps/os. */}
      <CloseMobileSidebarOnNavigate />
      <Sidebar collapsible="icon">
        {/* Collapsed: nudge the logo down so its center lines up with the page
          header row — the same transition the os and tasks sidebars use. */}
        <SidebarHeader className="transition-[padding] group-data-[collapsible=icon]:pt-3">
          <WorkspaceSwitcher workspacePath={workspacePath} boardView={boardView} />
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>views</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={!boardView && !notesView}
                    tooltip="Docs — the document view of this workspace"
                    render={
                      <Link
                        to="/"
                        search={
                          workspacePath === undefined
                            ? {}
                            : { repo: search.repo, workspace: workspacePath }
                        }
                      />
                    }
                  >
                    <FileTextIcon aria-hidden />
                    <span>Docs</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={boardView}
                    tooltip="Tasks — the board view of this workspace"
                    render={
                      <Link
                        to="/w"
                        search={{
                          group: "folder",
                          q: "",
                          repo: search.repo ?? "",
                          task: "",
                          workspace: workspacePath ?? "",
                        }}
                      />
                    }
                  >
                    <SquareKanbanIcon aria-hidden />
                    <span>Tasks</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={notesView}
                    tooltip="Notes — plain files in the repo's notes folder"
                    render={<Link to="/notes" search={{ note: "", repo: search.repo ?? "" }} />}
                  >
                    <NotebookPenIcon aria-hidden />
                    <span>Notes</span>
                  </SidebarMenuButton>
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
    </>
  );
}

/**
 * The os project switcher, one level down: the header dropdown names the
 * current workspace and switches between them. Workspace items stay in the
 * CURRENT view — the docs picker scoped to that workspace, or the board on
 * it; New workspace mints an ephemeral scratch one and jumps straight into
 * its starter document.
 */
function WorkspaceSwitcher({
  workspacePath,
  boardView,
}: {
  workspacePath: string | undefined;
  boardView: boolean;
}) {
  const navigate = useNavigate();
  const { isMobile } = useSidebar();
  const [workspaces, setWorkspaces] = useState<{ path: string; createdAt: string }[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Fetched fresh on every menu open (the sidebar stays mounted for the
  // app's whole life, so a mount-time list goes stale the moment a scratch
  // workspace is minted or an agent births one): the previous list stays
  // rendered while the refresh is in flight, so only the first open shows
  // the loading row. A refresh failure keeps the last list; a FIRST-open
  // failure has no list to keep, so the error itself becomes the row —
  // never an eternal "Loading…".
  const [listError, setListError] = useState<string | null>(null);
  // Reopening while a fetch is in flight must not let the OLDER response
  // land last and hide a just-minted workspace — latest request wins.
  const listRequestRef = useRef(0);
  const loadWorkspaces = () => {
    const requestId = ++listRequestRef.current;
    setListError(null);
    void withDocsProject((project) => project.workspaces())
      .then((list) => {
        if (listRequestRef.current === requestId) setWorkspaces(list);
      })
      .catch((error: unknown) => {
        if (listRequestRef.current === requestId) {
          setListError(error instanceof Error ? error.message : String(error));
        }
      });
  };

  const createScratch = () => {
    setCreating(true);
    setCreateError(null);
    void withDocsProject((project) => project.createWorkspace())
      .then(({ workspacePath: created, path }) =>
        navigate({ to: "/", search: { workspace: created, path } }),
      )
      // The menu has closed by the time this settles — surface the failure
      // under the trigger, where the eye already is.
      .catch((error: unknown) => {
        setCreateError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setCreating(false));
  };

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) loadWorkspaces();
          }}
        >
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
            className="min-w-72 rounded-lg"
          >
            <DropdownMenuGroup className="max-h-80 overflow-y-auto">
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Workspaces
              </DropdownMenuLabel>
              {workspaces === null ? (
                <DropdownMenuItem disabled className="p-2">
                  <span className={listError === null ? "truncate" : "truncate text-red-700"}>
                    {listError ?? "Loading…"}
                  </span>
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
                    render={
                      boardView ? (
                        <Link
                          to="/w"
                          search={{
                            group: "folder",
                            q: "",
                            repo: "",
                            task: "",
                            workspace: entry.path,
                          }}
                        />
                      ) : (
                        <Link to="/" search={{ workspace: entry.path }} />
                      )
                    }
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
        {createError !== null && (
          <p className="px-2 pt-1 text-xs text-red-700 group-data-[collapsible=icon]:hidden">
            {createError}
          </p>
        )}
      </SidebarMenuItem>
    </SidebarMenu>
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

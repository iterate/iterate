// ONE shell for the os-next apps — agents, notes, voice, the dash next: the sidebar (the project
// switcher in its header, the app's own navigation in its body, the collapse button and the account
// menu in its footer, the rail) and the page beside it under a header row that carries the phone's
// sidebar trigger. apps/os's frame on this package's shadcn Sidebar. Router-agnostic on purpose:
// the app hands over hrefs and its current location, nothing from TanStack comes in here.
import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import { CheckIcon, ChevronsLeftIcon, ChevronsUpDownIcon, LogOutIcon } from "lucide-react";
import { Avatar, AvatarFallback } from "./avatar.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./dropdown-menu.tsx";
import { IterateLogo } from "./iterate-logo.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "./sidebar.tsx";

/** A project as the switcher lists it; `org` is the organization's name, when the app knows it. */
export type AppShellProject = { id: string; org?: string };

/** Frames a signed-in page. Client-only, like every page that frames itself in it: it reads the
 *  `sidebar_state` cookie shadcn's provider writes, so the sidebar reopens the way it was left. */
export function AppShell({
  app,
  projects,
  activeProjectId,
  projectHref,
  onNavigate,
  switcherActions,
  nav,
  header,
  account,
  accountActions,
  locationKey,
  children,
}: {
  /** the app's name, on top of the switcher: "Agents", "Notes", "Voice" */
  app: string;
  /** the projects this session lists; grouped by `org` when the app names one */
  projects: AppShellProject[];
  activeProjectId: string | null;
  /** where the app shows a project — a same-origin href; switching is a full navigation unless
   *  `onNavigate` takes it (an app with a client router prevents the default and navigates itself) */
  projectHref: (projectId: string) => string;
  onNavigate?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
  /** the app's own items at the end of the switcher menu — `DropdownMenuItem`s, after a separator */
  switcherActions?: ReactNode;
  /** the app's own navigation, its `SidebarGroup`s */
  nav?: ReactNode;
  /** what sits beside the phone's sidebar trigger in the header row */
  header?: ReactNode;
  /** the signed-in person; "Sign out" posts to `logoutPath`, the SDK's `/.auth/logout` unless told */
  account: { email: string; logoutPath?: string };
  /** the app's own items in the account menu, before Sign out — `DropdownMenuItem`s */
  accountActions?: ReactNode;
  /** the router's current href — a change closes the phone's sidebar sheet */
  locationKey: string;
  children: ReactNode;
}) {
  const defaultOpen = !document.cookie.split("; ").includes("sidebar_state=false");
  return (
    <SidebarProvider defaultOpen={defaultOpen} className="h-svh">
      {/* outside <Sidebar>: on a phone its children live in a Sheet that remounts when opened */}
      <CloseMobileSidebarOnNavigate locationKey={locationKey} />
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <ProjectSwitcher
            app={app}
            projects={projects}
            activeProjectId={activeProjectId}
            projectHref={projectHref}
            onNavigate={onNavigate}
            actions={switcherActions}
          />
        </SidebarHeader>
        <SidebarContent>{nav}</SidebarContent>
        <SidebarFooter>
          <CollapseButton />
          <AccountMenu
            email={account.email}
            logoutPath={account.logoutPath || "/.auth/logout"}
            actions={accountActions}
          />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="min-w-0 overflow-hidden">
        <header className="flex shrink-0 items-center gap-3 px-4 pt-2.5 pb-1">
          <SidebarTrigger className="-ml-1 md:hidden" />
          {header}
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}

/** Dismiss the mobile sidebar (a Sheet) when the page navigates — shadcn's Sidebar exposes
 *  `setOpenMobile` and does not do this itself. The whole href counts, not the pathname: the apps
 *  navigate by search string (`/agents?project=…&agent=…`). Only on an actual change, never on
 *  mount: the Sheet remounts its children when opened. */
function CloseMobileSidebarOnNavigate({ locationKey }: { locationKey: string }) {
  const { setOpenMobile } = useSidebar();
  const previousLocationKeyRef = useRef(locationKey);
  useEffect(() => {
    if (previousLocationKeyRef.current === locationKey) return;
    previousLocationKeyRef.current = locationKey;
    setOpenMobile(false);
  }, [locationKey, setOpenMobile]);
  return null;
}

function ProjectSwitcher({
  app,
  projects,
  activeProjectId,
  projectHref,
  onNavigate,
  actions,
}: {
  app: string;
  projects: AppShellProject[];
  activeProjectId: string | null;
  projectHref: (projectId: string) => string;
  onNavigate?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
  actions?: ReactNode;
}) {
  const { isMobile } = useSidebar();
  // one group per organization, in order of first appearance; a bare list when the app names none
  const orgs = [...new Set(projects.map((project) => project.org))];
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground"
                aria-label="Switch project"
              >
                <span className="flex aspect-square size-8 items-center justify-center rounded-md bg-black">
                  <IterateLogo alt="" className="size-6" />
                </span>
                <span className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{app}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {activeProjectId || "(select project)"}
                  </span>
                </span>
                <ChevronsUpDownIcon className="ml-auto" />
              </SidebarMenuButton>
            }
          />
          <DropdownMenuContent
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
            className="min-w-60 rounded-lg"
          >
            {projects.length === 0 ? (
              <DropdownMenuItem disabled className="p-2">
                No projects yet
              </DropdownMenuItem>
            ) : null}
            {orgs.map((org) => (
              <DropdownMenuGroup key={org || ""}>
                {/* Base UI: a menu label lives inside a group, never bare in the menu */}
                {org ? (
                  <DropdownMenuLabel className="text-xs text-muted-foreground">
                    {org}
                  </DropdownMenuLabel>
                ) : null}
                {projects
                  .filter((project) => project.org === org)
                  .map((project) => (
                    <DropdownMenuItem
                      key={project.id}
                      className="gap-2 p-2"
                      render={
                        <a
                          href={projectHref(project.id)}
                          aria-label={`Switch to ${project.id}`}
                          onClick={
                            onNavigate
                              ? (event) => onNavigate(projectHref(project.id), event)
                              : undefined
                          }
                        />
                      }
                    >
                      <span className="flex size-6 items-center justify-center rounded-md border text-xs font-medium text-muted-foreground">
                        {project.id.slice(0, 1)}
                      </span>
                      <span className="truncate">{project.id}</span>
                      {project.id === activeProjectId ? <CheckIcon className="ml-auto" /> : null}
                    </DropdownMenuItem>
                  ))}
              </DropdownMenuGroup>
            ))}
            {actions ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>{actions}</DropdownMenuGroup>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function CollapseButton() {
  const { state, toggleSidebar } = useSidebar();
  const collapsed = state === "collapsed";
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          type="button"
          size="sm"
          className="text-sidebar-foreground/70"
          tooltip={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={toggleSidebar}
        >
          <ChevronsLeftIcon className={collapsed ? "rotate-180" : undefined} />
          <span>Collapse sidebar</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/** The signed-in person, and sign out: a POST to the app's own logout, which ends this browser's
 *  grant at the issuer. */
function AccountMenu({
  email,
  logoutPath,
  actions,
}: {
  email: string;
  logoutPath: string;
  actions?: ReactNode;
}) {
  const { isMobile } = useSidebar();
  const logout = useRef<HTMLFormElement>(null);
  const initials = email.slice(0, 2).toUpperCase();
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground"
                aria-label="Account"
              >
                <Avatar className="size-8 rounded-lg">
                  <AvatarFallback className="rounded-lg">{initials}</AvatarFallback>
                </Avatar>
                <span className="truncate text-left text-sm font-medium">{email}</span>
                <ChevronsUpDownIcon className="ml-auto" />
              </SidebarMenuButton>
            }
          />
          <DropdownMenuContent
            className="min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            {/* Base UI: a menu label lives inside a group, never bare in the menu */}
            <DropdownMenuGroup>
              <DropdownMenuLabel className="truncate font-normal">{email}</DropdownMenuLabel>
              {actions}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => logout.current?.requestSubmit()}>
                <LogOutIcon />
                <span>Sign out</span>
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
      {/* the sign-out POST, outside the menu item so nothing but the item's click submits it */}
      <form ref={logout} method="post" action={logoutPath} hidden />
    </SidebarMenu>
  );
}

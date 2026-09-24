// The one shell for the client apps (agents, notes, voice, dash): the sidebar (the project
// switcher in its header, the app's own navigation in its body, the collapse button and the account
// menu in its footer, the rail) and the page beside it under a header row that carries the phone's
// sidebar trigger — and ⌘K, a palette over the projects and the sidebar's pages
// (app-shell-palette.tsx). Router-agnostic on purpose:
// the app hands over hrefs and its current location, nothing from TanStack comes in here.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
} from "react";
import { CheckIcon, ChevronsLeftIcon, ChevronsUpDownIcon, LogOutIcon } from "lucide-react";
import {
  AppShellPalette,
  PaletteHeaderButton,
  PaletteSidebarButton,
  usePaletteShortcut,
} from "./app-shell-palette.tsx";
import {
  plainLeftClick,
  readSidebarNav,
  type SidebarNavItem,
} from "./app-shell-palette-entries.ts";
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

/** A project as the switcher lists it; `org` is its organization, when the app knows it — grouped
 *  by the id (two organizations may share a name), labelled by the name. */
export type AppShellProject = { id: string; slug: string; org?: { id: string; name: string } };

/** Nothing to subscribe to: the cookie has no change event, and `SidebarProvider` reads
 *  `defaultOpen` once, when it mounts. */
const subscribeToNothing = () => () => {};

/** Frames a signed-in page. It reads the `sidebar_state` cookie shadcn's provider writes, so the
 *  sidebar reopens the way it was left — through `useSyncExternalStore`, which keeps the read out
 *  of render: a server render (no page frames itself here under SSR today) gets shadcn's default,
 *  open. */
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
  /** where the app shows a project (`/projects/<slug>` by convention) — a same-origin href;
   *  switching is a full navigation unless
   *  `onNavigate` takes it (an app with a client router prevents the default and navigates itself).
   *  Only a plain left click is handed over: a modified or middle click keeps the anchor's own
   *  behaviour (a new tab). */
  projectHref: (project: AppShellProject) => string;
  onNavigate?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
  /** the app's own items at the end of the switcher menu — `DropdownMenuItem`s, after a separator */
  switcherActions?: ReactNode;
  /** the app's own navigation, its `SidebarGroup`s */
  nav?: ReactNode;
  /** what sits beside the phone's sidebar trigger in the header row */
  header?: ReactNode;
  /** the signed-in person; "Sign out" posts to the SDK's `/.auth/logout` */
  account: { email: string };
  /** the app's own items in the account menu, before Sign out — `DropdownMenuItem`s */
  accountActions?: ReactNode;
  /** the router's current href — a change closes the phone's sidebar sheet */
  locationKey: string;
  children: ReactNode;
}) {
  const defaultOpen = useSyncExternalStore(
    subscribeToNothing,
    () => !document.cookie.split("; ").includes("sidebar_state=false"),
    () => true,
  );
  // the palette: the sidebar's navigation as it read when ⌘K opened it, null while closed
  const navRef = useRef<HTMLDivElement>(null);
  const [palette, setPalette] = useState<SidebarNavItem[] | null>(null);
  const openPalette = () => setPalette(readSidebarNav(navRef.current));
  usePaletteShortcut(
    useCallback(() => setPalette((open) => (open ? null : readSidebarNav(navRef.current))), []),
  );
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
          <PaletteSidebarButton onOpen={openPalette} />
        </SidebarHeader>
        {/* ⌘K lists what the sidebar shows here — on a desktop; a phone's lists the projects alone */}
        <SidebarContent ref={navRef}>{nav}</SidebarContent>
        <SidebarFooter>
          <CollapseButton />
          <AccountMenu email={account.email} actions={accountActions} />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="min-w-0 overflow-hidden">
        <header className="flex shrink-0 items-center gap-3 px-4 pt-2.5 pb-1">
          <SidebarTrigger className="-ml-1 md:hidden" />
          <PaletteHeaderButton onOpen={openPalette} />
          {header}
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">{children}</div>
      </SidebarInset>
      <AppShellPalette
        nav={palette}
        onClose={() => setPalette(null)}
        projects={projects}
        activeProjectId={activeProjectId}
        projectHref={projectHref}
        onNavigate={onNavigate}
      />
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
  projectHref: (project: AppShellProject) => string;
  onNavigate?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
  actions?: ReactNode;
}) {
  const { isMobile } = useSidebar();
  // one group per organization (by id), in order of first appearance; a bare list when the app
  // names none
  const orgs = [...new Map(projects.map((project) => [project.org?.id, project.org])).values()];
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
                    {projects.find((project) => project.id === activeProjectId)?.slug ||
                      "(select project)"}
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
              <DropdownMenuGroup key={org?.id || ""}>
                {/* Base UI: a menu label lives inside a group, never bare in the menu */}
                {org ? (
                  <DropdownMenuLabel className="text-xs text-muted-foreground">
                    {org.name}
                  </DropdownMenuLabel>
                ) : null}
                {projects
                  .filter((project) => project.org?.id === org?.id)
                  .map((project) => (
                    <DropdownMenuItem
                      key={project.id}
                      className="gap-2 p-2"
                      render={
                        <a
                          href={projectHref(project)}
                          aria-label={`Switch to ${project.slug}`}
                          onClick={
                            onNavigate
                              ? (event) => {
                                  if (!plainLeftClick(event)) return;
                                  onNavigate(projectHref(project), event);
                                }
                              : undefined
                          }
                        />
                      }
                    >
                      <span className="flex size-6 items-center justify-center rounded-md border text-xs font-medium text-muted-foreground">
                        {project.slug.slice(0, 1)}
                      </span>
                      <span className="truncate">{project.slug}</span>
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
function AccountMenu({ email, actions }: { email: string; actions?: ReactNode }) {
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
      <form ref={logout} method="post" action="/.auth/logout" hidden />
    </SidebarMenu>
  );
}

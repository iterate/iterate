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
  type RefObject,
} from "react";
import {
  CheckIcon,
  ChevronsLeftIcon,
  ChevronsUpDownIcon,
  EyeIcon,
  LogOutIcon,
  UsersIcon,
} from "lucide-react";
import type { Principal } from "iterate/principal";
import {
  AppShellPalette,
  PaletteHeaderButton,
  PaletteSidebarButton,
  subscribeToNothing,
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
import { resetPosthog } from "./posthog.tsx";

/** A project as the switcher lists it; `org` is its organization, when the app knows it — grouped
 *  by the id (two organizations may share a name), labelled by the name. */
export type AppShellProject = { id: string; slug: string; org?: { id: string; name: string } };

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
  /** who the app is signed in as (`info.principal`); "Sign out" posts to the SDK's `/.auth/logout`,
   *  "Switch account…" signs in again through the issuer's consent. A platform admin signed in as
   *  someone (`impersonatedBy`) sees whom and who they are, above the account menu, with Stop
   *  impersonating, which signs in again the same way (the issuer still knows them). */
  account: Principal;
  /** the app's own items in the account menu, before Sign out — `DropdownMenuItem`s */
  accountActions?: ReactNode;
  /** the router's current href — a change closes the phone's sidebar sheet */
  locationKey: string;
  children: ReactNode;
}) {
  // nothing to subscribe to: the cookie has no change event, and `SidebarProvider` reads
  // `defaultOpen` once, when it mounts
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
        <SidebarNav navRef={navRef}>{nav}</SidebarNav>
        <SidebarFooter>
          <CollapseButton />
          {account.impersonatedBy ? (
            <ImpersonationMarker
              email={account.email || account.actor}
              admin={account.impersonatedBy.email}
            />
          ) : null}
          <AccountMenu email={account.email || account.actor} actions={accountActions} />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="min-w-0 overflow-hidden">
        <header className="flex shrink-0 items-center gap-3 px-4 pt-2.5 pb-1">
          <SidebarTrigger className="-ml-1 md:hidden" title="Toggle sidebar" />
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

/** The app's navigation. On a phone, a same-tab link click in it closes the sidebar sheet at once,
 *  as the navigation starts; shadcn leaves it open (https://github.com/shadcn-ui/ui/issues/5561),
 *  and `CloseMobileSidebarOnNavigate` only fires once the location has changed. A modified or
 *  middle click, a download, or a link to another tab leaves the sheet open, as does a button (the
 *  collapse button, a dropdown trigger). This used to live in the vendored sidebar.tsx's
 *  SidebarMenuButton (#1984); a vendored file stays byte-identical to upstream
 *  (packages/ui/AGENTS.md). */
function SidebarNav({
  navRef,
  children,
}: {
  navRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <SidebarContent
      ref={navRef}
      onClick={(event) => {
        if (!isMobile) return;
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
        if (!link || !event.currentTarget.contains(link) || link.hasAttribute("download")) return;
        const target = link.getAttribute("target");
        if (target && target !== "_self") return;
        setOpenMobile(false);
      }}
    >
      {children}
    </SidebarContent>
  );
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

/** SIGN IN AGAIN, through the issuer: the app's own logout (ends this sign-in's grant), then its
 *  login with the same permissions (app-server.ts), which finds the person still signed in at the
 *  issuer and shows its consent — where a platform admin may "Sign in as someone else…" — and lands
 *  on the app's root (not the page shown: it is often another person's project). */
const SIGN_IN_AGAIN = `/.auth/logout?${new URLSearchParams({ next: "/.auth/login?next=/" })}`;

/** SIGNED IN AS SOMEONE ELSE, unmissable: whom, who you are, and Stop — signing in again as
 *  yourself (`SIGN_IN_AGAIN`). A collapsed sidebar keeps the eye. */
function ImpersonationMarker({ email, admin }: { email: string; admin: string }) {
  return (
    <form
      method="post"
      action={SIGN_IN_AGAIN}
      role="status"
      className="flex flex-col gap-1.5 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950 group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:p-1.5"
    >
      <div className="flex items-center gap-2">
        <EyeIcon className="size-4 shrink-0" aria-label="Signed in as someone else" />
        <span className="min-w-0 truncate group-data-[collapsible=icon]:hidden">
          Signed in as <strong className="font-semibold">{email}</strong>
        </span>
      </div>
      <span className="truncate text-amber-800 group-data-[collapsible=icon]:hidden">
        You are {admin}
      </span>
      <button
        type="submit"
        className="rounded-md bg-amber-900 px-2 py-1 font-medium text-amber-50 hover:bg-amber-800 group-data-[collapsible=icon]:hidden"
      >
        Stop impersonating
      </button>
    </form>
  );
}

/** The signed-in person; Switch account… (`SIGN_IN_AGAIN`); and sign out: a POST to the app's own
 *  logout, which ends this browser's grant at the issuer. */
function AccountMenu({ email, actions }: { email: string; actions?: ReactNode }) {
  const { isMobile } = useSidebar();
  const logout = useRef<HTMLFormElement>(null);
  const switchAccount = useRef<HTMLFormElement>(null);
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
              <DropdownMenuItem onClick={() => switchAccount.current?.requestSubmit()}>
                <UsersIcon />
                <span>Switch account…</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  resetPosthog();
                  logout.current?.requestSubmit();
                }}
              >
                <LogOutIcon />
                <span>Sign out</span>
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
      {/* the POSTs, outside the menu items so nothing but an item's click submits one */}
      <form ref={switchAccount} method="post" action={SIGN_IN_AGAIN} hidden />
      <form ref={logout} method="post" action="/.auth/logout" hidden />
    </SidebarMenu>
  );
}

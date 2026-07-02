import { useMemo, useState, type ReactElement } from "react";
import { Link, useMatches, useMatchRoute } from "@tanstack/react-router";
import {
  ArrowLeft,
  Bug,
  Check,
  ChevronsLeft,
  ChevronsUpDown,
  MessageCircle,
  ExternalLink,
  GitBranch,
  KeyRound,
  LogOut,
  Plug,
  Plus,
  Radio,
  ScrollText,
  Settings2,
  Shield,
  SquarePen,
  SquareTerminal,
  UserCircle,
  type LucideIcon,
} from "lucide-react";
import { EventsStreamPathLabel } from "@iterate-com/ui/components/events/stream-path-label";
import type { PublicAppConfig } from "@iterate-com/shared/config";
import { useAuthClient } from "@iterate-com/auth/client";
import { useConfig } from "@iterate-com/ui/apps/config";
import { useQuery } from "@tanstack/react-query";
import { Avatar, AvatarFallback } from "@iterate-com/ui/components/avatar";
import { Button } from "@iterate-com/ui/components/button";
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
import { ScrollArea } from "@iterate-com/ui/components/scroll-area";
import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@iterate-com/ui/components/sheet";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from "@iterate-com/ui/components/sidebar";
import { StreamPath, type StreamPath as StreamPathType } from "~/lib/stream-links.ts";
import type { AppConfig } from "~/config.ts";
import { buildProjectWorkerUrl } from "~/lib/project-host-routing.ts";
import {
  fetchProjectsList,
  projectsListQueryKey,
  projectsListStaleTime,
} from "~/lib/projects-query.ts";
import type { ProjectListEntry } from "~/types.ts";
import type { PublicRouteConfig } from "~/lib/public-route-config.ts";

type PublicConfig = PublicAppConfig<AppConfig>;

export function AppSidebar({ routeConfig }: { routeConfig: PublicRouteConfig }) {
  // Client-only read through the itx session (itx never SSRs): the sidebar
  // renders empty during SSR and populates after hydration. Plain useQuery —
  // not the suspending useItxQuery — so the always-mounted shell never
  // suspends on the socket.
  const { data } = useQuery({
    queryKey: projectsListQueryKey,
    queryFn: fetchProjectsList,
    staleTime: projectsListStaleTime,
  });
  // Missing projects (auth knows them, this deployment's engine does not) are
  // not navigable — the /projects page owns setting them up.
  const projects = data?.filter((project) => project.deploymentStatus !== "missing") ?? [];

  // Sidebar composition follows shadcn sidebar blocks 07/08:
  // https://ui.shadcn.com/blocks/sidebar
  return (
    <Sidebar collapsible="icon">
      {/* Collapsed: nudge the logo down 4px (pt-2 → pt-3) so its center lines up
          with the stream path pill in the page header (h-9 pill, pt-2.5 → center 28px).
          Transition padding with Tailwind's default timing — the same curve the
          SidebarMenuButton uses for its width/height/padding — so the padding offset
          and the button's height change move the logo together instead of drifting. */}
      <SidebarHeader className="transition-[padding] group-data-[collapsible=icon]:pt-3">
        <AppSidebarHeader projects={projects} />
      </SidebarHeader>
      <SidebarContent>
        <AppSidebarNav routeConfig={routeConfig} />
      </SidebarContent>
      <SidebarFooter>
        <AppSidebarCollapseButton />
        <AppSidebarUser />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function AppSidebarHeader({ projects }: { projects: ProjectListEntry[] }) {
  const matches = useMatches();
  const { isMobile } = useSidebar();
  const activeProjectSlug = getActiveProjectSlug(matches);
  const headerDescription = activeProjectSlug ?? "(select project)";

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
                  <IterateLogo className="size-6 rounded-sm" />
                </span>
                <span className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">iterate</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {headerDescription}
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
            <DropdownMenuGroup>
              <DropdownMenuLabel className="flex items-center justify-between pr-1 text-xs text-muted-foreground">
                Projects
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="New project"
                  render={<Link to="/new-project" />}
                >
                  <Plus />
                </Button>
              </DropdownMenuLabel>
              {projects.length > 0 ? (
                projects.map((project) => (
                  <DropdownMenuItem
                    key={project.id}
                    className="gap-2 p-2"
                    render={
                      <Link
                        to="/projects/$projectSlug/agents/new"
                        params={{ projectSlug: project.slug }}
                      />
                    }
                  >
                    <span className="flex size-6 items-center justify-center rounded-md border text-xs font-medium text-muted-foreground">
                      {project.slug.slice(0, 1).toLowerCase()}
                    </span>
                    <span className="truncate">{project.slug}</span>
                    {project.slug === activeProjectSlug ? <Check className="ml-auto" /> : null}
                  </DropdownMenuItem>
                ))
              ) : (
                <DropdownMenuItem disabled className="p-2">
                  <span className="truncate">No projects yet</span>
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem render={<Link to="/projects" />}>
                <ArrowLeft />
                <span>View all projects</span>
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
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

function AppSidebarUser() {
  const { loading, session, signOut } = useAuthClient();
  const { isMobile } = useSidebar();
  const config = useConfig<PublicConfig>();
  const accountManagementUrl = authWorkerUrl(config, "/");
  const [debugOpen, setDebugOpen] = useState(false);
  const user = session?.authenticated ? session.user : null;
  const isAdmin = user?.isAdmin ?? false;
  const label = [user?.name, user?.email, "Account"].find((value) => value?.trim())?.trim() ?? "";
  const email = user?.email?.trim() ?? "";
  const initials = userInitials(label);
  const debugInfo = useMemo(
    () => ({
      auth: {
        loading,
        session,
      },
      config,
      browser:
        typeof window === "undefined"
          ? null
          : {
              href: window.location.href,
              origin: window.location.origin,
              pathname: window.location.pathname,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              userAgent: window.navigator.userAgent,
            },
    }),
    [config, loading, session],
  );

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <SidebarMenuButton
                  size="lg"
                  className="data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground"
                >
                  <Avatar className="size-8 rounded-lg">
                    <AvatarFallback className="rounded-lg">{initials}</AvatarFallback>
                  </Avatar>
                  <span className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{label}</span>
                    {email ? <span className="truncate text-xs">{email}</span> : null}
                  </span>
                  <ChevronsUpDown className="ml-auto" />
                </SidebarMenuButton>
              }
            />
            <DropdownMenuContent
              className="min-w-56 rounded-lg"
              side={isMobile ? "bottom" : "right"}
              align="end"
              sideOffset={4}
            >
              <div className="p-0 font-normal">
                <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                  <Avatar className="size-8 rounded-lg">
                    <AvatarFallback className="rounded-lg">{initials}</AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{label}</span>
                    {email ? <span className="truncate text-xs">{email}</span> : null}
                  </div>
                </div>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem
                  render={
                    <a href={accountManagementUrl}>
                      <UserCircle />
                      <span>Manage account</span>
                      <ExternalLink className="ml-auto" />
                    </a>
                  }
                />
                {isAdmin && (
                  <DropdownMenuItem render={<Link to="/admin" />}>
                    <Shield />
                    <span>Admin</span>
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => setDebugOpen(true)}>
                  <Bug />
                  <span>View debug info</span>
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={() => void signOut()}>
                  <LogOut />
                  <span>Sign out</span>
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

      <Sheet open={debugOpen} onOpenChange={setDebugOpen}>
        <SheetContent className="w-full gap-0 data-[side=right]:sm:w-[min(92vw,44rem)] data-[side=right]:sm:max-w-[min(92vw,44rem)]">
          <SheetHeader className="border-b px-4 py-3 pr-14">
            <SheetTitle>Debug info</SheetTitle>
            <SheetDescription>
              Current client session, app config, and browser context.
            </SheetDescription>
          </SheetHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="p-4">
              <SerializedObjectCodeBlock
                data={debugInfo}
                className="min-h-[calc(100svh-8rem)]"
                initialFormat="json"
                showToggle
              />
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </>
  );
}

function userInitials(label: string) {
  const parts = label
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const initials = parts
    .slice(0, 2)
    .map((part) => part.at(0))
    .join("")
    .toUpperCase();
  return initials || "I";
}

function authWorkerUrl(config: PublicConfig, path: string) {
  const origin = authWorkerOrigin(config);
  return new URL(path, `${origin}/`).toString();
}

function authWorkerOrigin(config: PublicConfig) {
  const issuer = config.iterateAuth?.issuer;
  if (issuer) {
    try {
      return new URL(issuer).origin;
    } catch {
      // Fall through to the production auth origin.
    }
  }
  return "https://auth.iterate.com";
}

function AppSidebarNav({ routeConfig }: { routeConfig: PublicRouteConfig }) {
  const matchRoute = useMatchRoute();
  const matches = useMatches();
  const activeProjectSlug = getActiveProjectSlug(matches);

  // Drive the project nav from the active route slug, not list membership, so a valid
  // project that isn't in the cached list still shows its nav.
  if (activeProjectSlug) {
    return (
      <ProjectSidebarGroup
        // Custom hostnames don't exist yet (task #13): the list carries none.
        customHostname={null}
        projectSlug={activeProjectSlug}
        projectHostnameBases={routeConfig.projectHostnameBases}
        appBaseUrl={routeConfig.baseUrl}
      />
    );
  }

  return (
    <>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Projects"
                render={<Link to="/projects" />}
                isActive={Boolean(
                  matchRoute({
                    to: "/projects",
                    fuzzy: false,
                  }),
                )}
              >
                <ScrollText />
                <span>Projects</span>
              </SidebarMenuButton>
              {/* No per-project sub-list here: the switcher and the /projects
                  page own project navigation, and duplicate slug-named links
                  break the Playwright specs' strict-mode locators. */}
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      <SidebarSeparator />
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Repl"
                render={<Link to="/itx-repl" />}
                isActive={Boolean(matchRoute({ to: "/itx-repl", fuzzy: false }))}
              >
                <SquareTerminal />
                <span>Repl</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  );
}

function getActiveProjectSlug(matches: ReturnType<typeof useMatches>) {
  return matches
    .map((match) => match.params)
    .map((params) =>
      typeof params === "object" && params && "projectSlug" in params
        ? params.projectSlug
        : undefined,
    )
    .filter((projectSlug): projectSlug is string => typeof projectSlug === "string")
    .at(-1);
}

function ProjectSidebarGroup({
  customHostname,
  projectHostnameBases,
  projectSlug,
  appBaseUrl,
}: {
  customHostname: string | null;
  projectHostnameBases: readonly string[];
  projectSlug: string;
  appBaseUrl?: string;
}) {
  const matchRoute = useMatchRoute();
  const isNewChatActive = Boolean(
    matchRoute({
      to: "/projects/$projectSlug/agents/new",
      params: { projectSlug },
      fuzzy: false,
    }),
  );
  const customWorkerUrl = buildProjectWorkerUrl({
    projectSlug,
    customHostname,
    projectHostnameBases,
    appBaseUrl,
  });

  return (
    <>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <ProjectSidebarMenuItem
              icon={SquarePen}
              label="New Chat"
              render={<Link to="/projects/$projectSlug/agents/new" params={{ projectSlug }} />}
              isActive={isNewChatActive}
            />
            <ProjectSidebarMenuItem
              icon={Settings2}
              label="Settings"
              render={<Link to="/projects/$projectSlug" params={{ projectSlug }} />}
              isActive={Boolean(
                matchRoute({
                  to: "/projects/$projectSlug",
                  params: { projectSlug },
                  fuzzy: false,
                }),
              )}
            />
            <ProjectSidebarMenuItem
              icon={SquareTerminal}
              label="Repl"
              render={<Link to="/projects/$projectSlug/repl" params={{ projectSlug }} />}
              isActive={Boolean(
                matchRoute({
                  to: "/projects/$projectSlug/repl",
                  params: { projectSlug },
                  fuzzy: false,
                }),
              )}
            />
            {customWorkerUrl ? (
              <ProjectSidebarMenuItem
                icon={ExternalLink}
                label="Homepage"
                render={
                  <a
                    aria-label={`Open ${projectSlug} project homepage`}
                    href={customWorkerUrl}
                    target="_blank"
                    rel="noreferrer"
                  />
                }
                isActive={false}
              />
            ) : (
              <ProjectSidebarMenuItem icon={ExternalLink} label="Homepage" disabled />
            )}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      <SidebarSeparator />
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            {PROJECT_STREAM_NAV_ITEMS.map((item) => {
              const itemActive = Boolean(
                matchRoute({
                  to: item.to,
                  params: { projectSlug },
                  fuzzy: item.fuzzy,
                }),
              );

              return (
                <ProjectStreamNavItem
                  key={item.label}
                  icon={item.icon}
                  isActive={
                    item.to === "/projects/$projectSlug/agents" && isNewChatActive
                      ? false
                      : itemActive
                  }
                  label={item.label}
                  projectSlug={projectSlug}
                  streamPath={item.streamPath}
                  to={item.to}
                />
              );
            })}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  );
}

type ProjectStreamNavItemConfig = {
  fuzzy: boolean;
  icon: LucideIcon;
  label: string;
  streamPath: StreamPathType;
  to:
    | "/projects/$projectSlug/agents"
    | "/projects/$projectSlug/integrations"
    | "/projects/$projectSlug/secrets"
    | "/projects/$projectSlug/repos"
    | "/projects/$projectSlug/streams";
};

const PROJECT_STREAM_NAV_ITEMS: readonly ProjectStreamNavItemConfig[] = [
  {
    fuzzy: true,
    icon: MessageCircle,
    label: "/agents",
    streamPath: StreamPath.parse("/agents"),
    to: "/projects/$projectSlug/agents",
  },
  {
    fuzzy: false,
    icon: Plug,
    label: "/integrations",
    streamPath: StreamPath.parse("/integrations"),
    to: "/projects/$projectSlug/integrations",
  },
  {
    fuzzy: true,
    icon: KeyRound,
    label: "/secrets",
    streamPath: StreamPath.parse("/secrets"),
    to: "/projects/$projectSlug/secrets",
  },
  {
    fuzzy: true,
    icon: GitBranch,
    label: "/repos",
    streamPath: StreamPath.parse("/repos"),
    to: "/projects/$projectSlug/repos",
  },
  {
    fuzzy: true,
    icon: Radio,
    label: "/streams",
    streamPath: StreamPath.parse("/streams"),
    to: "/projects/$projectSlug/streams",
  },
  // TODO(itx-v4 cutover): the /mcp page returns when the inbound MCP surface does.
];

function ProjectStreamNavItem({
  icon: Icon,
  isActive,
  label,
  projectSlug,
  streamPath,
  to,
}: {
  icon: LucideIcon;
  isActive: boolean;
  label: string;
  projectSlug: string;
  streamPath: StreamPathType;
  to: ProjectStreamNavItemConfig["to"];
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        render={<Link to={to} params={{ projectSlug }} />}
        isActive={isActive}
        tooltip={label}
      >
        <Icon />
        <EventsStreamPathLabel className="text-xs" label={label} path={streamPath} />
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function ProjectSidebarMenuItem({
  disabled = false,
  icon: Icon,
  isActive,
  label,
  render,
}: {
  disabled?: boolean;
  icon: LucideIcon;
  isActive?: boolean;
  label: string;
  render?: ReactElement;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton disabled={disabled} render={render} isActive={isActive} tooltip={label}>
        <Icon />
        <span>{label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

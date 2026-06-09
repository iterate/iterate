import { useMemo, useState, type ReactElement } from "react";
import { Link, useMatches, useMatchRoute } from "@tanstack/react-router";
import {
  ArrowLeft,
  Bug,
  Check,
  ChevronsUpDown,
  ExternalLink,
  LogOut,
  UserCircle,
} from "lucide-react";
import type { PublicAppConfig } from "@iterate-com/shared/apps/config";
import { useAuthClient } from "@iterate-com/auth/client";
import { useConfig } from "@iterate-com/ui/apps/config";
import { useQuery } from "@tanstack/react-query";
import { Avatar, AvatarFallback } from "@iterate-com/ui/components/avatar";
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
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@iterate-com/ui/components/sidebar";
import { SidebarShell } from "@iterate-com/ui/components/sidebar-shell";
import type { AppConfig } from "~/app.ts";
import { buildProjectMcpUrl, buildProjectWorkerUrl } from "~/lib/project-host-routing.ts";
import { projectsListQueryOptions } from "~/lib/project-route-query.ts";
import type { PublicRouteConfig } from "~/lib/public-route-config.ts";

type PublicConfig = PublicAppConfig<AppConfig>;

type AppSidebarProps = {
  routeConfig: PublicRouteConfig;
};

export function AppSidebar({ routeConfig }: AppSidebarProps) {
  return (
    <SidebarShell header={<AppSidebarHeader />} footer={<AppSidebarUser />}>
      <AppSidebarNav routeConfig={routeConfig} />
    </SidebarShell>
  );
}

function AppSidebarHeader() {
  const matches = useMatches();
  const { isMobile } = useSidebar();
  const { data } = useQuery(projectsListQueryOptions({ limit: 100, offset: 0 }));
  const projects =
    data?.projects.filter((project) => !project.isOrphanedProjectFromAuthService) ?? [];
  const activeProjectSlug = getActiveProjectSlug(matches);
  const activeProject = projects.find((project) => project.slug === activeProjectSlug);
  const headerDescription = activeProject?.slug ?? "(select project)";

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
                <span className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sm font-semibold text-sidebar-primary-foreground">
                  i
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
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Projects
              </DropdownMenuLabel>
              {projects.length > 0 ? (
                projects.map((project) => (
                  <DropdownMenuItem
                    key={project.id}
                    className="gap-2 p-2"
                    render={
                      <Link to="/projects/$projectSlug" params={{ projectSlug: project.slug }} />
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
          </DropdownMenuContent>
        </DropdownMenu>
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
  const label = nonEmptyLabel(user?.name, user?.email, "Account");
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
              <DropdownMenuLabel className="p-0 font-normal">
                <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                  <Avatar className="size-8 rounded-lg">
                    <AvatarFallback className="rounded-lg">{initials}</AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{label}</span>
                    {email ? <span className="truncate text-xs">{email}</span> : null}
                  </div>
                </div>
              </DropdownMenuLabel>
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

function nonEmptyLabel(...values: Array<string | null | undefined>) {
  return values.find((value) => value?.trim())?.trim() ?? "";
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
  const { data } = useQuery(projectsListQueryOptions({ limit: 100, offset: 0 }));
  const projects =
    data?.projects.filter((project) => !project.isOrphanedProjectFromAuthService) ?? [];
  const activeProjectSlug = getActiveProjectSlug(matches);
  const activeProject = projects.find((project) => project.slug === activeProjectSlug);

  if (activeProject) {
    return (
      <ProjectSidebarGroup
        customHostname={activeProject.customHostname}
        mcpBaseUrl={routeConfig.mcpBaseUrl}
        projectSlug={activeProject.slug}
        baseUrl={routeConfig.baseUrl}
        projectHostnameBases={routeConfig.projectHostnameBases}
      />
    );
  }

  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link to="/projects" />}
              isActive={Boolean(
                matchRoute({
                  to: "/projects",
                  fuzzy: false,
                }),
              )}
            >
              <span>Projects</span>
            </SidebarMenuButton>
            <SidebarMenuSub>
              {projects.map((project) => (
                <SidebarMenuSubItem key={project.id}>
                  <SidebarMenuSubButton
                    isActive={Boolean(
                      matchRoute({
                        to: "/projects/$projectSlug",
                        params: { projectSlug: project.slug },
                        fuzzy: true,
                      }),
                    )}
                    render={
                      <Link to="/projects/$projectSlug" params={{ projectSlug: project.slug }} />
                    }
                  >
                    <span>{project.slug}</span>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              ))}
            </SidebarMenuSub>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link to="/capnweb-repl" />}
              isActive={Boolean(matchRoute({ to: "/capnweb-repl", fuzzy: false }))}
            >
              <span>Repl</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
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
  baseUrl,
  customHostname,
  mcpBaseUrl,
  projectHostnameBases,
  projectSlug,
}: {
  baseUrl?: string;
  customHostname: string | null;
  mcpBaseUrl?: string;
  projectHostnameBases: readonly string[];
  projectSlug: string;
}) {
  const matchRoute = useMatchRoute();
  const mcpUrl = buildProjectMcpUrl({ baseUrl, mcpBaseUrl, projectSlug, projectHostnameBases });
  const customWorkerUrl = buildProjectWorkerUrl({
    projectSlug,
    customHostname,
    projectHostnameBases,
  });

  return (
    <>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            {PROJECT_SIDEBAR_ITEMS.map((item) => (
              <ProjectSidebarMenuItem
                key={item.label}
                label={item.label}
                render={<Link to={item.to} params={{ projectSlug }} />}
                isActive={Boolean(
                  matchRoute({
                    to: item.to,
                    params: { projectSlug },
                    fuzzy: item.fuzzy,
                  }),
                )}
              />
            ))}
            {mcpUrl ? (
              <ProjectSidebarMenuItem
                label="MCP"
                render={<Link to="/projects/$projectSlug/mcp" params={{ projectSlug }} />}
                isActive={Boolean(
                  matchRoute({
                    to: "/projects/$projectSlug/mcp",
                    params: { projectSlug },
                  }),
                )}
              />
            ) : null}
            <ProjectSidebarMenuItem
              label="Streams"
              render={<Link to="/projects/$projectSlug/streams" params={{ projectSlug }} />}
              isActive={Boolean(
                matchRoute({
                  to: "/projects/$projectSlug/streams",
                  params: { projectSlug },
                  fuzzy: true,
                }),
              )}
            />
            <ProjectSidebarMenuItem
              label="Settings"
              render={<Link to="/projects/$projectSlug/settings" params={{ projectSlug }} />}
              isActive={Boolean(
                matchRoute({
                  to: "/projects/$projectSlug/settings",
                  params: { projectSlug },
                }),
              )}
            />
            {customWorkerUrl ? (
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={
                    <a
                      aria-label={`Open ${projectSlug} custom worker`}
                      href={customWorkerUrl}
                      target="_blank"
                      rel="noreferrer"
                    />
                  }
                >
                  <ExternalLink />
                  <span>Custom worker</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ) : null}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      <SidebarGroup className="mt-auto">
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="sm"
                className="text-sidebar-foreground/70"
                render={<Link to="/projects" />}
              >
                <ArrowLeft />
                <span>View all projects</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  );
}

const PROJECT_SIDEBAR_ITEMS = [
  {
    fuzzy: false,
    label: "Home",
    to: "/projects/$projectSlug",
  },
  {
    fuzzy: true,
    label: "Agents",
    to: "/projects/$projectSlug/agents",
  },
  {
    fuzzy: true,
    label: "Codemode Sessions",
    to: "/projects/$projectSlug/codemode-sessions",
  },
  {
    fuzzy: true,
    label: "Repos",
    to: "/projects/$projectSlug/repos",
  },
  {
    fuzzy: true,
    label: "Secrets",
    to: "/projects/$projectSlug/secrets",
  },
  {
    fuzzy: false,
    label: "Repl",
    to: "/projects/$projectSlug/repl",
  },
  {
    fuzzy: false,
    label: "Examples",
    to: "/projects/$projectSlug/examples",
  },
  {
    fuzzy: false,
    label: "Integrations",
    to: "/projects/$projectSlug/integrations",
  },
] as const;

function ProjectSidebarMenuItem({
  isActive,
  label,
  render,
}: {
  isActive: boolean;
  label: string;
  render: ReactElement;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton render={render} isActive={isActive}>
        <span>{label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

import { useMemo, useState, type ReactElement } from "react";
import { Link, useMatches, useMatchRoute } from "@tanstack/react-router";
import {
  ArrowLeft,
  Bug,
  Check,
  ChevronsUpDown,
  ExternalLink,
  LogOut,
  Plus,
  UserCircle,
} from "lucide-react";
import type { PublicAppConfig } from "@iterate-com/shared/apps/config";
import { useAuthClient } from "@iterate-com/auth/client";
import { useConfig } from "@iterate-com/ui/apps/config";
import { useQuery } from "@tanstack/react-query";
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
              <SidebarMenuButton className="h-12 gap-2 data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-xs font-semibold text-sidebar-primary-foreground">
                  i
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">iterate</span>
                  <span className="block truncate text-xs font-normal text-muted-foreground">
                    {headerDescription}
                  </span>
                </span>
                <ChevronsUpDown className="ml-auto size-4" />
              </SidebarMenuButton>
            }
          />
          <DropdownMenuContent side="bottom" align="start" className="w-60">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                Projects
              </DropdownMenuLabel>
              {projects.length > 0 ? (
                projects.map((project) => (
                  <DropdownMenuItem
                    key={project.id}
                    className="gap-2"
                    render={
                      <Link to="/projects/$projectSlug" params={{ projectSlug: project.slug }} />
                    }
                  >
                    <span
                      aria-hidden="true"
                      className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40"
                    />
                    <span className="truncate">{project.slug}</span>
                    {project.slug === activeProjectSlug ? <Check className="ml-auto" /> : null}
                  </DropdownMenuItem>
                ))
              ) : (
                <DropdownMenuItem disabled>
                  <span className="truncate text-muted-foreground">No projects yet</span>
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="gap-2 text-muted-foreground"
                render={<Link to="/projects/new" />}
              >
                <Plus />
                <span>New project</span>
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function AppSidebarUser() {
  const { loading, session, signOut } = useAuthClient();
  const config = useConfig<PublicConfig>();
  const accountManagementUrl = authWorkerUrl(config, "/");
  const [debugOpen, setDebugOpen] = useState(false);
  const user = session?.authenticated ? session.user : null;
  const label = nonEmptyLabel(user?.name, user?.email, "Account");
  const email = user?.email?.trim() ?? "";
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
                <SidebarMenuButton className="h-12 gap-2 data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground">
                  <UserCircle className="size-4" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{label}</span>
                    {email ? (
                      <span className="block truncate text-xs font-normal text-muted-foreground">
                        {email}
                      </span>
                    ) : null}
                  </span>
                  <ChevronsUpDown className="ml-auto size-4" />
                </SidebarMenuButton>
              }
            />
            <DropdownMenuContent side="top" align="start" className="w-56">
              <DropdownMenuGroup>
                <DropdownMenuLabel>
                  <span className="block truncate text-foreground">{label}</span>
                  {email ? (
                    <span className="block truncate text-xs font-normal text-muted-foreground">
                      {email}
                    </span>
                  ) : null}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem render={<a href={accountManagementUrl} />}>
                  <UserCircle />
                  <span>Manage account</span>
                  <ExternalLink className="ml-auto" />
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setDebugOpen(true)}>
                  <Bug />
                  <span>View debug info</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
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
                  fuzzy: true,
                }),
              )}
            >
              <span>View all projects</span>
            </SidebarMenuButton>
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
      <SidebarGroup className="mt-auto pt-0">
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="sm"
                className="text-xs text-muted-foreground hover:text-sidebar-accent-foreground"
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

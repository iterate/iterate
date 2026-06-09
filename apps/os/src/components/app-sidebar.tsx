import { useMemo, useState } from "react";
import { Link, useMatchRoute } from "@tanstack/react-router";
import { Bug, Building2, ChevronsUpDown, ExternalLink, LogOut, UserCircle } from "lucide-react";
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
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@iterate-com/ui/components/sidebar";
import { SidebarShell } from "@iterate-com/ui/components/sidebar-shell";
import type { AppConfig } from "~/app.ts";
import { buildProjectMcpUrl, buildProjectWorkerUrl } from "~/lib/project-host-routing.ts";
import { projectsListQueryOptions } from "~/lib/project-route-query.ts";
import type { PublicRouteConfig } from "~/lib/public-route-config.ts";

type PublicConfig = PublicAppConfig<AppConfig>;

type AppSidebarProps = {
  organizationSlug: string;
  routeConfig: PublicRouteConfig;
};

export function AppSidebar({ organizationSlug, routeConfig }: AppSidebarProps) {
  return (
    <SidebarShell
      header={<AppSidebarOrganization organizationSlug={organizationSlug} />}
      footer={<AppSidebarUser />}
    >
      <AppSidebarNav routeConfig={routeConfig} />
    </SidebarShell>
  );
}

function AppSidebarOrganization({ organizationSlug }: Pick<AppSidebarProps, "organizationSlug">) {
  const { session } = useAuthClient();
  const organizations = session?.authenticated ? session.session.organizations : [];
  const activeOrganization =
    organizations.find((organization) => organization.slug === organizationSlug) ??
    organizations[0];
  const activeOrganizationLabel = nonEmptyLabel(activeOrganization?.name, organizationSlug);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton className="h-10 gap-2 data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground">
                <Building2 className="size-4" />
                <span className="truncate">{activeOrganizationLabel}</span>
                <ChevronsUpDown className="ml-auto size-4" />
              </SidebarMenuButton>
            }
          />
          <DropdownMenuContent side="bottom" align="start" className="w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Organizations</DropdownMenuLabel>
              {organizations.map((organization) => (
                <DropdownMenuItem
                  key={organization.id}
                  render={
                    <Link
                      to="/org/$organizationSlug"
                      params={{ organizationSlug: organization.slug }}
                    />
                  }
                >
                  <Building2 />
                  <span className="truncate">
                    {nonEmptyLabel(organization.name, organization.slug)}
                  </span>
                </DropdownMenuItem>
              ))}
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
  const [debugOpen, setDebugOpen] = useState(false);
  const user = session?.authenticated ? session.user : null;
  const label = nonEmptyLabel(user?.name, user?.email, "Account");
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
                <SidebarMenuButton className="h-10 gap-2 data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground">
                  <UserCircle className="size-4" />
                  <span className="truncate">{label}</span>
                  <ChevronsUpDown className="ml-auto size-4" />
                </SidebarMenuButton>
              }
            />
            <DropdownMenuContent side="top" align="start" className="w-56">
              <DropdownMenuGroup>
                <DropdownMenuLabel className="truncate">{label}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setDebugOpen(true)}>
                  <Bug />
                  <span>View debug info</span>
                </DropdownMenuItem>
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

function AppSidebarNav({ routeConfig }: { routeConfig: PublicRouteConfig }) {
  const matchRoute = useMatchRoute();
  const { data } = useQuery(projectsListQueryOptions({ limit: 100, offset: 0 }));
  const projects =
    data?.projects.filter((project) => !project.isOrphanedProjectFromAuthService) ?? [];

  return (
    <>
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

      {projects.map((project) => (
        <ProjectSidebarGroup
          key={project.id}
          customHostname={project.customHostname}
          mcpBaseUrl={routeConfig.mcpBaseUrl}
          projectSlug={project.slug}
          baseUrl={routeConfig.baseUrl}
          projectHostnameBases={routeConfig.projectHostnameBases}
        />
      ))}
    </>
  );
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
    <SidebarGroup>
      <SidebarGroupLabel>{projectSlug}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenuSub>
          <SidebarMenuSubItem>
            <SidebarMenuSubButton
              render={<Link to="/projects/$projectSlug" params={{ projectSlug }} />}
              isActive={Boolean(
                matchRoute({
                  to: "/projects/$projectSlug",
                  params: { projectSlug },
                  fuzzy: false,
                }),
              )}
            >
              <span>Home</span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
          <SidebarMenuSubItem>
            <SidebarMenuSubButton
              render={<Link to="/projects/$projectSlug/agents" params={{ projectSlug }} />}
              isActive={Boolean(
                matchRoute({
                  to: "/projects/$projectSlug/agents",
                  params: { projectSlug },
                  fuzzy: true,
                }),
              )}
            >
              <span>Agents</span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
          <SidebarMenuSubItem>
            <SidebarMenuSubButton
              render={
                <Link to="/projects/$projectSlug/codemode-sessions" params={{ projectSlug }} />
              }
              isActive={Boolean(
                matchRoute({
                  to: "/projects/$projectSlug/codemode-sessions",
                  params: { projectSlug },
                  fuzzy: true,
                }),
              )}
            >
              <span>Codemode Sessions</span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
          <SidebarMenuSubItem>
            <SidebarMenuSubButton
              render={<Link to="/projects/$projectSlug/repos" params={{ projectSlug }} />}
              isActive={Boolean(
                matchRoute({
                  to: "/projects/$projectSlug/repos",
                  params: { projectSlug },
                  fuzzy: true,
                }),
              )}
            >
              <span>Repos</span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
          <SidebarMenuSubItem>
            <SidebarMenuSubButton
              render={<Link to="/projects/$projectSlug/secrets" params={{ projectSlug }} />}
              isActive={Boolean(
                matchRoute({
                  to: "/projects/$projectSlug/secrets",
                  params: { projectSlug },
                  fuzzy: true,
                }),
              )}
            >
              <span>Secrets</span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
          <SidebarMenuSubItem>
            <SidebarMenuSubButton
              render={<Link to="/projects/$projectSlug/examples" params={{ projectSlug }} />}
              isActive={Boolean(
                matchRoute({
                  to: "/projects/$projectSlug/examples",
                  params: { projectSlug },
                }),
              )}
            >
              <span>Examples</span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
          <SidebarMenuSubItem>
            <SidebarMenuSubButton
              render={<Link to="/projects/$projectSlug/integrations" params={{ projectSlug }} />}
              isActive={Boolean(
                matchRoute({
                  to: "/projects/$projectSlug/integrations",
                  params: { projectSlug },
                }),
              )}
            >
              <span>Integrations</span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
          {mcpUrl ? (
            <SidebarMenuSubItem>
              <SidebarMenuSubButton
                render={<Link to="/projects/$projectSlug/mcp" params={{ projectSlug }} />}
                isActive={Boolean(
                  matchRoute({
                    to: "/projects/$projectSlug/mcp",
                    params: { projectSlug },
                  }),
                )}
              >
                <span>MCP</span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ) : null}
          <SidebarMenuSubItem>
            <SidebarMenuSubButton
              render={<Link to="/projects/$projectSlug/streams" params={{ projectSlug }} />}
              isActive={Boolean(
                matchRoute({
                  to: "/projects/$projectSlug/streams",
                  params: { projectSlug },
                  fuzzy: true,
                }),
              )}
            >
              <span>Streams</span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
          <SidebarMenuSubItem>
            <SidebarMenuSubButton
              render={<Link to="/projects/$projectSlug/settings" params={{ projectSlug }} />}
              isActive={Boolean(
                matchRoute({
                  to: "/projects/$projectSlug/settings",
                  params: { projectSlug },
                }),
              )}
            >
              <span>Settings</span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
          {customWorkerUrl ? (
            <SidebarMenuSubItem>
              <SidebarMenuSubButton
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
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ) : null}
        </SidebarMenuSub>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

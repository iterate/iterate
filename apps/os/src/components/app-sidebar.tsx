import { Link, useMatchRoute } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import type { PublicAppConfig } from "@iterate-com/shared/apps/config";
import { useConfig } from "@iterate-com/ui/apps/config";
import { OrganizationSwitcher, UserButton } from "@clerk/tanstack-react-start";
import { useQuery } from "@tanstack/react-query";
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
import { orpc } from "~/orpc/client.ts";

type PublicConfig = PublicAppConfig<AppConfig>;

type AppSidebarProps = {
  organizationSlug: string;
};

export function AppSidebar({ organizationSlug }: AppSidebarProps) {
  return (
    <SidebarShell header={<AppSidebarOrganization />} footer={<AppSidebarUser />}>
      <AppSidebarNav organizationSlug={organizationSlug} />
    </SidebarShell>
  );
}

function AppSidebarOrganization() {
  return (
    <div className="px-2">
      <OrganizationSwitcher
        hidePersonal
        afterCreateOrganizationUrl="/organization"
        afterLeaveOrganizationUrl="/organization"
        afterSelectOrganizationUrl="/organization"
        appearance={{
          elements: {
            organizationSwitcherTrigger:
              "w-full justify-start rounded-md border border-sidebar-border bg-sidebar-accent px-3 py-2 text-sidebar-accent-foreground shadow-none",
            organizationPreview: "min-w-0",
            organizationPreviewTextContainer: "min-w-0 text-left",
          },
        }}
      />
    </div>
  );
}

function AppSidebarUser() {
  return (
    <div className="flex items-center px-3 py-2">
      <UserButton />
    </div>
  );
}

function AppSidebarNav({ organizationSlug }: AppSidebarProps) {
  const matchRoute = useMatchRoute();
  const config = useConfig<PublicConfig>();
  const { data } = useQuery({
    ...orpc.projects.list.queryOptions({ input: { limit: 100, offset: 0 } }),
    staleTime: 30_000,
  });
  const projects = data?.projects ?? [];

  return (
    <>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                render={
                  <Link to="/orgs/$organizationSlug/projects" params={{ organizationSlug }} />
                }
                isActive={Boolean(
                  matchRoute({
                    to: "/orgs/$organizationSlug/projects",
                    params: { organizationSlug },
                    fuzzy: false,
                  }),
                )}
              >
                <span>Projects</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      {projects.map((project) => (
        <ProjectSidebarGroup
          key={project.id}
          organizationSlug={organizationSlug}
          customHostname={project.customHostname}
          projectSlug={project.slug}
          projectHostnameBases={config.projectHostnameBases}
        />
      ))}
    </>
  );
}

function ProjectSidebarGroup({
  customHostname,
  organizationSlug,
  projectHostnameBases,
  projectSlug,
}: {
  customHostname: string | null;
  organizationSlug: string;
  projectHostnameBases: readonly string[];
  projectSlug: string;
}) {
  const matchRoute = useMatchRoute();
  const mcpUrl = buildProjectMcpUrl({ projectSlug, projectHostnameBases });
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
              render={
                <Link
                  to="/orgs/$organizationSlug/projects/$projectSlug"
                  params={{ organizationSlug, projectSlug }}
                />
              }
              isActive={Boolean(
                matchRoute({
                  to: "/orgs/$organizationSlug/projects/$projectSlug",
                  params: { organizationSlug, projectSlug },
                  fuzzy: false,
                }),
              )}
            >
              <span>Home</span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
          <SidebarMenuSubItem>
            <SidebarMenuSubButton
              render={
                <Link
                  to="/orgs/$organizationSlug/projects/$projectSlug/agents"
                  params={{ organizationSlug, projectSlug }}
                />
              }
              isActive={Boolean(
                matchRoute({
                  to: "/orgs/$organizationSlug/projects/$projectSlug/agents",
                  params: { organizationSlug, projectSlug },
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
                <Link
                  to="/orgs/$organizationSlug/projects/$projectSlug/codemode-sessions"
                  params={{ organizationSlug, projectSlug }}
                />
              }
              isActive={Boolean(
                matchRoute({
                  to: "/orgs/$organizationSlug/projects/$projectSlug/codemode-sessions",
                  params: { organizationSlug, projectSlug },
                  fuzzy: true,
                }),
              )}
            >
              <span>Codemode Sessions</span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
          <SidebarMenuSubItem>
            <SidebarMenuSubButton
              render={
                <Link
                  to="/orgs/$organizationSlug/projects/$projectSlug/repos"
                  params={{ organizationSlug, projectSlug }}
                />
              }
              isActive={Boolean(
                matchRoute({
                  to: "/orgs/$organizationSlug/projects/$projectSlug/repos",
                  params: { organizationSlug, projectSlug },
                  fuzzy: true,
                }),
              )}
            >
              <span>Repos</span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
          <SidebarMenuSubItem>
            <SidebarMenuSubButton
              render={
                <Link
                  to="/orgs/$organizationSlug/projects/$projectSlug/secrets"
                  params={{ organizationSlug, projectSlug }}
                />
              }
              isActive={Boolean(
                matchRoute({
                  to: "/orgs/$organizationSlug/projects/$projectSlug/secrets",
                  params: { organizationSlug, projectSlug },
                  fuzzy: true,
                }),
              )}
            >
              <span>Secrets</span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
          <SidebarMenuSubItem>
            <SidebarMenuSubButton
              render={
                <Link
                  to="/orgs/$organizationSlug/projects/$projectSlug/sandboxes"
                  params={{ organizationSlug, projectSlug }}
                />
              }
              isActive={Boolean(
                matchRoute({
                  to: "/orgs/$organizationSlug/projects/$projectSlug/sandboxes",
                  params: { organizationSlug, projectSlug },
                  fuzzy: true,
                }),
              )}
            >
              <span>Sandboxes</span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
          <SidebarMenuSubItem>
            <SidebarMenuSubButton
              render={
                <Link
                  to="/orgs/$organizationSlug/projects/$projectSlug/examples"
                  params={{ organizationSlug, projectSlug }}
                />
              }
              isActive={Boolean(
                matchRoute({
                  to: "/orgs/$organizationSlug/projects/$projectSlug/examples",
                  params: { organizationSlug, projectSlug },
                }),
              )}
            >
              <span>Examples</span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
          <SidebarMenuSubItem>
            <SidebarMenuSubButton
              render={
                <Link
                  to="/orgs/$organizationSlug/projects/$projectSlug/integrations"
                  params={{ organizationSlug, projectSlug }}
                />
              }
              isActive={Boolean(
                matchRoute({
                  to: "/orgs/$organizationSlug/projects/$projectSlug/integrations",
                  params: { organizationSlug, projectSlug },
                }),
              )}
            >
              <span>Integrations</span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
          {mcpUrl ? (
            <SidebarMenuSubItem>
              <SidebarMenuSubButton
                render={
                  <Link
                    to="/orgs/$organizationSlug/projects/$projectSlug/mcp"
                    params={{ organizationSlug, projectSlug }}
                  />
                }
                isActive={Boolean(
                  matchRoute({
                    to: "/orgs/$organizationSlug/projects/$projectSlug/mcp",
                    params: { organizationSlug, projectSlug },
                  }),
                )}
              >
                <span>MCP</span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ) : null}
          <SidebarMenuSubItem>
            <SidebarMenuSubButton
              render={
                <Link
                  to="/orgs/$organizationSlug/projects/$projectSlug/streams"
                  params={{ organizationSlug, projectSlug }}
                />
              }
              isActive={Boolean(
                matchRoute({
                  to: "/orgs/$organizationSlug/projects/$projectSlug/streams",
                  params: { organizationSlug, projectSlug },
                  fuzzy: true,
                }),
              )}
            >
              <span>Streams</span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
          <SidebarMenuSubItem>
            <SidebarMenuSubButton
              render={
                <Link
                  to="/orgs/$organizationSlug/projects/$projectSlug/settings"
                  params={{ organizationSlug, projectSlug }}
                />
              }
              isActive={Boolean(
                matchRoute({
                  to: "/orgs/$organizationSlug/projects/$projectSlug/settings",
                  params: { organizationSlug, projectSlug },
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

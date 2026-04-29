import { Link, useMatchRoute } from "@tanstack/react-router";
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
import { orpc } from "~/orpc/client.ts";

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
        <SidebarGroup key={project.id}>
          <SidebarGroupLabel>{project.slug}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenuSub>
              <SidebarMenuSubItem>
                <SidebarMenuSubButton
                  render={
                    <Link
                      to="/orgs/$organizationSlug/projects/$projectSlug/run-code"
                      params={{ organizationSlug, projectSlug: project.slug }}
                    />
                  }
                  isActive={Boolean(
                    matchRoute({
                      to: "/orgs/$organizationSlug/projects/$projectSlug/run-code",
                      params: { organizationSlug, projectSlug: project.slug },
                    }),
                  )}
                >
                  <span>Run code</span>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
              <SidebarMenuSubItem>
                <SidebarMenuSubButton
                  render={
                    <Link
                      to="/orgs/$organizationSlug/projects/$projectSlug/settings"
                      params={{ organizationSlug, projectSlug: project.slug }}
                    />
                  }
                  isActive={Boolean(
                    matchRoute({
                      to: "/orgs/$organizationSlug/projects/$projectSlug/settings",
                      params: { organizationSlug, projectSlug: project.slug },
                    }),
                  )}
                >
                  <span>Settings</span>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            </SidebarMenuSub>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </>
  );
}

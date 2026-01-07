import { createFileRoute, Link, Outlet, redirect, useLocation, useParams } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Box, Home, Plus, Settings, User, Users } from "lucide-react";
import { trpc } from "../../lib/trpc.tsx";
import { useSessionUser } from "../../hooks/use-session-user.ts";
import { useQueryInvalidation } from "../../hooks/use-query-invalidation.ts";
import { SidebarShell } from "../../components/sidebar-shell.tsx";
import { OrgSwitcher } from "../../components/org-project-switcher.tsx";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "../../components/ui/sidebar.tsx";

export const Route = createFileRoute("/_auth.layout/orgs/$organizationSlug")({
  beforeLoad: async ({ context, params }) => {
    const currentOrg = await context.queryClient.ensureQueryData(
      trpc.organization.withProjects.queryOptions({
        organizationSlug: params.organizationSlug,
      }),
    );

    if (!currentOrg) {
      throw redirect({ to: "/" });
    }
  },
  component: OrgLayout,
});

function OrgLayout() {
  const params = useParams({ from: "/_auth.layout/orgs/$organizationSlug" });
  const location = useLocation();
  const { user } = useSessionUser();

  if (!user) {
    throw new Error("User not found - should not happen in auth-required layout");
  }

  const { data: organizations } = useSuspenseQuery(trpc.user.myOrganizations.queryOptions());

  const { data: currentOrg } = useSuspenseQuery(
    trpc.organization.withProjects.queryOptions({
      organizationSlug: params.organizationSlug,
    }),
  );

  if (!currentOrg || !currentOrg.id || !currentOrg.name || !currentOrg.slug) {
    throw redirect({ to: "/" });
  }

  useQueryInvalidation(currentOrg.id);

  const isProjectRoute = location.pathname.includes("/projects/");

  if (isProjectRoute) {
    return <Outlet />;
  }

  const orgsList = (organizations || []).map((organization) => ({
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    role: organization.role,
  }));

  const orgSlug = currentOrg.slug;
  const currentOrgData = {
    id: currentOrg.id,
    name: currentOrg.name,
    slug: orgSlug,
  };

  const projects = (currentOrg.projects || []).map((p) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
  }));

  const isHomeActive = location.pathname === `/orgs/${orgSlug}` || location.pathname === `/orgs/${orgSlug}/`;
  const isSettingsActive = location.pathname === `/orgs/${orgSlug}/settings`;
  const isTeamActive = location.pathname === `/orgs/${orgSlug}/team`;
  const isUserSettingsActive = location.pathname === "/user/settings";

  return (
    <SidebarProvider defaultOpen={true}>
      <div className="flex min-h-screen w-full">
        <SidebarShell
          header={<OrgSwitcher organizations={orgsList} currentOrg={currentOrgData} />}
          user={{
            name: user.name,
            email: user.email,
            image: user.image,
            role: user.role ?? undefined,
          }}
        >
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={isHomeActive}>
                    <Link to="/orgs/$organizationSlug" params={{ organizationSlug: orgSlug }}>
                      <Home className="h-4 w-4" />
                      <span>Home</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarGroup>
            <SidebarGroupLabel>Projects</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {projects.map((project) => {
                  const isProjectActive = location.pathname.startsWith(
                    `/orgs/${orgSlug}/projects/${project.slug}`,
                  );
                  return (
                    <SidebarMenuItem key={project.id}>
                      <SidebarMenuButton asChild isActive={isProjectActive}>
                        <Link
                          to="/orgs/$organizationSlug/projects/$projectSlug"
                          params={{
                            organizationSlug: orgSlug,
                            projectSlug: project.slug,
                          }}
                        >
                          <Box className="h-4 w-4" />
                          <span>{project.name}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
                <SidebarMenuItem>
                  <SidebarMenuButton asChild>
                    <Link
                      to="/orgs/$organizationSlug/new-project"
                      params={{ organizationSlug: orgSlug }}
                    >
                      <Plus className="h-4 w-4" />
                      <span>Add project</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarGroup>
            <SidebarGroupLabel>Organization</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={isSettingsActive}>
                    <Link
                      to="/orgs/$organizationSlug/settings"
                      params={{ organizationSlug: orgSlug }}
                    >
                      <Settings className="h-4 w-4" />
                      <span>Settings</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={isTeamActive}>
                    <Link
                      to="/orgs/$organizationSlug/team"
                      params={{ organizationSlug: orgSlug }}
                    >
                      <Users className="h-4 w-4" />
                      <span>Team</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarGroup>
            <SidebarGroupLabel>User</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={isUserSettingsActive}>
                    <Link to="/user/settings">
                      <User className="h-4 w-4" />
                      <span>Settings</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarShell>
        <SidebarInset>
          <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger />
          </header>
          <main className="flex-1 overflow-auto">
            <Outlet />
          </main>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}

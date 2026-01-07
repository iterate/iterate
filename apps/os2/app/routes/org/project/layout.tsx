import { createFileRoute, Link, Outlet, redirect, useLocation, useParams } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Bot, GitBranch, Home, Plug, Server, Settings, SlidersHorizontal, User, Users } from "lucide-react";
import { trpc } from "../../../lib/trpc.tsx";
import { useSessionUser } from "../../../hooks/use-session-user.ts";
import { SidebarShell } from "../../../components/sidebar-shell.tsx";
import { OrgSwitcher } from "../../../components/org-project-switcher.tsx";
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
} from "../../../components/ui/sidebar.tsx";

export const Route = createFileRoute(
  "/_auth.layout/orgs/$organizationSlug/projects/$projectSlug",
)({
  component: ProjectLayout,
});

function ProjectLayout() {
  const params = useParams({
    from: "/_auth.layout/orgs/$organizationSlug/projects/$projectSlug",
  });
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

  useSuspenseQuery(
    trpc.project.bySlug.queryOptions({
      organizationSlug: params.organizationSlug,
      projectSlug: params.projectSlug,
    }),
  );

  if (!currentOrg || !currentOrg.id || !currentOrg.name || !currentOrg.slug) {
    throw redirect({ to: "/" });
  }

  const orgSlug = currentOrg.slug;

  const orgsList = (organizations || []).map((organization) => ({
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    role: organization.role,
  }));

  const currentOrgData = {
    id: currentOrg.id,
    name: currentOrg.name,
    slug: orgSlug,
  };

  const projectBasePath = `/orgs/${params.organizationSlug}/projects/${params.projectSlug}`;

  const isHomeActive =
    location.pathname === projectBasePath || location.pathname === `${projectBasePath}/`;

  const navItems = [
    { href: `${projectBasePath}/machines`, label: "Machines", icon: Server },
    { href: `${projectBasePath}/repo`, label: "Repo", icon: GitBranch },
    { href: `${projectBasePath}/connectors`, label: "Connectors", icon: Plug },
    { href: `${projectBasePath}/env-vars`, label: "Env vars", icon: SlidersHorizontal },
    { href: `${projectBasePath}/settings`, label: "Settings", icon: Settings },
    { href: `${projectBasePath}/agents`, label: "Agents", icon: Bot },
  ];

  const isOrgSettingsActive = location.pathname === `/orgs/${orgSlug}/settings`;
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
                    <Link to={projectBasePath}>
                      <Home className="h-4 w-4" />
                      <span>Home</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                {navItems.map((item) => {
                  const isActive = location.pathname.startsWith(item.href);
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton asChild isActive={isActive}>
                        <Link to={item.href}>
                          <item.icon className="h-4 w-4" />
                          <span>{item.label}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarGroup>
            <SidebarGroupLabel>Organization</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={isOrgSettingsActive}>
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

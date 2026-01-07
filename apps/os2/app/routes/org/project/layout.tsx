import { createFileRoute, Link, Outlet, redirect, useLocation, useParams } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Bot, GitBranch, Home, KeyRound, Plug, Server, Settings, SlidersHorizontal } from "lucide-react";
import { trpc } from "../../../lib/trpc.tsx";
import { useSessionUser } from "../../../hooks/use-session-user.ts";
import { SidebarShell } from "../../../components/sidebar-shell.tsx";
import { OrgSwitcher } from "../../../components/org-project-switcher.tsx";
import { OrgSidebarNav } from "../../../components/org-sidebar-nav.tsx";
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

  const { data: currentProject } = useSuspenseQuery(
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

  const projects = (currentOrg.projects || []).map((p) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
  }));

  const projectBasePath = `/orgs/${params.organizationSlug}/projects/${params.projectSlug}`;

  const isHomeActive =
    location.pathname === projectBasePath || location.pathname === `${projectBasePath}/`;

  const navItems = [
    { href: `${projectBasePath}/connectors`, label: "Connectors", icon: Plug },
    { href: `${projectBasePath}/agents`, label: "Agents", icon: Bot },
    { href: `${projectBasePath}/machines`, label: "Machines", icon: Server },
    { href: `${projectBasePath}/repo`, label: "Repo", icon: GitBranch },
    { href: `${projectBasePath}/access-tokens`, label: "Access tokens", icon: KeyRound },
    { href: `${projectBasePath}/env-vars`, label: "Env vars", icon: SlidersHorizontal },
    { href: `${projectBasePath}/settings`, label: "Settings", icon: Settings },
  ];

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
            <SidebarGroupLabel className="flex flex-col items-start">
              <span>Project:</span>
              <span className="font-medium text-foreground">{currentProject?.name}</span>
            </SidebarGroupLabel>
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

          <OrgSidebarNav orgSlug={orgSlug} orgName={currentOrg.name} projects={projects} />
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

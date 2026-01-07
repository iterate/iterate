import { createFileRoute, Link, Outlet, redirect, useLocation, useParams } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Bot, GitBranch, KeyRound, Plug, Server, Settings, SlidersHorizontal } from "lucide-react";
import { trpc } from "../../../lib/trpc.tsx";
import { useSessionUser } from "../../../hooks/use-session-user.ts";
import { SidebarShell } from "../../../components/sidebar-shell.tsx";
import { OrgProjectSwitcher } from "../../../components/org-project-switcher.tsx";
import {
  SidebarGroup,
  SidebarGroupContent,
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

  const orgId = currentOrg.id;
  const orgName = currentOrg.name;
  const orgSlug = currentOrg.slug;

  const organizationsWithProjects = (organizations || []).map((organization) => ({
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    projects: (organization.projects || []).map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
    })),
  }));

  const currentOrgWithProjects = {
    id: orgId,
    name: orgName,
    slug: orgSlug,
    projects: (currentOrg.projects || []).map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
    })),
  };

  const currentProject = currentOrgWithProjects.projects.find(
    (p) => p.slug === params.projectSlug,
  );

  const projectBasePath = `/orgs/${params.organizationSlug}/projects/${params.projectSlug}`;

  const navItems = [
    { href: projectBasePath, label: "Access tokens", icon: KeyRound, exact: true },
    { href: `${projectBasePath}/machines`, label: "Machines", icon: Server },
    { href: `${projectBasePath}/repo`, label: "Repo", icon: GitBranch },
    { href: `${projectBasePath}/connectors`, label: "Connectors", icon: Plug },
    { href: `${projectBasePath}/env-vars`, label: "Env vars", icon: SlidersHorizontal },
    { href: `${projectBasePath}/settings`, label: "Settings", icon: Settings },
    { href: `${projectBasePath}/agents`, label: "Agents", icon: Bot },
  ];

  return (
    <SidebarProvider defaultOpen={true}>
      <div className="flex min-h-screen w-full">
        <SidebarShell
          header={
            <OrgProjectSwitcher
              organizations={organizationsWithProjects}
              currentOrg={currentOrgWithProjects}
              currentProject={currentProject}
            />
          }
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
                {navItems.map((item) => {
                  const isActive = item.exact
                    ? location.pathname === item.href || location.pathname === `${item.href}/`
                    : location.pathname.startsWith(item.href);
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

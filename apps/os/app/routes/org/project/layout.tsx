import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useMatchRoute,
  useParams,
} from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  Activity,
  Bot,
  GitBranch,
  Home,
  KeyRound,
  Plug,
  Server,
  Settings,
  SlidersHorizontal,
} from "lucide-react";
import { trpc } from "../../../lib/trpc.tsx";
import { useSessionUser } from "../../../hooks/use-session-user.ts";
import { usePostHogIdentity } from "../../../hooks/use-posthog-identity.tsx";
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
} from "../../../components/ui/sidebar.tsx";
import { AppHeader } from "../../../components/app-header.tsx";
import { HeaderActionsProvider } from "../../../components/header-actions.tsx";
import { useHeaderActions } from "../../../hooks/use-header-actions.ts";

export const Route = createFileRoute("/_auth/orgs/$organizationSlug/projects/$projectSlug")({
  beforeLoad: async ({ context, params }) => {
    // Ensure org exists
    const currentOrg = await context.queryClient.ensureQueryData(
      trpc.organization.withProjects.queryOptions({
        organizationSlug: params.organizationSlug,
      }),
    );

    if (!currentOrg) {
      throw redirect({ to: "/" });
    }

    // Ensure project exists within the org
    const projectExists = currentOrg.projects?.some((p) => p.slug === params.projectSlug);
    if (!projectExists) {
      throw redirect({
        to: "/orgs/$organizationSlug",
        params: { organizationSlug: params.organizationSlug },
      });
    }
  },
  component: ProjectLayout,
});

function ProjectLayout() {
  const params = useParams({
    from: "/_auth/orgs/$organizationSlug/projects/$projectSlug",
  });
  const matchRoute = useMatchRoute();
  const { user } = useSessionUser();
  const [headerActions, setHeaderActions] = useHeaderActions();

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

  // Fetch machines list for breadcrumb dropdown
  const { data: machinesList } = useSuspenseQuery(
    trpc.machine.list.queryOptions({
      organizationSlug: params.organizationSlug,
      projectSlug: params.projectSlug,
      includeArchived: false,
    }),
  );

  // Detect if we're on a machine detail page and extract machine ID
  const machineMatch = matchRoute({
    to: "/orgs/$organizationSlug/projects/$projectSlug/machines/$machineId",
    params,
  });
  const currentMachineId = machineMatch
    ? (machineMatch as { machineId: string }).machineId
    : undefined;
  const currentMachine = currentMachineId
    ? machinesList.find((m) => m.id === currentMachineId)
    : undefined;

  // Memoize user props to avoid creating new objects on each render
  const userProps = useMemo(
    () => ({
      name: user.name,
      email: user.email,
      image: user.image,
      role: user.role ?? undefined,
    }),
    [user.name, user.email, user.image, user.role],
  );

  // currentOrg is guaranteed by beforeLoad, but TypeScript needs the check
  if (!currentOrg || !currentOrg.id || !currentOrg.name || !currentOrg.slug) {
    throw redirect({ to: "/" });
  }

  // Identify user, organization, and project in PostHog
  usePostHogIdentity({
    user: user ?? null,
    organization: {
      id: currentOrg.id,
      name: currentOrg.name,
      slug: currentOrg.slug,
    },
    project: currentProject
      ? {
          id: currentProject.id,
          name: currentProject.name,
          slug: currentProject.slug,
        }
      : null,
  });

  const orgsList = organizations.map((organization) => ({
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    role: organization.role,
  }));

  const currentOrgData = {
    id: currentOrg.id,
    name: currentOrg.name,
    slug: currentOrg.slug,
  };

  const projects = (currentOrg.projects ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
  }));

  // Transform machines for breadcrumb dropdown (using id as slug for machines)
  const machines = machinesList.map((m) => ({
    id: m.id,
    name: m.name,
    slug: m.id, // machines use id for routing
  }));

  // Type-safe navigation items
  const navItems = [
    {
      to: "/orgs/$organizationSlug/projects/$projectSlug/connectors" as const,
      label: "Connectors",
      icon: Plug,
    },
    {
      to: "/orgs/$organizationSlug/projects/$projectSlug/agents" as const,
      label: "Agents",
      icon: Bot,
    },
    {
      to: "/orgs/$organizationSlug/projects/$projectSlug/machines" as const,
      label: "Machines",
      icon: Server,
    },
    {
      to: "/orgs/$organizationSlug/projects/$projectSlug/events" as const,
      label: "Events",
      icon: Activity,
    },
    {
      to: "/orgs/$organizationSlug/projects/$projectSlug/repo" as const,
      label: "Repo",
      icon: GitBranch,
    },
    {
      to: "/orgs/$organizationSlug/projects/$projectSlug/access-tokens" as const,
      label: "Access tokens",
      icon: KeyRound,
    },
    {
      to: "/orgs/$organizationSlug/projects/$projectSlug/env-vars" as const,
      label: "Env vars",
      icon: SlidersHorizontal,
    },
    {
      to: "/orgs/$organizationSlug/projects/$projectSlug/settings" as const,
      label: "Settings",
      icon: Settings,
    },
  ];

  const isHomeActive = Boolean(
    matchRoute({
      to: "/orgs/$organizationSlug/projects/$projectSlug",
      params,
      fuzzy: false,
    }),
  );

  return (
    <SidebarProvider defaultOpen={true}>
      <SidebarShell
        header={<OrgSwitcher organizations={orgsList} currentOrg={currentOrgData} />}
        user={userProps}
      >
        <SidebarGroup>
          <SidebarGroupLabel className="h-auto min-h-8 flex-wrap gap-x-1">
            <span>Project:</span>
            <span>{currentProject?.name}</span>
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isHomeActive}>
                  <Link to="/orgs/$organizationSlug/projects/$projectSlug" params={params}>
                    <Home className="h-4 w-4" />
                    <span>Home</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {navItems.map((item) => {
                const isActive = Boolean(matchRoute({ to: item.to, params, fuzzy: true }));
                return (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton asChild isActive={isActive}>
                      <Link to={item.to} params={params}>
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

        <OrgSidebarNav orgSlug={currentOrg.slug} />
      </SidebarShell>
      <SidebarInset>
        <AppHeader
          orgName={currentOrg.name}
          projectName={currentProject?.name}
          organizationSlug={params.organizationSlug}
          projectSlug={params.projectSlug}
          organizations={orgsList}
          projects={projects}
          machines={machines}
          currentMachineId={currentMachineId}
          currentMachineName={currentMachine?.name}
          actions={headerActions}
        />
        <main className="w-full max-w-3xl flex-1 overflow-auto">
          <HeaderActionsProvider onActionsChange={setHeaderActions}>
            <Outlet />
          </HeaderActionsProvider>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

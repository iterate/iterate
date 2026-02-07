import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useMatchRoute,
  useParams,
} from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, useMemo } from "react";
import {
  ExternalLink,
  Home,
  Plug,
  Server,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { Spinner } from "../../components/ui/spinner.tsx";
import { trpc } from "../../lib/trpc.tsx";
import { useSessionUser } from "../../hooks/use-session-user.ts";
import { usePostHogIdentity } from "../../hooks/use-posthog-identity.tsx";
import { SidebarShell } from "../../components/sidebar-shell.tsx";
import { OrgSwitcher } from "../../components/org-project-switcher.tsx";
import { OrgSidebarNav } from "../../components/org-sidebar-nav.tsx";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "../../components/ui/sidebar.tsx";
import { AppHeader } from "../../components/app-header.tsx";
import { HeaderActionsProvider } from "../../components/header-actions.tsx";
import { useHeaderActions } from "../../hooks/use-header-actions.ts";

export const Route = createFileRoute("/_auth/proj/$projectSlug")({
  // beforeLoad: ONLY for validation and redirects (runs serially)
  beforeLoad: async ({ context, params }) => {
    // Lookup project by slug only (globally unique)
    const project = await context.queryClient.ensureQueryData(
      trpc.project.bySlug.queryOptions({
        projectSlug: params.projectSlug,
      }),
    );

    if (!project) {
      throw redirect({ to: "/" });
    }
  },

  // loader: Prefetch data (non-blocking, shows spinner if not ready)
  loader: ({ context, params }) => {
    context.queryClient.prefetchQuery(
      trpc.project.bySlug.queryOptions({
        projectSlug: params.projectSlug,
      }),
    );
    context.queryClient.prefetchQuery(trpc.user.myOrganizations.queryOptions());
  },

  component: ProjectLayout,
});

function ProjectLayout() {
  const params = useParams({
    from: "/_auth/proj/$projectSlug",
  });
  const matchRoute = useMatchRoute();
  const { user } = useSessionUser();
  const [headerActions, setHeaderActions] = useHeaderActions();

  if (!user) {
    throw new Error("User not found - should not happen in auth-required layout");
  }

  const { data: organizations } = useSuspenseQuery(trpc.user.myOrganizations.queryOptions());

  // bySlug returns project with organization
  const { data: projectWithOrg } = useSuspenseQuery(
    trpc.project.bySlug.queryOptions({
      projectSlug: params.projectSlug,
    }),
  );

  const currentOrg = projectWithOrg.organization;
  const currentProject = projectWithOrg;

  // Fetch machines list for breadcrumb dropdown
  const { data: machinesList } = useSuspenseQuery(
    trpc.machine.list.queryOptions({
      projectSlug: params.projectSlug,
      includeArchived: false,
    }),
  );

  // Detect if we're on a machine detail page and extract machine ID
  const machineMatch = matchRoute({
    to: "/proj/$projectSlug/machines/$machineId",
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

  // Fetch org with projects for the sidebar
  const { data: orgWithProjects } = useSuspenseQuery(
    trpc.organization.withProjects.queryOptions({
      organizationSlug: currentOrg.slug,
    }),
  );

  const projects = (orgWithProjects?.projects ?? []).map((p) => ({
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

  // Type-safe navigation items - using simplified /proj routes
  const navItems = [
    {
      to: "/proj/$projectSlug/connectors" as const,
      label: "Connectors",
      icon: Plug,
    },
    {
      to: "/proj/$projectSlug/machines" as const,
      label: "Machines",
      icon: Server,
    },
    {
      to: "/proj/$projectSlug/env-vars" as const,
      label: "Env vars",
      icon: SlidersHorizontal,
    },
    {
      to: "/proj/$projectSlug/approvals" as const,
      label: "Approvals",
      icon: ShieldCheck,
    },
    {
      to: "/proj/$projectSlug/settings" as const,
      label: "Settings",
      icon: Settings,
    },
  ];

  const isHomeActive = Boolean(
    matchRoute({
      to: "/proj/$projectSlug",
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
                  <Link to="/proj/$projectSlug" params={params}>
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

        {/* Admin deep-links section - only visible to system admins */}
        {user.role === "admin" && currentProject && (
          <SidebarGroup>
            <SidebarGroupLabel>Admin Links</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild>
                    <a
                      href={`https://eu.posthog.com/project/115112/groups/1/${currentProject.id}/events`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink className="h-4 w-4" />
                      <span>PostHog Events</span>
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild>
                    <a
                      href={`https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/workers/services/view/os/production/observability/events?filterCombination=%22and%22&needle=%7B%22value%22%3A%22${currentProject.id}%22%7D&calculations=%5B%7B%22operator%22%3A%22count%22%7D%5D&orderBy=%7B%22value%22%3A%22count%22%2C%22limit%22%3A10%2C%22order%22%3A%22desc%22%7D&timeframe=1h&conditions=%7B%7D&conditionCombination=%22and%22&alertTiming=%7B%22interval%22%3A300%2C%22window%22%3A900%2C%22timeBeforeFiring%22%3A600%2C%22timeBeforeResolved%22%3A600%7D`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink className="h-4 w-4" />
                      <span>CF Worker Logs</span>
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarShell>
      <SidebarInset>
        <AppHeader
          orgName={currentOrg.name}
          projectName={currentProject?.name}
          organizationSlug={currentOrg.slug}
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
            <Suspense fallback={<ContentSpinner />}>
              <Outlet />
            </Suspense>
          </HeaderActionsProvider>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

/** Content area loading spinner for child routes */
function ContentSpinner() {
  return (
    <div className="flex h-full min-h-[200px] items-center justify-center p-4">
      <Spinner className="size-6" />
    </div>
  );
}

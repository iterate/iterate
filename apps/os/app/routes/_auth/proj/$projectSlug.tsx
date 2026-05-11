import { Suspense } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet, redirect, useMatchRoute } from "@tanstack/react-router";
import {
  ExternalLink,
  Home,
  Plug,
  Server,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { AppHeader } from "@/components/app-header.tsx";
import { HeaderActionsProvider } from "@/components/header-actions.tsx";
import { OrgSidebarNav } from "@/components/org-sidebar-nav.tsx";
import { OrgSwitcher } from "@/components/org-project-switcher.tsx";
import { SidebarShell } from "@/components/sidebar-shell.tsx";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar.tsx";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useHeaderActions } from "@/hooks/use-header-actions.ts";
import { usePostHogIdentity } from "@/hooks/use-posthog-identity.tsx";
import { useSessionUser } from "@/hooks/use-session-user.ts";
import { orpc } from "@/lib/orpc.tsx";

export const Route = createFileRoute("/_auth/proj/$projectSlug")({
  beforeLoad: async ({ context, params }) => {
    const project = await context.queryClient.ensureQueryData(
      orpc.project.bySlug.queryOptions({
        input: {
          projectSlug: params.projectSlug,
        },
      }),
    );

    if (!project) {
      throw redirect({ to: "/" });
    }

    if (project.jonasLand) {
      throw redirect({
        to: "/jonasland/$projectSlug",
        params: { projectSlug: params.projectSlug },
      });
    }
  },

  loader: ({ context, params }) => {
    context.queryClient.prefetchQuery(
      orpc.project.bySlug.queryOptions({
        input: {
          projectSlug: params.projectSlug,
        },
      }),
    );
    context.queryClient.prefetchQuery(orpc.user.myOrganizations.queryOptions());
  },

  component: ProjectLayout,
});

function ProjectLayout() {
  const params = Route.useParams();
  const matchRoute = useMatchRoute();
  const [headerActions, setHeaderActions] = useHeaderActions();
  const { user } = useSessionUser();

  if (!user) {
    throw new Error("User not found - should not happen in auth-required layout");
  }

  const { data: organizations } = useSuspenseQuery(orpc.user.myOrganizations.queryOptions());
  const { data: project } = useSuspenseQuery(
    orpc.project.bySlug.queryOptions({
      input: {
        projectSlug: params.projectSlug,
      },
    }),
  );
  const currentOrg = project.organization;

  usePostHogIdentity({
    user,
    organization: currentOrg,
    project,
  });

  const { data: org } = useSuspenseQuery(
    orpc.organization.withProjects.queryOptions({
      input: {
        organizationSlug: currentOrg.slug,
      },
    }),
  );
  const { data: machines } = useSuspenseQuery(
    orpc.machine.list.queryOptions({
      input: {
        projectSlug: params.projectSlug,
        includeArchived: false,
      },
    }),
  );

  const machineMatch = matchRoute({
    to: "/proj/$projectSlug/machines/$machineId",
    params,
  });
  const currentMachineId = machineMatch
    ? (machineMatch as { machineId: string }).machineId
    : undefined;
  const currentMachine = currentMachineId
    ? machines.find((machine) => machine.id === currentMachineId)
    : undefined;

  return (
    <SidebarProvider defaultOpen={true}>
      <SidebarShell
        header={<OrgSwitcher organizations={organizations} currentOrg={currentOrg} />}
        user={{
          name: user.name,
          email: user.email,
          image: user.image,
          role: user.role ?? undefined,
        }}
      >
        <SidebarGroup>
          <SidebarGroupLabel className="h-auto min-h-8 flex-wrap gap-x-1">
            <span>Project:</span>
            <span>{project.name}</span>
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={Boolean(
                    matchRoute({
                      to: "/proj/$projectSlug",
                      params,
                      fuzzy: false,
                    }),
                  )}
                >
                  <Link to="/proj/$projectSlug" params={params}>
                    <Home className="h-4 w-4" />
                    <span>Home</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={Boolean(
                    matchRoute({ to: "/proj/$projectSlug/connectors", params, fuzzy: true }),
                  )}
                >
                  <Link to="/proj/$projectSlug/connectors" params={params}>
                    <Plug className="h-4 w-4" />
                    <span>Connectors</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={Boolean(
                    matchRoute({ to: "/proj/$projectSlug/machines", params, fuzzy: true }),
                  )}
                >
                  <Link to="/proj/$projectSlug/machines" params={params}>
                    <Server className="h-4 w-4" />
                    <span>Machines</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={Boolean(
                    matchRoute({ to: "/proj/$projectSlug/env-vars", params, fuzzy: true }),
                  )}
                >
                  <Link to="/proj/$projectSlug/env-vars" params={params}>
                    <SlidersHorizontal className="h-4 w-4" />
                    <span>Env vars</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={Boolean(
                    matchRoute({ to: "/proj/$projectSlug/approvals", params, fuzzy: true }),
                  )}
                >
                  <Link to="/proj/$projectSlug/approvals" params={params}>
                    <ShieldCheck className="h-4 w-4" />
                    <span>Approvals</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={Boolean(
                    matchRoute({ to: "/proj/$projectSlug/settings", params, fuzzy: true }),
                  )}
                >
                  <Link to="/proj/$projectSlug/settings" params={params}>
                    <Settings className="h-4 w-4" />
                    <span>Settings</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {user.role === "admin" && (
          <SidebarGroup>
            <SidebarGroupLabel>Admin Links</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild>
                    <a
                      href={`https://eu.posthog.com/project/115112/groups/1/${project.id}/events`}
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
                      href={`https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/workers/services/view/os/production/observability/events?filterCombination=%22and%22&needle=%7B%22value%22%3A%22${project.id}%22%7D&calculations=%5B%7B%22operator%22%3A%22count%22%7D%5D&orderBy=%7B%22value%22%3A%22count%22%2C%22limit%22%3A10%2C%22order%22%3A%22desc%22%7D&timeframe=1h&conditions=%7B%7D&conditionCombination=%22and%22&alertTiming=%7B%22interval%22%3A300%2C%22window%22%3A900%2C%22timeBeforeFiring%22%3A600%2C%22timeBeforeResolved%22%3A600%7D`}
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

        <OrgSidebarNav orgSlug={currentOrg.slug} />
      </SidebarShell>
      <SidebarInset>
        <AppHeader
          orgName={currentOrg.name}
          projectName={project.name}
          organizationSlug={currentOrg.slug}
          projectSlug={params.projectSlug}
          organizations={organizations}
          projects={org.projects ?? []}
          machines={machines.map((machine) => ({
            id: machine.id,
            name: machine.name,
            slug: machine.id,
          }))}
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

function ContentSpinner() {
  return (
    <div className="flex h-full min-h-[200px] items-center justify-center p-4">
      <Spinner className="size-6" />
    </div>
  );
}

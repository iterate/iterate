import { Suspense } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet, redirect, useMatchRoute } from "@tanstack/react-router";
import { ExternalLink, Home, Rocket, Settings } from "lucide-react";
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

export const Route = createFileRoute("/_auth/jonasland/$projectSlug")({
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

    if (!project.jonasLand) {
      throw redirect({
        to: "/proj/$projectSlug",
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

  component: JonasLandProjectLayout,
});

function JonasLandProjectLayout() {
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
            <span>jonasland</span>
            <span>{project.name}</span>
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={Boolean(
                    matchRoute({
                      to: "/jonasland/$projectSlug",
                      params,
                      fuzzy: false,
                    }),
                  )}
                >
                  <Link to="/jonasland/$projectSlug" params={params}>
                    <Home className="h-4 w-4" />
                    <span>Home</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={Boolean(
                    matchRoute({
                      to: "/jonasland/$projectSlug/deployments",
                      params,
                      fuzzy: true,
                    }),
                  )}
                >
                  <Link to="/jonasland/$projectSlug/deployments" params={params}>
                    <Rocket className="h-4 w-4" />
                    <span>Deployments</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={Boolean(
                    matchRoute({
                      to: "/jonasland/$projectSlug/settings",
                      params,
                      fuzzy: true,
                    }),
                  )}
                >
                  <Link to="/jonasland/$projectSlug/settings" params={params}>
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

import { createFileRoute, Outlet, Navigate, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { trpc } from "../../lib/trpc.ts";
import { useSessionUser } from "../../hooks/use-session-user.ts";
import { useOrganizationWebSocket } from "../../hooks/use-websocket.ts";
import { AppSidebar } from "../../components/app-sidebar.tsx";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "../../components/ui/sidebar.tsx";

export const Route = createFileRoute("/_auth-required.layout/_/orgs/$organizationSlug")({
  component: OrgLayout,
});

function OrgLayout() {
  const params = useParams({ from: "/_auth-required.layout/_/orgs/$organizationSlug" });
  const allParams = useParams({ strict: false });
  const { user } = useSessionUser();

  const { data: organizations, isPending: orgsPending } = useQuery(
    trpc.user.myOrganizations.queryOptions(),
  );

  const {
    data: currentOrg,
    isPending: orgPending,
    isError,
    error,
  } = useQuery(
    trpc.organization.withInstances.queryOptions({
      organizationSlug: params.organizationSlug,
    }),
  );

  useOrganizationWebSocket(currentOrg?.id ?? "");

  if (orgsPending || orgPending || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (isError) {
    console.error("Failed to load organization:", error);
    return <Navigate to="/" />;
  }

  if (!currentOrg) {
    return <Navigate to="/" />;
  }

  const organizationsWithProjects = (organizations || []).map((organization) => ({
    ...organization,
    projects: organization.instances || [],
  }));
  const currentOrgWithProjects =
    organizationsWithProjects.find((organization) => organization.id === currentOrg.id) ?? {
      ...currentOrg,
      projects: currentOrg.instances || [],
    };
  const currentProject =
    currentOrgWithProjects.projects.find((project) => project.slug === allParams.projectSlug) ??
    currentOrgWithProjects.projects[0];

  return (
    <SidebarProvider defaultOpen={true}>
      <div className="flex min-h-screen w-full">
        <AppSidebar
          organizations={organizationsWithProjects}
          currentOrg={currentOrgWithProjects}
          currentProject={currentProject}
          user={{
            name: user.name,
            email: user.email,
            image: user.image,
            role: user.role,
          }}
        />
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

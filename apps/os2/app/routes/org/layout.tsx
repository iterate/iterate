import { createFileRoute, Outlet, redirect, useParams } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { trpc } from "../../lib/trpc.ts";
import { useSessionUser } from "../../hooks/use-session-user.ts";
import { useOrganizationWebSocket } from "../../hooks/use-websocket.ts";
import { AppSidebar } from "../../components/app-sidebar.tsx";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "../../components/ui/sidebar.tsx";

export const Route = createFileRoute("/_auth-required.layout/_/orgs/$organizationSlug")({
  beforeLoad: async ({ context, params }) => {
    const currentOrg = await context.queryClient.ensureQueryData(
      trpc.organization.withInstances.queryOptions({
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
  const params = useParams({ from: "/_auth-required.layout/_/orgs/$organizationSlug" });
  const allParams = useParams({ strict: false });
  const { user } = useSessionUser();

  const { data: organizations } = useSuspenseQuery(
    trpc.user.myOrganizations.queryOptions(),
  );

  const { data: currentOrg } = useSuspenseQuery(
    trpc.organization.withInstances.queryOptions({
      organizationSlug: params.organizationSlug,
    }),
  );

  useOrganizationWebSocket(currentOrg?.id ?? "");

  if (!currentOrg) {
    throw redirect({ to: "/" });
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

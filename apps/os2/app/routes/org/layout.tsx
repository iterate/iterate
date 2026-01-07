import { createFileRoute, Outlet, redirect, useParams } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { orpc } from "../../lib/orpc.tsx";
import { useSessionUser } from "../../hooks/use-session-user.ts";
import { useQueryInvalidation } from "../../hooks/use-query-invalidation.ts";
import { AppSidebar } from "../../components/app-sidebar.tsx";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "../../components/ui/sidebar.tsx";

type Organization = {
  id: string;
  name: string;
  slug: string;
  role?: string;
  projects?: Array<{ id: string; name: string; slug: string }>;
};

export const Route = createFileRoute("/_auth-required/_/orgs/$organizationSlug")({
  beforeLoad: async ({ context, params }) => {
    const currentOrg = await context.queryClient.ensureQueryData(
      orpc.organization.withProjects.queryOptions({
        input: { organizationSlug: params.organizationSlug },
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

  if (!user) {
    throw new Error("User not found - should not happen in auth-required layout");
  }

  const { data: organizations } = useSuspenseQuery(
    orpc.user.myOrganizations.queryOptions(),
  ) as { data: Organization[] };

  const { data: currentOrg } = useSuspenseQuery(
    orpc.organization.withProjects.queryOptions({
      input: { organizationSlug: params.organizationSlug },
    }),
  ) as { data: Organization };

  if (!currentOrg || !currentOrg.id || !currentOrg.name || !currentOrg.slug) {
    throw redirect({ to: "/" });
  }

  useQueryInvalidation(currentOrg.id);

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
    id: currentOrg.id,
    name: currentOrg.name,
    slug: currentOrg.slug,
    projects: (currentOrg.projects || []).map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
    })),
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
            role: user.role ?? undefined,
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

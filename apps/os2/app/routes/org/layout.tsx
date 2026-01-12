import { createFileRoute, Outlet, redirect, useLocation, useParams } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { trpc } from "../../lib/trpc.tsx";
import { useSessionUser } from "../../hooks/use-session-user.ts";
import { usePostHogIdentity } from "../../hooks/use-posthog-identity.ts";
import { SidebarShell } from "../../components/sidebar-shell.tsx";
import { OrgSwitcher } from "../../components/org-project-switcher.tsx";
import { OrgSidebarNav } from "../../components/org-sidebar-nav.tsx";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "../../components/ui/sidebar.tsx";

export const Route = createFileRoute("/_auth.layout/orgs/$organizationSlug")({
  beforeLoad: async ({ context, params }) => {
    const currentOrg = await context.queryClient.ensureQueryData(
      trpc.organization.withProjects.queryOptions({
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
  const params = useParams({ from: "/_auth.layout/orgs/$organizationSlug" });
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

  if (!currentOrg || !currentOrg.id || !currentOrg.name || !currentOrg.slug) {
    throw redirect({ to: "/" });
  }

  // Identify user and organization in PostHog
  usePostHogIdentity({
    user: user ?? null,
    organization: {
      id: currentOrg.id,
      name: currentOrg.name,
      slug: currentOrg.slug,
    },
  });

  const isProjectRoute = location.pathname.includes("/projects/");

  if (isProjectRoute) {
    return <Outlet />;
  }

  const orgsList = (organizations || []).map((organization) => ({
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    role: organization.role,
  }));

  const orgSlug = currentOrg.slug;
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

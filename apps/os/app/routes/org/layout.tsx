import { createFileRoute, Outlet, redirect, useMatch, useParams } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { trpc } from "../../lib/trpc.tsx";
import { useSessionUser } from "../../hooks/use-session-user.ts";
import { usePostHogIdentity } from "../../hooks/use-posthog-identity.tsx";
import { SidebarShell } from "../../components/sidebar-shell.tsx";
import { OrgSwitcher } from "../../components/org-project-switcher.tsx";
import { OrgSidebarNav } from "../../components/org-sidebar-nav.tsx";
import { SidebarInset, SidebarProvider } from "../../components/ui/sidebar.tsx";
import { AppHeader } from "../../components/app-header.tsx";
import { HeaderActionsProvider, useHeaderActions } from "../../components/header-actions.tsx";

export const Route = createFileRoute("/_auth/orgs/$organizationSlug")({
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
  const params = useParams({ from: "/_auth/orgs/$organizationSlug" });
  const { user } = useSessionUser();
  const [headerActions, setHeaderActions] = useHeaderActions();

  // Check if we're rendering a project child route - if so, just pass through to Outlet
  const projectMatch = useMatch({
    from: "/_auth/orgs/$organizationSlug/projects/$projectSlug",
    shouldThrow: false,
  });

  const { data: organizations } = useSuspenseQuery(trpc.user.myOrganizations.queryOptions());

  const { data: currentOrg } = useSuspenseQuery(
    trpc.organization.withProjects.queryOptions({
      organizationSlug: params.organizationSlug,
    }),
  );

  // Memoize user props to avoid creating new objects on each render
  const userProps = useMemo(
    () =>
      user
        ? {
            name: user.name,
            email: user.email,
            image: user.image,
            role: user.role ?? undefined,
          }
        : null,
    [user],
  );

  // Identify user and organization in PostHog
  usePostHogIdentity({
    user: user ?? null,
    organization:
      currentOrg?.id && currentOrg?.name && currentOrg?.slug
        ? {
            id: currentOrg.id,
            name: currentOrg.name,
            slug: currentOrg.slug,
          }
        : null,
  });

  // If we're in a project route, just render the outlet (project layout handles UI)
  if (projectMatch) {
    return <Outlet />;
  }

  if (!user || !userProps) {
    throw new Error("User not found - should not happen in auth-required layout");
  }

  // currentOrg is guaranteed by beforeLoad, but TypeScript needs the check
  if (!currentOrg || !currentOrg.id || !currentOrg.name || !currentOrg.slug) {
    throw redirect({ to: "/" });
  }

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

  return (
    <SidebarProvider defaultOpen={true}>
      <SidebarShell
        header={<OrgSwitcher organizations={orgsList} currentOrg={currentOrgData} />}
        user={userProps}
      >
        <OrgSidebarNav orgSlug={currentOrg.slug} projects={projects} />
      </SidebarShell>
      <SidebarInset>
        <AppHeader
          orgName={currentOrg.name}
          organizationSlug={params.organizationSlug}
          organizations={orgsList}
          projects={projects}
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

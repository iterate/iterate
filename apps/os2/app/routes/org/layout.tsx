import { createFileRoute, Outlet, Navigate, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { trpc } from "../../lib/trpc.ts";
import { useSessionUser } from "../../hooks/use-session-user.ts";
import { useOrganizationWebSocket } from "../../hooks/use-websocket.ts";
import { Sidebar } from "../../components/sidebar.tsx";

export const Route = createFileRoute("/_auth-required.layout/_/$organizationSlug")({
  component: OrgLayout,
});

function OrgLayout() {
  const params = useParams({ from: "/_auth-required.layout/_/$organizationSlug" });
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

  return (
    <div className="flex h-screen">
      <Sidebar
        organizations={organizationsWithProjects}
        currentOrg={currentOrg}
        user={{
          name: user.name,
          email: user.email,
          image: user.image,
        }}
      />
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}

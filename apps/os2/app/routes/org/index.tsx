import { createFileRoute, Navigate, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { trpc } from "../../lib/trpc.ts";

export const Route = createFileRoute("/_auth-required.layout/_/orgs/$organizationSlug/")({
  component: OrgIndexPage,
});

function OrgIndexPage() {
  const params = useParams({ from: "/_auth-required.layout/_/orgs/$organizationSlug/" });

  const { data: projects, isLoading } = useQuery(
    trpc.instance.list.queryOptions({
      organizationSlug: params.organizationSlug,
    }),
  );

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (projects && projects.length > 0) {
    return (
      <Navigate
        to="/orgs/$organizationSlug/projects/$projectSlug"
        params={{
          organizationSlug: params.organizationSlug,
          projectSlug: projects[0].slug,
        }}
      />
    );
  }

  return (
    <Navigate
      to="/orgs/$organizationSlug/projects/new"
      params={{ organizationSlug: params.organizationSlug }}
    />
  );
}

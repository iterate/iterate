import { createFileRoute, Navigate, useParams } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { trpc } from "../../lib/trpc.ts";

export const Route = createFileRoute("/_auth-required.layout/_/orgs/$organizationSlug/")({
  component: OrgIndexPage,
});

function OrgIndexPage() {
  const params = useParams({ from: "/_auth-required.layout/_/orgs/$organizationSlug/" });

  const { data: projects } = useSuspenseQuery(
    trpc.instance.list.queryOptions({
      organizationSlug: params.organizationSlug,
    }),
  );

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

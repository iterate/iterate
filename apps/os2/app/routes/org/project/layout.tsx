import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { trpc } from "../../../lib/trpc.tsx";

export const Route = createFileRoute(
  "/_auth.layout/orgs/$organizationSlug/projects/$projectSlug",
)({
  component: ProjectLayout,
});

function ProjectLayout() {
  const params = useParams({
    from: "/_auth.layout/orgs/$organizationSlug/projects/$projectSlug",
  });

  useSuspenseQuery(
    trpc.project.bySlug.queryOptions({
      organizationSlug: params.organizationSlug,
      projectSlug: params.projectSlug,
    }),
  );

  return <Outlet />;
}

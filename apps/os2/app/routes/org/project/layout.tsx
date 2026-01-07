import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { orpc } from "../../../lib/orpc.tsx";

export const Route = createFileRoute(
  "/_auth-required/_/orgs/$organizationSlug/_/projects/$projectSlug",
)({
  component: ProjectLayout,
});

function ProjectLayout() {
  const params = useParams({
    from: "/_auth-required.layout/_/orgs/$organizationSlug/_/projects/$projectSlug",
  });

  useSuspenseQuery(
    orpc.project.bySlug.queryOptions({
      input: {
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
      },
    }),
  );

  return <Outlet />;
}

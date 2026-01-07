import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { trpc } from "../../../lib/trpc.ts";

export const Route = createFileRoute(
  "/_auth-required.layout/_/orgs/$organizationSlug/_/projects/$projectSlug",
)({
  component: ProjectLayout,
});

function ProjectLayout() {
  const params = useParams({
    from: "/_auth-required.layout/_/orgs/$organizationSlug/_/projects/$projectSlug",
  });

  const { data: project } = useSuspenseQuery(
    trpc.instance.bySlug.queryOptions({
      organizationSlug: params.organizationSlug,
      instanceSlug: params.projectSlug,
    }),
  );

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">Project not found</div>
      </div>
    );
  }

  return <Outlet />;
}

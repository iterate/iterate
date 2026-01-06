import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { trpc } from "../../../lib/trpc.ts";

export const Route = createFileRoute("/_auth-required.layout/_/$organizationSlug/_/$projectSlug")({
  component: ProjectLayout,
});

function ProjectLayout() {
  const params = useParams({ from: "/_auth-required.layout/_/$organizationSlug/_/$projectSlug" });

  const { data: project, isLoading } = useQuery(
    trpc.instance.bySlug.queryOptions({
      organizationSlug: params.organizationSlug,
      instanceSlug: params.projectSlug,
    }),
  );

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">Project not found</div>
      </div>
    );
  }

  return <Outlet />;
}

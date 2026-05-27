import { Outlet, createFileRoute } from "@tanstack/react-router";
import { orpc } from "~/orpc/client.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug")({
  loader: async ({ context, params }) => {
    const project = await context.queryClient.ensureQueryData({
      ...orpc.projects.findBySlug.queryOptions({ input: { slug: params.projectSlug } }),
      staleTime: 30_000,
    });

    return {
      breadcrumb: project.slug,
    };
  },
  component: ProjectLayout,
});

function ProjectLayout() {
  return <Outlet />;
}

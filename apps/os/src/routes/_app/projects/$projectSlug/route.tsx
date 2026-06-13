import { Outlet, createFileRoute } from "@tanstack/react-router";
import { getProjectBySlugServerFn } from "~/lib/project-server-fns.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug")({
  beforeLoad: async ({ params }) => ({
    project: await getProjectBySlugServerFn({ data: { slug: params.projectSlug } }),
  }),
  loader: ({ context }) => {
    return {
      breadcrumb: context.project.slug,
    };
  },
  component: ProjectLayout,
});

function ProjectLayout() {
  return <Outlet />;
}

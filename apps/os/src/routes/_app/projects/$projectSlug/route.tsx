import { Outlet, createFileRoute } from "@tanstack/react-router";
import { ensureProjectBySlug } from "~/lib/project-route-query.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug")({
  beforeLoad: async ({ context, params }) => ({
    project: await ensureProjectBySlug({
      queryClient: context.queryClient,
      projectSlug: params.projectSlug,
    }),
  }),
  loader: ({ context }) => {
    return {
      breadcrumb: context.project.slug,
    };
  },
  component: () => <Outlet />,
});

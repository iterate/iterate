import { createFileRoute, redirect } from "@tanstack/react-router";
import { trpc } from "../../lib/trpc.tsx";

export const Route = createFileRoute("/_auth.layout/orgs/$organizationSlug/")({
  beforeLoad: async ({ context, params }) => {
    const projects = await context.queryClient.ensureQueryData(
      trpc.project.list.queryOptions({
        organizationSlug: params.organizationSlug,
      }),
    );

    if (projects && projects.length > 0) {
      throw redirect({
        to: "/orgs/$organizationSlug/projects/$projectSlug",
        params: {
          organizationSlug: params.organizationSlug,
          projectSlug: projects[0].slug,
        },
      });
    }

    throw redirect({
      to: "/orgs/$organizationSlug/projects/new",
      params: { organizationSlug: params.organizationSlug },
    });
  },
  component: OrgIndexPage,
});

function OrgIndexPage() {
  return null;
}

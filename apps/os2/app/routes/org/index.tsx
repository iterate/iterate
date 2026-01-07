import { createFileRoute, redirect } from "@tanstack/react-router";
import { orpc } from "../../lib/orpc.tsx";
import { assertOrganizationParams } from "../../lib/route-params.ts";

type Project = { id: string; name: string; slug: string };

export const Route = createFileRoute("/_auth-required/_/orgs/$organizationSlug/")({
  beforeLoad: async ({ context, params }) => {
    const { organizationSlug } = assertOrganizationParams(params);
    const projects = (await context.queryClient.ensureQueryData(
      orpc.project.list.queryOptions({
        input: { organizationSlug },
      }),
    )) as Project[];

    if (projects && projects.length > 0) {
      throw redirect({
        to: "/orgs/$organizationSlug/projects/$projectSlug",
        params: {
          organizationSlug,
          projectSlug: projects[0].slug,
        },
      });
    }

    throw redirect({
      to: "/orgs/$organizationSlug/projects/new",
      params: { organizationSlug },
    });
  },
  component: OrgIndexPage,
});

function OrgIndexPage() {
  return null;
}

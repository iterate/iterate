import { createFileRoute, redirect } from "@tanstack/react-router";
import { trpc } from "../lib/trpc.tsx";

export const Route = createFileRoute("/_auth.layout/")({
  beforeLoad: async ({ context }) => {
    const organizations = await context.queryClient.ensureQueryData(
      trpc.user.myOrganizations.queryOptions(),
    );

    if (!organizations || organizations.length === 0) {
      throw redirect({ to: "/new-organization" });
    }

    const orgWithProjects = organizations.find(
      (organization) => (organization.projects || []).length > 0,
    );

    if (orgWithProjects) {
      const firstProject = orgWithProjects.projects?.[0];
      if (firstProject) {
        throw redirect({
          to: "/orgs/$organizationSlug/projects/$projectSlug",
          params: {
            organizationSlug: orgWithProjects.slug,
            projectSlug: firstProject.slug,
          },
        });
      }
    }

    throw redirect({
      to: "/orgs/$organizationSlug/projects/new",
      params: { organizationSlug: organizations[0].slug },
    });
  },
  component: IndexPage,
});

function IndexPage() {
  return null;
}

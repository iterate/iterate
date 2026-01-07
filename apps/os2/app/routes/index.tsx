import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "../lib/auth-middleware.ts";

const getHomeRedirect = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const organizations = await context.variables.trpcCaller.user.myOrganizations();

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
  });

export const Route = createFileRoute("/_auth.layout/")({
  beforeLoad: () => getHomeRedirect(),
  component: IndexPage,
});

function IndexPage() {
  return null;
}

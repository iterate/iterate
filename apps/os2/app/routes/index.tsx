import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth.layout/")({
  beforeLoad: async ({ context }) => {
    const organizations = await context.trpcClient.user.getOrganizations.query();

    if (organizations.length === 0) {
      throw redirect({ to: "/new-organization" });
    }

    const firstOrg = organizations[0];
    const firstInstance = firstOrg.instances[0];

    if (firstInstance) {
      throw redirect({
        to: "/$organizationSlug/$instanceSlug",
        params: { organizationSlug: firstOrg.slug, instanceSlug: firstInstance.slug },
      });
    }

    throw redirect({
      to: "/$organizationSlug",
      params: { organizationSlug: firstOrg.slug },
    });
  },
  component: () => null,
});

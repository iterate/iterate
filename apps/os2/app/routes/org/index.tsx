import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth.layout/orgs/$organizationSlug/")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/orgs/$organizationSlug/settings",
      params: { organizationSlug: params.organizationSlug },
    });
  },
});

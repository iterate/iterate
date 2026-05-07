import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/orgs/$organizationSlug/")({
  loader: ({ params }) => {
    throw redirect({
      to: "/orgs/$organizationSlug/projects",
      params,
      replace: true,
    });
  },
});

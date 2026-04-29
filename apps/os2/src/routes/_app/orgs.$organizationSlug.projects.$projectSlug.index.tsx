import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/orgs/$organizationSlug/projects/$projectSlug/")({
  loader: ({ params }) => {
    throw redirect({
      to: "/orgs/$organizationSlug/projects/$projectSlug/run-code",
      params,
      replace: true,
    });
  },
});

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/orgs/$organizationSlug/projects/$projectSlug/run-code")(
  {
    loader: ({ params }) => {
      throw redirect({
        to: "/orgs/$organizationSlug/projects/$projectSlug/codemode-sessions/new",
        params,
        replace: true,
      });
    },
  },
);

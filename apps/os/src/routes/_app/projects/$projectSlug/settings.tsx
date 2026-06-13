import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/projects/$projectSlug/settings")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/projects/$projectSlug",
      params,
      replace: true,
    });
  },
});

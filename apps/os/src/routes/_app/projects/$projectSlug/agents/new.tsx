import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Legacy URL: new-agent composition lives on the project dashboard (home).
 * Keep this path so old bookmarks resolve cleanly.
 */
export const Route = createFileRoute("/_app/projects/$projectSlug/agents/new")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/projects/$projectSlug",
      params,
      search: {},
      replace: true,
    });
  },
});

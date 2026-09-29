import { createFileRoute, redirect } from "@tanstack/react-router";

/** A project's docs open on its config repo, which every project has; the sidebar picks another. */
export const Route = createFileRoute("/_auth/projects/$slug/")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/projects/$slug/$repo", params: { slug: params.slug, repo: "config" } });
  },
});

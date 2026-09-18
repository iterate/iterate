// /projects/<slug> — the project layout: the project resolved from the session's list by its slug
// (its id works too; one the session does not reach is not found), handed to every section below.
import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth/projects/$slug")({
  beforeLoad: async ({ context, params }) => {
    const projects = await context.api.projects.list();
    const project = projects.find(
      (candidate) => candidate.slug === params.slug || candidate.id === params.slug,
    );
    if (!project) throw notFound();
    return { project };
  },
  component: Outlet,
});

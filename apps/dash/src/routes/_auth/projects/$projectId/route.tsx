// /projects/<project> — the project layout: the project resolved from the session's list (a name
// the session does not reach is not found), handed to every section below it.
import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth/projects/$projectId")({
  beforeLoad: async ({ context, params }) => {
    const projects = await context.api.projects.list();
    const project = projects.find((candidate) => candidate.id === params.projectId);
    if (!project) throw notFound();
    return { project };
  },
  component: Outlet,
});

import { createFileRoute, redirect } from "@tanstack/react-router";
import { requireAuthenticatedRootRedirectTargetFromSession } from "../lib/auth.ts";
import { listMyProjectsServerFn } from "~/lib/project-server-fns.ts";

export const Route = createFileRoute("/")({
  loader: async ({ context, location }) => {
    const target = requireAuthenticatedRootRedirectTargetFromSession(
      context.authSession,
      location,
      context.iterateAuthIssuer,
      context.currentProjectHostSlug,
    );

    // The my-projects list is claims-sourced (the auth worker knows which
    // projects the caller may access) with a per-project engine-existence
    // probe. During preview/dev testing we often reset only the engine,
    // leaving auth's database intact — those projects come back as
    // `deploymentStatus: "missing"` and the `/projects` page offers a
    // one-click set-up.
    //
    // Root redirect must make a different decision: only projects that
    // actually exist in this deployment are valid redirect targets. If auth
    // knows about ten projects but this engine has only one of them, `/`
    // should go to that one project, not stay on the picker.
    const projectsData = await listMyProjectsServerFn({ data: { limit: 100, offset: 0 } });
    const projects = projectsData.projects.filter(
      (project) => project.deploymentStatus === "ready",
    );

    const project =
      projects.find((candidate) => candidate.slug === target.projectSlug) ??
      (projects.length === 1 ? projects[0] : null);

    if (project) {
      throw redirect({
        to: "/projects/$projectSlug",
        params: { projectSlug: project.slug },
        replace: true,
      });
    }

    throw redirect({
      to: "/projects",
      replace: true,
    });
  },
  component: () => null,
});

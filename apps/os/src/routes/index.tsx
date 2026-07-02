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

    // `projects.list` is intentionally a merge of auth-session projects and
    // OS D1 rows. During preview/dev testing we often reset only the OS worker
    // database, leaving auth's database intact. Those auth-only projects are
    // returned as `isOrphanedProjectFromAuthService` so the `/projects` page can
    // offer a one-click OS re-adoption form.
    //
    // Root redirect must make a different decision: only projects that already
    // exist in OS are valid redirect targets. If auth knows about ten projects
    // but OS has recreated only one of them, `/` should go to that one OS
    // project, not stay on the project picker because of auth-only claims.
    const projectsData = await listMyProjectsServerFn({ data: { limit: 100, offset: 0 } });
    const projects = projectsData.projects.filter(
      (project) => !project.isOrphanedProjectFromAuthService,
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

import { createFileRoute, redirect } from "@tanstack/react-router";
import { requireAuthenticatedRootRedirectTargetFromSession } from "../lib/auth.ts";
import { projectsListQueryOptions } from "~/lib/project-route-query.ts";

export const Route = createFileRoute("/")({
  loader: async ({ context, location }) => {
    const target = requireAuthenticatedRootRedirectTargetFromSession(
      context.authSession,
      location,
      context.iterateAuthIssuer,
      context.currentProjectHostSlug,
    );

    if (target.projectSlug) {
      throw redirect({
        to: "/projects/$projectSlug",
        params: { projectSlug: target.projectSlug },
        replace: true,
      });
    }

    const projectsData = await context.queryClient.ensureQueryData(
      projectsListQueryOptions({ limit: 100, offset: 0 }),
    );
    const projects = projectsData.projects.filter(
      (project) => !project.isOrphanedProjectFromAuthService,
    );

    if (projects.length === 1) {
      throw redirect({
        to: "/projects/$projectSlug",
        params: { projectSlug: projects[0]!.slug },
        replace: true,
      });
    }

    throw redirect({
      to: "/projects",
      replace: true,
    });
  },
});

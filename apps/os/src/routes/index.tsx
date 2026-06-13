import { createFileRoute, redirect } from "@tanstack/react-router";
import { requireAuthenticatedRootRedirectTargetFromSession } from "../lib/auth.ts";
import { DocsHomePage } from "~/components/docs-portal.tsx";
import { listMyProjectsServerFn } from "~/lib/project-server-fns.ts";

export const Route = createFileRoute("/")({
  loader: async ({ context, location }) => {
    if (context.isEventDocsHost) return;

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

    const projectsData = await listMyProjectsServerFn({ data: { limit: 100, offset: 0 } });
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
  component: DocsHomePage,
});

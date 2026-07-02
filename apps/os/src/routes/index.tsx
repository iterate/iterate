import { createFileRoute, redirect } from "@tanstack/react-router";
import { requireAuthenticatedRootRedirectTargetFromSession } from "../lib/auth.ts";
import { listReadyProjectsServerFn } from "~/lib/project-server-fns.ts";

export const Route = createFileRoute("/")({
  loader: async ({ context, location }) => {
    const target = requireAuthenticatedRootRedirectTargetFromSession(
      context.authSession,
      location,
      context.iterateAuthIssuer,
      context.currentProjectHostSlug,
    );

    // `session.projects.list()` includes projects the auth worker knows about
    // but this deployment's engine does not (`deploymentStatus: "missing"` —
    // e.g. after an engine-only reset; the `/projects` page offers a one-click
    // set-up for those).
    //
    // Root redirect must make a different decision: only projects that
    // actually exist in this deployment are valid redirect targets. If auth
    // knows about ten projects but this engine has only one of them, `/`
    // should go to that one project, not stay on the picker.
    const projects = await listReadyProjectsServerFn();

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
